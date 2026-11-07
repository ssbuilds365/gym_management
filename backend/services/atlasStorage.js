const crypto = require('node:crypto');
const config = require('../config/env');

const API_BASE_URL = 'https://cloud.mongodb.com/api/atlas/v2';
const API_ACCEPT = 'application/vnd.atlas.2023-01-01+json';
const REQUEST_TIMEOUT_MS = 8_000;

const digestParameters = (header) => {
  const challenge = header.match(/^Digest\s+(.+)$/i);
  if (!challenge) return null;

  const parameters = {};
  const expression = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let match;
  while ((match = expression.exec(challenge[1]))) {
    parameters[match[1]] = match[2] ?? match[3];
  }
  return parameters;
};

const md5 = value => crypto.createHash('md5').update(value).digest('hex');

const createDigestAuthorization = (challenge, method, uri, publicKey, privateKey) => {
  const parameters = digestParameters(challenge);
  if (!parameters?.realm || !parameters.nonce) {
    throw new Error('Atlas API returned an unsupported authentication challenge');
  }

  const qop = String(parameters.qop || 'auth').split(',').map(value => value.trim());
  if (!qop.includes('auth')) {
    throw new Error('Atlas API requested an unsupported digest quality of protection');
  }

  const requestedAlgorithm = parameters.algorithm?.toUpperCase() || 'MD5';
  if (!['MD5', 'MD5-SESS'].includes(requestedAlgorithm)) {
    throw new Error('Atlas API requested an unsupported digest algorithm');
  }
  const nonceCount = '00000001';
  const clientNonce = crypto.randomBytes(16).toString('hex');
  const hashAlgorithm = requestedAlgorithm;
  let ha1 = md5(`${publicKey}:${parameters.realm}:${privateKey}`);
  if (hashAlgorithm === 'MD5-SESS') {
    ha1 = md5(`${ha1}:${parameters.nonce}:${clientNonce}`);
  }
  const ha2 = md5(`${method}:${uri}`);
  const response = md5(`${ha1}:${parameters.nonce}:${nonceCount}:${clientNonce}:auth:${ha2}`);

  return [
    `Digest username="${publicKey}"`,
    `realm="${parameters.realm}"`,
    `nonce="${parameters.nonce}"`,
    `uri="${uri}"`,
    `algorithm=${hashAlgorithm}`,
    `qop=auth`,
    `nc=${nonceCount}`,
    `cnonce="${clientNonce}"`,
    `response="${response}"`,
    parameters.opaque ? `opaque="${parameters.opaque}"` : ''
  ].filter(Boolean).join(', ');
};

