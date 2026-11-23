const crypto = require('node:crypto');
const config = require('../config/env');

const keyVersion = config.biometricKeyVersion;

function getKey() {
  const encoded = config.biometricTemplateKey;
  if (!config.biometricTemplateKeyConfigured) {
    throw new Error('BIOMETRIC_TEMPLATE_KEY must be configured as a base64-encoded 32-byte key');
  }
  const key = Buffer.from(encoded, 'base64');
  return key;
}

function encryptTemplate(template) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(template), 'utf8'),
    cipher.final()
  ]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion
  };
}

function decryptTemplate(encrypted) {
  const key = getKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(encrypted.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

module.exports = { encryptTemplate, decryptTemplate, keyVersion };
