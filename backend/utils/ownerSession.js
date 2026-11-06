const crypto = require('node:crypto');

const SESSION_COOKIE_NAME = 'ssfm_session';
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_WARNING_MS = 5 * 60 * 1000;
const TOKEN_ROTATION_GRACE_MS = 30 * 1000;

const createSessionToken = () => crypto.randomBytes(32).toString('base64url');
const hashSessionToken = token =>
  crypto.createHash('sha256').update(token).digest('hex');

const getSessionToken = cookieHeader => {
  if (typeof cookieHeader !== 'string') return '';
  const cookie = cookieHeader.split(';').map(value => value.trim())
    .find(value => value.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!cookie) return '';
  try {
    return decodeURIComponent(cookie.slice(SESSION_COOKIE_NAME.length + 1));
  } catch {
    return '';
  }
};

const getDeviceLabel = userAgent => {
  const ua = String(userAgent || '');
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\//.test(ua) ? 'Firefox'
      : /Chrome\//.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) && !/Chrome\//.test(ua) ? 'Safari'
          : 'Unknown browser';
  const platform = /Windows/i.test(ua) ? 'Windows'
    : /Mac OS/i.test(ua) ? 'macOS'
      : /Android/i.test(ua) ? 'Android'
        : /iPhone|iPad/i.test(ua) ? 'iOS'
          : /Linux/i.test(ua) ? 'Linux'
            : 'Unknown device';
  return `${browser} · ${platform}`;
};

const isSessionIdle = (lastActivityAt, now = Date.now()) =>
  now - new Date(lastActivityAt).getTime() >= SESSION_IDLE_TIMEOUT_MS;

const cookieOptions = nodeEnv => ({
  httpOnly: true,
  secure: nodeEnv === 'production',
  sameSite: 'lax',
  path: '/api',
  maxAge: SESSION_MAX_AGE_MS
});

module.exports = {
  SESSION_COOKIE_NAME,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_MAX_AGE_MS,
  SESSION_WARNING_MS,
  TOKEN_ROTATION_GRACE_MS,
  createSessionToken,
  hashSessionToken,
  getSessionToken,
  getDeviceLabel,
  isSessionIdle,
  cookieOptions
};
