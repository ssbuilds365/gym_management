const KIOSK_REFRESH_COOKIE_NAME = 'ssfm_kiosk_refresh';
const KIOSK_REFRESH_COOKIE_PATH = '/api/kiosk';
const KIOSK_REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const kioskRefreshCookieOptions = nodeEnv => ({
  httpOnly: true,
  secure: nodeEnv === 'production',
  sameSite: 'lax',
  path: KIOSK_REFRESH_COOKIE_PATH,
  maxAge: KIOSK_REFRESH_MAX_AGE_MS
});

const clearKioskRefreshCookie = (res, nodeEnv) => {
  const { maxAge, ...options } = kioskRefreshCookieOptions(nodeEnv);
  res.clearCookie(KIOSK_REFRESH_COOKIE_NAME, options);
};

const getKioskRefreshToken = req => {
  const cookieHeader = req.headers?.cookie;
  if (typeof cookieHeader !== 'string') return '';
  const cookie = cookieHeader.split(';').map(value => value.trim())
    .find(value => value.startsWith(`${KIOSK_REFRESH_COOKIE_NAME}=`));
  if (!cookie) return '';
  try {
    return decodeURIComponent(cookie.slice(KIOSK_REFRESH_COOKIE_NAME.length + 1));
  } catch {
    return '';
  }
};

const isTrustedKioskCookieRequest = (req, allowedOrigins) => {
  const origin = String(req.headers?.origin || '');
  const requestMarker = String(req.headers?.['x-kiosk-request'] || '');
  return requestMarker === '1' && allowedOrigins.includes(origin);
};

module.exports = {
  KIOSK_REFRESH_COOKIE_NAME,
  KIOSK_REFRESH_COOKIE_PATH,
  KIOSK_REFRESH_MAX_AGE_MS,
  kioskRefreshCookieOptions,
  clearKioskRefreshCookie,
  getKioskRefreshToken,
  isTrustedKioskCookieRequest
};
