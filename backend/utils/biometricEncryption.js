const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';

const getKey = () => {
  const encodedKey = process.env.BIOMETRIC_ENCRYPTION_KEY;

  if (!encodedKey) {
    throw new Error('BIOMETRIC_ENCRYPTION_KEY is not configured');
  }

  const key = Buffer.from(encodedKey, 'base64');

  if (key.length !== 32) {
    throw new Error('BIOMETRIC_ENCRYPTION_KEY must decode to 32 bytes');
  }

  return key;
};

exports.encryptTemplate = (template) => {
  if (!Buffer.isBuffer(template) || template.length === 0) {
    throw new TypeError('A non-empty fingerprint template buffer is required');
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(template),
    cipher.final()
  ]);

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: process.env.BIOMETRIC_ENCRYPTION_KEY_VERSION || '1'
  };
};

exports.decryptTemplate = (encrypted) => {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(encrypted.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final()
  ]);
};
