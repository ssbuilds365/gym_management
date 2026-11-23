const crypto = require('node:crypto');

const KEY_LENGTH = 64;

const hashKioskSecret = secret => {
  const salt = crypto.randomBytes(16).toString('base64url');
  const derived = crypto.scryptSync(secret, salt, KEY_LENGTH).toString('base64url');
  return `scrypt$${salt}$${derived}`;
};

const verifyKioskSecret = (secret, stored) => {
  if (typeof stored !== 'string') return false;
  if (stored.startsWith('scrypt$')) {
    const [, salt, expected] = stored.split('$');
    if (
      !salt ||
      !/^[A-Za-z0-9_-]+$/.test(salt) ||
      !expected ||
      expected.length !== 86 ||
      !/^[A-Za-z0-9_-]+$/.test(expected)
    ) return false;
    const actualBuffer = Buffer.from(
      crypto.scryptSync(secret, salt, KEY_LENGTH).toString('base64url')
    );
    const expectedBuffer = Buffer.from(expected);
    return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  }

  if (!/^[a-f\d]{64}$/i.test(stored)) return false;
  const supplied = crypto.createHash('sha256').update(secret).digest();
  const expected = Buffer.from(stored, 'hex');
  return crypto.timingSafeEqual(supplied, expected);
};

module.exports = { hashKioskSecret, verifyKioskSecret };