const requestAtlas = async (path, fetchImpl = globalThis.fetch, atlasConfig = config.atlas) => {
  const url = new URL(path, API_BASE_URL);
  const headers = { Accept: API_ACCEPT };
  const options = {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  };
  const initialResponse = await fetchImpl(url, options);
  let response = initialResponse;

  if (response.status === 401) {
    const challenge = response.headers.get('www-authenticate');
    if (!challenge) throw new Error('Atlas API did not provide an authentication challenge');
    headers.Authorization = createDigestAuthorization(
      challenge,
      'GET',
      `${url.pathname}${url.search}`,
      atlasConfig.publicKey,
      atlasConfig.privateKey
    );
    response = await fetchImpl(url, options);
  }

  if (!response.ok) {
    const error = new Error(`Atlas API returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
};

const latestMetricValue = (measurement) => {
  if (!measurement || !Array.isArray(measurement.dataPoints)) return null;
  const validPoints = measurement.dataPoints
    .filter(point => Number.isFinite(point.value) && point.timestamp)
    .sort((left, right) => new Date(right.timestamp) - new Date(left.timestamp));
  if (!validPoints.length) return null;

  const units = String(measurement.units || '').toUpperCase();
  const value = validPoints[0].value;
  if (units === 'BYTES' || units === 'BYTE') return value;
  if (units === 'GIGABYTES' || units === 'GIGABYTE' || units === 'GB') {
    return value * (1024 ** 3);
  }
  return null;
};

const getAtlasStorage = async ({ atlasConfig = config.atlas, fetchImpl = globalThis.fetch } = {}) => {
  const credentialsConfigured = Boolean(
    atlasConfig.publicKey
    && atlasConfig.privateKey
    && atlasConfig.projectId
    && atlasConfig.clusterName
  );
  if (!credentialsConfigured) {
    return {
      configured: false,
      available: false,
      reason: 'Atlas Administration API credentials are not configured.',
      measuredAt: null,
      clusterName: null,
      clusterTier: null,
      clusterType: null,
      usedBytes: null,
      freeBytes: null,
      capacityBytes: null,
      utilizationPercent: null
    };
  }

  const encodedClusterName = encodeURIComponent(atlasConfig.clusterName);
  const encodedProjectId = encodeURIComponent(atlasConfig.projectId);
  try {
    const [cluster, measurementResponse] = await Promise.all([
      requestAtlas(`/groups/${encodedProjectId}/clusters/${encodedClusterName}`, fetchImpl, atlasConfig),
      requestAtlas(
        `/groups/${encodedProjectId}/clusters/${encodedClusterName}/measurements`
        + '?granularity=PT1M&period=PT1H'
        + '&m=DISK_PARTITION_SPACE_USED'
        + '&m=DISK_PARTITION_SPACE_FREE',
        fetchImpl,
        atlasConfig
      )
    ]);

    const measurements = Array.isArray(measurementResponse.measurements)
      ? measurementResponse.measurements
      : [];
    const usedBytes = latestMetricValue(measurements.find(
      measurement => measurement.name === 'DISK_PARTITION_SPACE_USED'
    ));
    const freeBytes = latestMetricValue(measurements.find(
      measurement => measurement.name === 'DISK_PARTITION_SPACE_FREE'
    ));
    const points = measurements.flatMap(measurement =>
      Array.isArray(measurement.dataPoints) ? measurement.dataPoints : []
    );
    const measuredAt = points
      .filter(point => point.timestamp && Number.isFinite(point.value))
      .map(point => new Date(point.timestamp))
      .filter(date => !Number.isNaN(date.getTime()))
      .sort((left, right) => right - left)[0] || null;

    const diskSizeGB = Number(cluster.diskSizeGB);
    const capacityBytes = cluster.clusterType === 'REPLICASET'
      && Number.isFinite(diskSizeGB) && diskSizeGB > 0
      ? diskSizeGB * (1024 ** 3)
      : null;
    const available = usedBytes !== null && freeBytes !== null && capacityBytes !== null
      && usedBytes >= 0 && freeBytes >= 0 && usedBytes <= capacityBytes;

    return {
      configured: true,
      available,
      reason: available
        ? null
        : 'Atlas did not return all required disk metrics and configured cluster capacity.',
      measuredAt: measuredAt ? measuredAt.toISOString() : null,
      clusterName: cluster.name || null,
      clusterTier: cluster.providerSettings?.instanceSizeName || null,
      clusterType: cluster.clusterType || null,
      usedBytes,
      freeBytes,
      capacityBytes,
      utilizationPercent: available && capacityBytes > 0
        ? Math.min(100, Math.max(0, (usedBytes / capacityBytes) * 100))
        : null
    };
  } catch (error) {
    console.error('Atlas storage metrics request failed:', error.status || error.name || 'AtlasError');
    return {
      configured: true,
      available: false,
      reason: 'Atlas storage metrics are temporarily unavailable.',
      measuredAt: null,
      clusterName: null,
      clusterTier: null,
      clusterType: null,
      usedBytes: null,
      freeBytes: null,
      capacityBytes: null,
      utilizationPercent: null
    };
  }
};

module.exports = {
  getAtlasStorage,
  latestMetricValue,
  createDigestAuthorization,
  requestAtlas
};
