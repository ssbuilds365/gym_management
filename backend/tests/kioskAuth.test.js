const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/ssfm-kiosk-tests';
process.env.KIOSK_TOKEN_SECRET = crypto.randomBytes(32).toString('base64url');
process.env.BIOMETRIC_TEMPLATE_KEY = crypto.randomBytes(32).toString('base64');

const KioskCredential = require('../models/KioskCredential');
const Business = require('../models/Business');
const Attendance = require('../models/Attendance');
const config = require('../config/env');
const { authenticateKiosk, faceCheckIn } = require('../controllers/kioskController');
const { createKioskCredential } = require('../controllers/biometricController');
const { protectKiosk } = require('../middleware/kioskAuthMiddleware');
const {
  hashKioskSecret,
  verifyKioskSecret
} = require('../utils/kioskCredentialSecret');
const { getEnvironmentValue } = require('../utils/environmentValue');
const { decryptTemplate, encryptTemplate } = require('../utils/biometricTemplateEncryption');

test('non-empty inherited environment values win while empty values fall back to dotenv', () => {
  assert.equal(getEnvironmentValue('KIOSK_TOKEN_SECRET', {
    KIOSK_TOKEN_SECRET: ''
  }, {
    KIOSK_TOKEN_SECRET: 'from-dotenv'
  }), 'from-dotenv');
  assert.equal(getEnvironmentValue('KIOSK_TOKEN_SECRET', {
    KIOSK_TOKEN_SECRET: 'from-render'
  }, {
    KIOSK_TOKEN_SECRET: 'from-dotenv'
  }), 'from-render');
});

test('face templates are encrypted with authenticated encryption', () => {
  const template = { descriptor: Array.from({ length: 128 }, (_, index) => index / 128) };
  const encrypted = encryptTemplate(template);

  assert.notDeepEqual(encrypted, template);
  assert.deepEqual(decryptTemplate(encrypted), template);
  assert.throws(() => decryptTemplate({
    ...encrypted,
    ciphertext: Buffer.from('tampered').toString('base64')
  }));
});

