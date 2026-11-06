const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SESSION_COOKIE_NAME,
  SESSION_IDLE_TIMEOUT_MS,
  createSessionToken,
  hashSessionToken,
  getSessionToken,
  isSessionIdle,
  cookieOptions
} = require('../utils/ownerSession');

test('session tokens are random opaque values and hashes are deterministic', () => {
  const first = createSessionToken();
  const second = createSessionToken();

  assert.notEqual(first, second);
  assert.equal(Buffer.from(first, 'base64url').length, 32);
  assert.equal(hashSessionToken(first), hashSessionToken(first));
  assert.notEqual(hashSessionToken(first), first);
});

test('session cookie parser extracts only the configured cookie', () => {
  assert.equal(
    getSessionToken(`other=value; ${SESSION_COOKIE_NAME}=opaque%2Dtoken; another=one`),
    'opaque-token'
  );
  assert.equal(getSessionToken('not_ssfm_session=value'), '');
  assert.equal(getSessionToken(`${SESSION_COOKIE_NAME}=%E0%A4%A`), '');
});

test('idle timeout expires at the configured inactivity boundary', () => {
  const now = Date.now();
  assert.equal(isSessionIdle(new Date(now - SESSION_IDLE_TIMEOUT_MS + 1), now), false);
  assert.equal(isSessionIdle(new Date(now - SESSION_IDLE_TIMEOUT_MS), now), true);
});

test('session cookies are HttpOnly and secure only in production', () => {
  const production = cookieOptions('production');
  const development = cookieOptions('development');

  assert.equal(production.httpOnly, true);
  assert.equal(production.secure, true);
  assert.equal(production.sameSite, 'lax');
  assert.equal(production.path, '/api');
  assert.equal(development.httpOnly, true);
  assert.equal(development.secure, false);
});
