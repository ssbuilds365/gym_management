const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/ssfm-kiosk-enrollment-tests';
process.env.KIOSK_TOKEN_SECRET = crypto.randomBytes(32).toString('hex');
process.env.BIOMETRIC_TEMPLATE_KEY = crypto.randomBytes(32).toString('base64');

const Member = require('../models/Member');
const BiometricCredential = require('../models/BiometricCredential');
const { KIOSK_TOKEN_SECRET } = require('../middleware/kioskAuthMiddleware');
const { enrollMemberFace } = require('../controllers/kioskController');
const { decryptTemplate } = require('../utils/biometricTemplateEncryption');

const tenantId = '507f1f77bcf86cd799439012';
const businessId = '507f1f77bcf86cd799439013';
const memberId = '507f1f77bcf86cd799439011';
const descriptor = Array.from({ length: 128 }, (_, index) => index / 256);

const makeResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});

const makeRequest = () => ({
  body: {
    descriptor,
    consentGranted: true,
    enrollmentToken: jwt.sign({
      purpose: 'face-enrollment',
      tenantId,
      businessId,
      credentialId: 'kiosk_test',
      memberId
    }, KIOSK_TOKEN_SECRET, {
      expiresIn: '5m',
      issuer: 'ss-fitness-manager'
    })
  },
  kiosk: { tenantId, businessId, credentialId: 'kiosk_test', createdBy: null }
});

const mockLookups = t => {
  const originalMemberFindOne = Member.findOne;
  const originalCredentialFindOne = BiometricCredential.findOne;
  Member.findOne = () => ({ select: async () => ({ _id: memberId }) });
  BiometricCredential.findOne = () => ({ select: async () => null });
  t.after(() => {
    Member.findOne = originalMemberFindOne;
    BiometricCredential.findOne = originalCredentialFindOne;
  });
};

test('kiosk enrollment persists an encrypted template for the token-scoped member', async t => {
  mockLookups(t);
  const originalCreate = BiometricCredential.create;
  let saved;
  BiometricCredential.create = async document => {
    saved = document;
    return { _id: '507f1f77bcf86cd799439099', ...document };
  };
  t.after(() => { BiometricCredential.create = originalCreate; });

  const res = makeResponse();
  await enrollMemberFace(makeRequest(), res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.code, 'FACE_REGISTERED');
  assert.equal(saved.tenantId, tenantId);
  assert.equal(saved.businessId, businessId);
  assert.equal(saved.memberId, memberId);
  assert.equal(saved.consentStatus, 'Granted');
  assert.equal(Object.hasOwn(saved.encryptedTemplate, 'descriptor'), false);
  assert.deepEqual(decryptTemplate(saved.encryptedTemplate).descriptor, descriptor);
});

test('kiosk enrollment reports a concurrent duplicate without returning a generic save error', async t => {
  mockLookups(t);
  const originalCreate = BiometricCredential.create;
  const originalConsoleError = console.error;
  BiometricCredential.create = async () => {
    const error = new Error('duplicate key');
    error.code = 11000;
    throw error;
  };
  console.error = () => {};
  t.after(() => {
    BiometricCredential.create = originalCreate;
    console.error = originalConsoleError;
  });

  const res = makeResponse();
  await enrollMemberFace(makeRequest(), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'FACE_ALREADY_REGISTERED');
  assert.equal(res.body.success, false);
});