const response = () => ({
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

test('kiosk secrets are salted, verified, and legacy hashes remain compatible', () => {
  const secret = crypto.randomBytes(32).toString('base64url');
  const firstHash = hashKioskSecret(secret);
  const secondHash = hashKioskSecret(secret);

  assert.notEqual(firstHash, secondHash);
  assert.equal(verifyKioskSecret(secret, firstHash), true);
  assert.equal(verifyKioskSecret('wrong-secret', firstHash), false);
  assert.equal(verifyKioskSecret(secret, 'malformed'), false);

  const legacyHash = crypto.createHash('sha256').update(secret).digest('hex');
  assert.equal(verifyKioskSecret(secret, legacyHash), true);
});

test('credential creation stores only a hash scoped to the owner gym and authorizes it', async t => {
  const originalCreate = KioskCredential.create;
  const originalFindOne = KioskCredential.findOne;
  const originalUpdateOne = KioskCredential.updateOne;
  const originalBusinessFindById = Business.findById;
  t.after(() => {
    KioskCredential.create = originalCreate;
    KioskCredential.findOne = originalFindOne;
    KioskCredential.updateOne = originalUpdateOne;
    Business.findById = originalBusinessFindById;
  });

  assert.equal(config.kioskTokenSecretConfigured, true);
  const tenantId = 'gym-tenant';
  const businessId = 'gym-business';
  const ownerId = 'gym-owner';
  let storedCredential;
  KioskCredential.create = async document => {
    storedCredential = document;
    return document;
  };

  const creationResponse = response();
  await createKioskCredential({
    owner: { _id: ownerId, tenantId, businessId, role: 'owner' },
    tenantId,
    body: { label: 'Reception kiosk' }
  }, creationResponse);

  assert.equal(creationResponse.statusCode, 201);
  assert.match(creationResponse.body.credential.credentialId, /^kiosk_[a-f\d]{24}$/);
  assert.equal(creationResponse.body.credential.secret.length, 43);
  assert.equal(storedCredential.tenantId, tenantId);
  assert.equal(storedCredential.businessId, businessId);
  assert.equal(storedCredential.createdBy, ownerId);
  assert.match(storedCredential.secretHash, /^scrypt\$/);
  assert.notEqual(storedCredential.secretHash, creationResponse.body.credential.secret);
  assert.equal(verifyKioskSecret(creationResponse.body.credential.secret, storedCredential.secretHash), true);

  KioskCredential.findOne = () => ({
    select: async () => storedCredential
  });
  KioskCredential.updateOne = async () => ({ modifiedCount: 1 });
  Business.findById = () => ({
    select: async () => ({
      businessName: 'Test Gym',
      logoUrl: '',
      faceAttendanceEnabled: true,
      qrAttendanceEnabled: true
    })
  });

  const authorizationResponse = response();
  await authenticateKiosk({
    body: {
      credentialId: creationResponse.body.credential.credentialId,
      kioskSecret: creationResponse.body.credential.secret
    }
  }, authorizationResponse);

  assert.equal(authorizationResponse.statusCode, 200);
  const claims = jwt.verify(authorizationResponse.body.token, config.kioskTokenSecret, {
    issuer: 'ss-fitness-manager'
  });
  assert.equal(claims.tenantId, tenantId);
  assert.equal(claims.businessId, businessId);
  assert.equal(claims.credentialId, storedCredential.credentialId);
  assert.equal(claims.purpose, 'attendance-kiosk');
  assert.equal(authorizationResponse.body.expiresInSeconds, 900);
});

test('invalid and revoked kiosk credentials are rejected', async t => {
  const originalFindOne = KioskCredential.findOne;
  t.after(() => { KioskCredential.findOne = originalFindOne; });

  const secret = crypto.randomBytes(32).toString('base64url');
  const activeCredential = {
    credentialId: 'kiosk_test',
    tenantId: 'gym-tenant',
    businessId: 'gym-business',
    secretHash: hashKioskSecret(secret),
    active: true,
    revokedAt: null
  };
  KioskCredential.findOne = () => ({
    select: async () => activeCredential
  });

  const invalidResponse = response();
  await authenticateKiosk({
    body: { credentialId: activeCredential.credentialId, kioskSecret: 'wrong-secret' }
  }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 401);
  assert.equal(invalidResponse.body.code, 'KIOSK_AUTH_INVALID');

  KioskCredential.findOne = () => ({ select: async () => null });
  const revokedResponse = response();
  await authenticateKiosk({
    body: { credentialId: activeCredential.credentialId, kioskSecret: secret }
  }, revokedResponse);
  assert.equal(revokedResponse.statusCode, 401);
  assert.equal(revokedResponse.body.code, 'KIOSK_AUTH_INVALID');
});

test('face check-in rejects a client-supplied member without a recent signed match', async () => {
  const res = response();
  await faceCheckIn({
    body: {
      memberId: '507f1f77bcf86cd799439011',
      idempotencyKey: 'test-request',
      matchToken: ''
    },
    kiosk: {
      tenantId: 'gym-tenant',
      businessId: 'gym-business',
      credentialId: 'kiosk_test'
    }
  }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'FACE_MATCH_REQUIRED');
});

test('kiosk token middleware checks current credential status and preserves tenant claims', async t => {
  const originalFindOne = KioskCredential.findOne;
  t.after(() => { KioskCredential.findOne = originalFindOne; });
  const credential = {
    credentialId: 'kiosk_test',
    tenantId: 'gym-tenant',
    businessId: 'gym-business',
    createdBy: 'gym-owner',
    active: true,
    revokedAt: null
  };
  const token = jwt.sign({
    purpose: 'attendance-kiosk',
    tenantId: credential.tenantId,
    businessId: credential.businessId,
    credentialId: credential.credentialId
  }, config.kioskTokenSecret, {
    expiresIn: '15m',
    issuer: 'ss-fitness-manager'
  });

  KioskCredential.findOne = () => ({
    select: async () => credential
  });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = response();
  let nextCalled = false;
  await protectKiosk(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.kiosk.tenantId, credential.tenantId);

  KioskCredential.findOne = () => ({ select: async () => null });
  const revokedResponse = response();
  await protectKiosk(
    { headers: { authorization: `Bearer ${token}` } },
    revokedResponse,
    () => assert.fail('Revoked kiosk token must not proceed')
  );
  assert.equal(revokedResponse.statusCode, 401);
  assert.equal(revokedResponse.body.code, 'KIOSK_TOKEN_INVALID');
});

test('attendance kiosk idempotency index excludes legacy records without string keys', () => {
  const kioskIndex = Attendance.schema.indexes().find(([keys]) =>
    keys.tenantId === 1 && keys.kioskIdempotencyKey === 1
  );
  assert.ok(kioskIndex);
  assert.equal(kioskIndex[1].unique, true);
  assert.deepEqual(kioskIndex[1].partialFilterExpression, {
    kioskIdempotencyKey: { $type: 'string' }
  });
});
