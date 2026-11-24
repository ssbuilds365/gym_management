const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/ssfm-kiosk-tests';
process.env.KIOSK_TOKEN_SECRET = crypto.randomBytes(32).toString('base64url');
process.env.BIOMETRIC_TEMPLATE_KEY = crypto.randomBytes(32).toString('base64');

const KioskCredential = require('../models/KioskCredential');
const Business = require('../models/Business');
const Attendance = require('../models/Attendance');
const BiometricCredential = require('../models/BiometricCredential');
const Member = require('../models/Member');
const MemberMembership = require('../models/MemberMembership');
const config = require('../config/env');
const {
  authenticateKiosk,
  faceCheckIn,
  getKioskCapabilities
} = require('../controllers/kioskController');
const faceRecognition = require('../services/faceRecognition');
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

test('kiosk capabilities require biometric configuration and model readiness', t => {
  const originalIsReady = faceRecognition.isReady;
  t.after(() => {
    faceRecognition.isReady = originalIsReady;
  });

  faceRecognition.isReady = () => false;
  assert.deepEqual(getKioskCapabilities({
    faceAttendanceEnabled: true,
    qrAttendanceEnabled: true
  }), {
    faceAttendanceEnabled: false,
    faceEnrollmentEnabled: false,
    faceEnrollmentRequiresStaff: false,
    qrAttendanceEnabled: true
  });

  faceRecognition.isReady = () => true;
  assert.deepEqual(getKioskCapabilities({
    faceAttendanceEnabled: true,
    qrAttendanceEnabled: true
  }), {
    faceAttendanceEnabled: true,
    faceEnrollmentEnabled: false,
    faceEnrollmentRequiresStaff: true,
    qrAttendanceEnabled: true
  });
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
  const originalFaceRecognitionIsReady = faceRecognition.isReady;
  t.after(() => {
    KioskCredential.create = originalCreate;
    KioskCredential.findOne = originalFindOne;
    KioskCredential.updateOne = originalUpdateOne;
    Business.findById = originalBusinessFindById;
    faceRecognition.isReady = originalFaceRecognitionIsReady;
  });
  faceRecognition.isReady = () => true;

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
  assert.equal(authorizationResponse.body.gym.faceAttendanceEnabled, true);
  assert.equal(authorizationResponse.body.gym.faceEnrollmentEnabled, false);
  assert.equal(authorizationResponse.body.gym.faceEnrollmentRequiresStaff, true);
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

test('face check-in rejects a client member ID that differs from the signed face match', async () => {
  const surajId = '507f1f77bcf86cd799439011';
  const vimleshId = '507f1f77bcf86cd799439015';
  const matchToken = jwt.sign({
    purpose: 'face-match',
    tenantId: 'gym-tenant',
    businessId: 'gym-business',
    credentialId: 'kiosk_test',
    memberId: surajId,
    templateId: '507f1f77bcf86cd799439099'
  }, config.kioskTokenSecret, {
    expiresIn: '60s',
    issuer: 'ss-fitness-manager'
  });
  const res = response();
  await faceCheckIn({
    body: {
      memberId: vimleshId,
      idempotencyKey: 'member-substitution-test',
      matchToken
    },
    kiosk: {
      tenantId: 'gym-tenant',
      businessId: 'gym-business',
      credentialId: 'kiosk_test'
    }
  }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, 'FACE_MATCH_INVALID');
});

test('face check-in records only the member bound to the active matched template', async t => {
  const originals = {
    businessFindById: Business.findById,
    credentialFindOne: BiometricCredential.findOne,
    attendanceFindOne: Attendance.findOne,
    attendanceCreate: Attendance.create,
    memberFindOne: Member.findOne,
    membershipFindOne: MemberMembership.findOne,
    startSession: mongoose.startSession,
    lockUpdateOne: require('../models/BiometricEnrollmentLock').updateOne
  };
  const surajId = '507f1f77bcf86cd799439011';
  const templateId = '507f1f77bcf86cd799439099';
  let attendanceDocument;
  Business.findById = () => ({
    select: async () => ({ faceAttendanceEnabled: true, timeZone: 'Asia/Kolkata' })
  });
  BiometricCredential.findOne = () => {
    const query = {
      select() { return this; },
      session: async () => ({ _id: templateId }),
      then(resolve, reject) {
        return Promise.resolve({ _id: templateId }).then(resolve, reject);
      }
    };
    return query;
  };
  Attendance.findOne = filter => ({
    select: async () => null,
    sort: async () => null
  });
  Attendance.create = async (documents, options) => {
    assert.ok(options?.session);
    attendanceDocument = documents[0];
    return [{ _id: 'attendance-1', checkIn: documents[0].checkIn }];
  };
  Member.findOne = async filter => ({
    _id: filter._id,
    status: 'Active',
    fullName: 'Suraj'
  });
  MemberMembership.findOne = () => ({
    sort: () => ({
      populate: () => ({
        lean: async () => ({
          endDate: new Date(Date.now() + 86400000),
          planId: { planName: 'Monthly' }
        })
      }),
      lean: async () => null
    })
  });
  const biometricLock = require('../models/BiometricEnrollmentLock');
  biometricLock.updateOne = async () => ({ acknowledged: true });
  mongoose.startSession = async () => ({
    withTransaction: callback => callback(),
    endSession: async () => {}
  });
  t.after(() => {
    Business.findById = originals.businessFindById;
    BiometricCredential.findOne = originals.credentialFindOne;
    Attendance.findOne = originals.attendanceFindOne;
    Attendance.create = originals.attendanceCreate;
    Member.findOne = originals.memberFindOne;
    MemberMembership.findOne = originals.membershipFindOne;
    mongoose.startSession = originals.startSession;
    biometricLock.updateOne = originals.lockUpdateOne;
  });

  const matchToken = jwt.sign({
    purpose: 'face-match',
    tenantId: 'gym-tenant',
    businessId: 'gym-business',
    credentialId: 'kiosk_test',
    memberId: surajId,
    templateId
  }, config.kioskTokenSecret, {
    expiresIn: '60s',
    issuer: 'ss-fitness-manager'
  });
  const res = response();
  await faceCheckIn({
    body: {
      memberId: surajId,
      idempotencyKey: 'suraj-attendance-test',
      matchToken
    },
    kiosk: {
      tenantId: 'gym-tenant',
      businessId: 'gym-business',
      credentialId: 'kiosk_test'
    }
  }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(String(attendanceDocument.memberId), surajId);
  assert.equal(attendanceDocument.attendanceType, 'Biometric');
});

test('face check-in rejects a revoked template referenced by a recent face match', async t => {
  const originalBusinessFindById = Business.findById;
  const originalCredentialFindOne = BiometricCredential.findOne;
  const originalAttendanceFindOne = Attendance.findOne;
  let attendanceLookupCount = 0;
  Business.findById = () => ({ select: async () => ({ faceAttendanceEnabled: true }) });
  BiometricCredential.findOne = () => ({ select: async () => null });
  Attendance.findOne = () => {
    attendanceLookupCount += 1;
    throw new Error('Revoked template must not reach attendance persistence.');
  };
  t.after(() => {
    Business.findById = originalBusinessFindById;
    BiometricCredential.findOne = originalCredentialFindOne;
    Attendance.findOne = originalAttendanceFindOne;
  });

  const memberId = '507f1f77bcf86cd799439011';
  const matchToken = jwt.sign({
    purpose: 'face-match',
    tenantId: 'gym-tenant',
    businessId: 'gym-business',
    credentialId: 'kiosk_test',
    memberId,
    templateId: '507f1f77bcf86cd799439099'
  }, config.kioskTokenSecret, {
    expiresIn: '60s',
    issuer: 'ss-fitness-manager'
  });
  const res = response();
  await faceCheckIn({
    body: { memberId, idempotencyKey: 'revoked-face-test', matchToken },
    kiosk: { tenantId: 'gym-tenant', businessId: 'gym-business', credentialId: 'kiosk_test' }
  }, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'MEMBER_NOT_RECOGNIZED');
  assert.equal(attendanceLookupCount, 0);
});

test('expired membership cannot create biometric attendance', async t => {
  const originalBusinessFindById = Business.findById;
  const originalCredentialFindOne = BiometricCredential.findOne;
  const originalAttendanceFindOne = Attendance.findOne;
  const originalAttendanceCreate = Attendance.create;
  const originalMemberFindOne = Member.findOne;
  const originalMembershipFindOne = MemberMembership.findOne;
  let attendanceCreateCount = 0;
  Business.findById = () => ({
    select: async () => ({
      faceAttendanceEnabled: true,
      timeZone: 'Asia/Kolkata'
    })
  });
  BiometricCredential.findOne = () => ({
    select: async () => ({ _id: '507f1f77bcf86cd799439099' })
  });
  Attendance.findOne = () => ({
    select: async () => null,
    sort: () => null
  });
  Attendance.create = async () => {
    attendanceCreateCount += 1;
    throw new Error('Expired membership must not create attendance.');
  };
  Member.findOne = async filter => ({
    _id: filter._id,
    status: 'Active',
    fullName: 'Test Member'
  });
  MemberMembership.findOne = filter => ({
    sort: () => ({
      populate: () => ({ lean: async () => null }),
      lean: async () => ({ endDate: new Date('2020-01-01T00:00:00.000Z') })
    })
  });
  t.after(() => {
    Business.findById = originalBusinessFindById;
    BiometricCredential.findOne = originalCredentialFindOne;
    Attendance.findOne = originalAttendanceFindOne;
    Attendance.create = originalAttendanceCreate;
    Member.findOne = originalMemberFindOne;
    MemberMembership.findOne = originalMembershipFindOne;
  });

  const memberId = '507f1f77bcf86cd799439011';
  const matchToken = jwt.sign({
    purpose: 'face-match',
    tenantId: 'gym-tenant',
    businessId: 'gym-business',
    credentialId: 'kiosk_test',
    memberId,
    templateId: '507f1f77bcf86cd799439099'
  }, config.kioskTokenSecret, {
    expiresIn: '60s',
    issuer: 'ss-fitness-manager'
  });
  const res = response();
  await faceCheckIn({
    body: { memberId, idempotencyKey: 'expired-membership-test', matchToken },
    kiosk: { tenantId: 'gym-tenant', businessId: 'gym-business', credentialId: 'kiosk_test' }
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'MEMBERSHIP_EXPIRED');
  assert.equal(attendanceCreateCount, 0);
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
