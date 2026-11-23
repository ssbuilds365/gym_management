const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/ssfm-kiosk-enrollment-tests';
process.env.KIOSK_TOKEN_SECRET = crypto.randomBytes(32).toString('hex');
process.env.BIOMETRIC_TEMPLATE_KEY = 'invalid-test-key';

const config = require('../config/env');
const Business = require('../models/Business');
const Member = require('../models/Member');
const BiometricCredential = require('../models/BiometricCredential');
const { KIOSK_TOKEN_SECRET } = require('../middleware/kioskAuthMiddleware');
const {
  enrollMemberFace,
  identifyFace,
  identifyMemberForEnrollment,
  getKioskConfig
} = require('../controllers/kioskController');

test('kiosk enrollment returns a safe configuration error before persistence when encryption key is invalid', async t => {
  assert.equal(config.biometricTemplateKeyConfigured, false);
  const memberId = '507f1f77bcf86cd799439011';
  const tenantId = '507f1f77bcf86cd799439012';
  const businessId = '507f1f77bcf86cd799439013';
  const originalMemberFindOne = Member.findOne;
  const originalCredentialFindOne = BiometricCredential.findOne;
  const originalCreate = BiometricCredential.create;
  const originalConsoleError = console.error;
  let createCalled = false;
  Member.findOne = () => ({ select: async () => ({ _id: memberId }) });
  BiometricCredential.findOne = () => ({ select: async () => null });
  BiometricCredential.create = async () => {
    createCalled = true;
    throw new Error('Persistence must not be attempted.');
  };
  console.error = () => {};
  t.after(() => {
    Member.findOne = originalMemberFindOne;
    BiometricCredential.findOne = originalCredentialFindOne;
    BiometricCredential.create = originalCreate;
    console.error = originalConsoleError;
  });

  const req = {
    body: {
      images: ['sample-1', 'sample-2', 'sample-3'],
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
  };
  const res = {
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
  };

  await enrollMemberFace(req, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'BIOMETRIC_ENCRYPTION_UNAVAILABLE');
  assert.equal(res.body.success, false);
  assert.equal(createCalled, false);
});

test('face identification reports invalid encryption configuration instead of a misleading no-match result', async t => {
  const originalBusinessFindById = Business.findById;
  const originalCredentialFind = BiometricCredential.find;
  Business.findById = () => ({ select: async () => ({ faceAttendanceEnabled: true }) });
  BiometricCredential.find = () => {
    throw new Error('Biometric data must not be queried without the encryption key.');
  };
  t.after(() => {
    Business.findById = originalBusinessFindById;
    BiometricCredential.find = originalCredentialFind;
  });

  const res = {
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
  };
  await identifyFace({
    body: { image: 'sample' },
    kiosk: { tenantId: '507f1f77bcf86cd799439012', businessId: '507f1f77bcf86cd799439013' }
  }, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'BIOMETRIC_ENCRYPTION_UNAVAILABLE');
  assert.equal(res.body.success, false);
});

test('identifier-only kiosk enrollment is rejected pending staff identity verification', async t => {
  const originalFindOne = Member.findOne;
  Member.findOne = () => {
    throw new Error('Unverified identifiers must not trigger member lookup.');
  };
  t.after(() => { Member.findOne = originalFindOne; });

  const res = {
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
  };
  await identifyMemberForEnrollment({
    body: { identifier: 'MEMBER123' },
    kiosk: { tenantId: '507f1f77bcf86cd799439012', businessId: '507f1f77bcf86cd799439013' }
  }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'STAFF_ENROLLMENT_REQUIRED');
});

test('kiosk configuration does not advertise face capabilities without template encryption', async t => {
  const originalFindById = Business.findById;
  Business.findById = () => ({
    select: async () => ({
      _id: '507f1f77bcf86cd799439012',
      businessName: 'Test Gym',
      faceAttendanceEnabled: true,
      qrAttendanceEnabled: true,
      timeZone: 'Asia/Kolkata'
    })
  });
  t.after(() => { Business.findById = originalFindById; });

  const res = {
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
  };
  await getKioskConfig({
    kiosk: { tenantId: '507f1f77bcf86cd799439012' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.gym.faceAttendanceEnabled, false);
  assert.equal(res.body.gym.faceEnrollmentEnabled, false);
  assert.equal(res.body.gym.qrAttendanceEnabled, true);
});
