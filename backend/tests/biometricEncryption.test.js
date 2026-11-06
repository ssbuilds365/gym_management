const test = require('node:test');
const assert = require('node:assert/strict');
const BiometricEnrollment = require('../models/BiometricEnrollment');
const { encryptTemplate, decryptTemplate } = require('../utils/biometricEncryption');
const { toMinorUnits, fromMinorUnits } = require('../utils/currency');

test('fingerprint templates encrypt and decrypt with the configured external key', () => {
  const priorKey = process.env.BIOMETRIC_ENCRYPTION_KEY;
  const priorVersion = process.env.BIOMETRIC_ENCRYPTION_KEY_VERSION;
  process.env.BIOMETRIC_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.BIOMETRIC_ENCRYPTION_KEY_VERSION = 'test-key';

  try {
    const template = Buffer.from([0, 9, 18, 27, 36]);
    const encrypted = encryptTemplate(template);

    assert.equal(encrypted.keyVersion, 'test-key');
    assert.notEqual(encrypted.ciphertext, template.toString('base64'));
    assert.deepEqual(decryptTemplate(encrypted), template);

    process.env.BIOMETRIC_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
    assert.throws(() => decryptTemplate(encrypted));
  } finally {
    if (priorKey === undefined) delete process.env.BIOMETRIC_ENCRYPTION_KEY;
    else process.env.BIOMETRIC_ENCRYPTION_KEY = priorKey;
    if (priorVersion === undefined) delete process.env.BIOMETRIC_ENCRYPTION_KEY_VERSION;
    else process.env.BIOMETRIC_ENCRYPTION_KEY_VERSION = priorVersion;
  }
});

test('biometric enrollment stores encrypted template fields as non-selectable values', () => {
  assert.equal(
    BiometricEnrollment.schema.path('encryptedTemplate.ciphertext').options.select,
    false
  );
  assert.equal(
    BiometricEnrollment.schema.path('encryptedTemplate.iv').options.select,
    false
  );
  assert.equal(
    BiometricEnrollment.schema.path('encryptedTemplate.authTag').options.select,
    false
  );
  assert.equal(BiometricEnrollment.schema.path('consentAt').isRequired, true);
});

test('currency values use exact minor units and reject extra decimal places', () => {
  assert.equal(toMinorUnits(0.1 + 0.2), 30);
  assert.equal(toMinorUnits('12.34'), 1234);
  assert.equal(toMinorUnits('1.005'), null);
  assert.equal(fromMinorUnits(1234), 12.34);
});
