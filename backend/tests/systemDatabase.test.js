const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
  getDatabaseStatus,
  getTenantCollectionDefinitions,
  buildManagementFilter,
  getDeletePreview,
  deleteSelectedRecords,
  getCollectionStats
} = require('../controllers/systemController');
const DatabaseManagementAudit = require('../models/DatabaseManagementAudit');
const {
  getAtlasStorage,
  latestMetricValue
} = require('../services/atlasStorage');

const createResponse = () => ({
  headers: {},
  statusCode: 200,
  set(name, value) {
    this.headers[name] = value;
    return this;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});

test('database explorer only registers tenant-scoped business collections', () => {
  const definitions = getTenantCollectionDefinitions();
  const modelNames = definitions.map(({ model }) => model.modelName);

  assert.ok(definitions.length > 0);
  assert.equal(new Set(definitions.map(({ model }) => model.collection.name)).size, definitions.length);
  assert.ok(definitions.every(({ model }) => model.schema.path('tenantId')));
  assert.ok(!modelNames.includes('Owner'));
  assert.ok(!modelNames.includes('OwnerSession'));
  assert.ok(!modelNames.includes('PasswordResetToken'));
  assert.ok(!modelNames.includes('OwnerSecurityAudit'));
});

test('payment and audit collections are explicitly protected from storage-page deletion', () => {
  const definitions = getTenantCollectionDefinitions();
  const protectedModels = new Set(
    definitions.filter((definition) => definition.protected).map(({ model }) => model.modelName)
  );

  assert.ok(protectedModels.has('Payment'));
  assert.ok(protectedModels.has('TrainerAssignment'));
  assert.ok(protectedModels.has('TrainerPTPackage'));
  assert.ok(protectedModels.has('TrainerPTPayment'));
  assert.ok(protectedModels.has('ExpenseAudit'));
  assert.ok(protectedModels.has('MemberDeletionAudit'));
});

test('database status pings the connection and returns no cluster credentials', async () => {
  const originalReadyState = mongoose.connection.readyState;
  const originalDb = mongoose.connection.db;

  try {
    mongoose.connection.readyState = 1;
    mongoose.connection.db = {
      admin: () => ({ ping: async () => ({ ok: 1 }) })
    };

    const response = createResponse();
    await getDatabaseStatus({}, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.connected, true);
    assert.equal(response.body.databaseErrorStatus, 'none');
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal('databaseName' in response.body, false);
    assert.equal('clusterHost' in response.body, false);
    assert.equal('mongodbUri' in response.body, false);

    mongoose.connection.readyState = 0;
    mongoose.connection.db = null;
    const disconnectedResponse = createResponse();
    await getDatabaseStatus({}, disconnectedResponse);

    assert.equal(disconnectedResponse.statusCode, 503);
    assert.equal(disconnectedResponse.body.connected, false);
    assert.equal(disconnectedResponse.body.databaseErrorStatus, 'unavailable');
  } finally {
    mongoose.connection.readyState = originalReadyState;
    mongoose.connection.db = originalDb;
  }
});

test('data management filters always use the authenticated tenant and fixed allowlist', () => {
  const tenantId = new mongoose.Types.ObjectId();
  const businessId = new mongoose.Types.ObjectId();
  const result = buildManagementFilter('expenses', tenantId, businessId, {
    status: 'PENDING',
    from: '2026-01-01',
    to: '2026-01-31',
    search: '.*',
    ids: ['aaaaaaaaaaaaaaaaaaaaaaaa']
  });

  assert.equal(result.error, undefined);
  assert.equal(String(result.filter.tenantId), String(tenantId));
  assert.equal(String(result.filter.businessId), String(businessId));
  assert.equal(result.filter.status, 'PENDING');
  assert.equal(result.filter.deletedAt, null);
  assert.equal(result.filter.expenseDate.$gte.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(result.filter.expenseDate.$lt.toISOString(), '2026-02-01T00:00:00.000Z');
  assert.equal(result.filter.$or[0].title.test('.*'), true);
  assert.equal(result.filter.$or[0].title.test('anything'), false);
  assert.ok(buildManagementFilter('Payment', tenantId, businessId, {}).error);
  assert.ok(buildManagementFilter('expenses', tenantId, businessId, {
    status: 'Success'
  }).error);
  assert.ok(buildManagementFilter('expenses', tenantId, businessId, {
    from: '2026-02-01'
  }).error);
});

test('data management date filters use the business timezone and calendar-day boundaries', () => {
  const tenantId = new mongoose.Types.ObjectId();
  const businessId = new mongoose.Types.ObjectId();
  const indiaRange = buildManagementFilter('expenses', tenantId, businessId, {
    from: '2026-01-01',
    to: '2026-01-01'
  }, 'Asia/Kolkata').filter.expenseDate;
  assert.equal(indiaRange.$gte.toISOString(), '2025-12-31T18:30:00.000Z');
  assert.equal(indiaRange.$lt.toISOString(), '2026-01-01T18:30:00.000Z');

  const daylightSavingRange = buildManagementFilter('members', tenantId, businessId, {
    from: '2026-03-08',
    to: '2026-03-08'
  }, 'America/Los_Angeles').filter.joiningDate;
  assert.equal(daylightSavingRange.$gte.toISOString(), '2026-03-08T08:00:00.000Z');
  assert.equal(daylightSavingRange.$lt.toISOString(), '2026-03-09T07:00:00.000Z');
});

test('preview and deletion reject unsupported or unconfirmed operations without database writes', async () => {
  const invalidPreview = createResponse();
  await getDeletePreview({
    body: { category: 'payments', ids: ['aaaaaaaaaaaaaaaaaaaaaaaa'] },
    tenantId: new mongoose.Types.ObjectId(),
    owner: { businessId: new mongoose.Types.ObjectId() }
  }, invalidPreview);
  assert.equal(invalidPreview.statusCode, 400);

  const unconfirmedDelete = createResponse();
  await deleteSelectedRecords({
    body: {
      category: 'members',
      ids: ['aaaaaaaaaaaaaaaaaaaaaaaa'],
      reason: 'Removal requested',
      requestId: '0123456789abcdef',
      expectedCount: 1
    },
    tenantId: new mongoose.Types.ObjectId(),
    owner: { _id: new mongoose.Types.ObjectId(), role: 'owner' }
  }, unconfirmedDelete);
  assert.equal(unconfirmedDelete.statusCode, 400);

  const arbitraryCollection = createResponse();
  await getCollectionStats({
    params: { collectionName: 'owners' },
    tenantId: new mongoose.Types.ObjectId()
  }, arbitraryCollection);
  assert.equal(arbitraryCollection.statusCode, 404);
});

test('duplicate delete request IDs are rejected before invoking a record deletion workflow', async (t) => {
  t.mock.method(DatabaseManagementAudit, 'init', async () => {});
  t.mock.method(DatabaseManagementAudit, 'findOne', () => ({
    lean: async () => ({ affectedRecordCount: 1, status: 'SUCCEEDED' })
  }));
  const response = createResponse();
  await deleteSelectedRecords({
    body: {
      category: 'members',
      ids: ['aaaaaaaaaaaaaaaaaaaaaaaa'],
      reason: 'Remove an obsolete member',
      requestId: '0123456789abcdef',
      expectedCount: 1,
      confirmationText: 'DELETE'
    },
    tenantId: new mongoose.Types.ObjectId(),
    owner: { _id: new mongoose.Types.ObjectId(), role: 'owner' }
  }, response);

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'DUPLICATE_REQUEST');
  assert.equal(response.body.deletedCount, 1);
});

test('Atlas metrics stay unavailable when credentials are missing and parse only supported units', async () => {
  const response = await getAtlasStorage({
    atlasConfig: { publicKey: '', privateKey: '', projectId: '', clusterName: '' },
    fetchImpl: async () => {
      throw new Error('Fetch must not run when credentials are missing');
    }
  });
  assert.equal(response.configured, false);
  assert.equal(response.available, false);
  assert.equal(response.usedBytes, null);
  assert.equal(response.capacityBytes, null);
  assert.equal(latestMetricValue({
    units: 'BYTES',
    dataPoints: [{ timestamp: '2026-11-07T00:00:00Z', value: 1024 }]
  }), 1024);
  assert.equal(latestMetricValue({
    units: 'SECONDS',
    dataPoints: [{ timestamp: '2026-11-07T00:00:00Z', value: 1024 }]
  }), null);
});

test('Atlas storage uses authenticated API responses and only reports actual replica-set metrics', async () => {
  const now = '2026-11-07T06:00:00.000Z';
  const used = 20 * (1024 ** 3);
  const free = 80 * (1024 ** 3);
  const fetchCalls = [];
  const atlasConfig = {
    publicKey: 'public-key',
    privateKey: 'private-key',
    projectId: '0123456789abcdef01234567',
    clusterName: 'Production Cluster'
  };
  const fetchImpl = async (url, options) => {
    fetchCalls.push({ url: String(url), options });
    if (!options.headers.Authorization) {
      return new Response('', {
        status: 401,
        headers: {
          'www-authenticate': 'Digest realm="Atlas", nonce="nonce-value", qop="auth", opaque="opaque-value"'
        }
      });
    }
    if (String(url).includes('/measurements')) {
      return Response.json({
        measurements: [
          { name: 'DISK_PARTITION_SPACE_USED', units: 'BYTES', dataPoints: [{ timestamp: now, value: used }] },
          { name: 'DISK_PARTITION_SPACE_FREE', units: 'BYTES', dataPoints: [{ timestamp: now, value: free }] }
        ]
      });
    }
    return Response.json({
      name: 'Production Cluster',
      clusterType: 'REPLICASET',
      diskSizeGB: 100,
      providerSettings: { instanceSizeName: 'M40' }
    });
  };

  const result = await getAtlasStorage({ atlasConfig, fetchImpl });
  assert.equal(result.available, true);
  assert.equal(result.usedBytes, used);
  assert.equal(result.freeBytes, free);
  assert.equal(result.capacityBytes, 100 * (1024 ** 3));
  assert.equal(result.utilizationPercent, 20);
  assert.equal(result.clusterName, 'Production Cluster');
  assert.equal(result.clusterTier, 'M40');
  assert.equal(result.measuredAt, now);
  assert.ok(fetchCalls.some(call => call.options.headers.Authorization?.startsWith('Digest ')));

  const shardedResult = await getAtlasStorage({
    atlasConfig,
    fetchImpl: async (url, options) => {
      if (!options.headers.Authorization) {
        return new Response('', {
          status: 401,
          headers: { 'www-authenticate': 'Digest realm="Atlas", nonce="nonce", qop="auth"' }
        });
      }
      return String(url).includes('/measurements')
        ? Response.json({ measurements: [] })
        : Response.json({ clusterType: 'SHARDED', diskSizeGB: 100 });
    }
  });
  assert.equal(shardedResult.capacityBytes, null);
  assert.equal(shardedResult.utilizationPercent, null);
});
