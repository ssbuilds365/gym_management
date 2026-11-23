const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/ssfm-kiosk-face-availability-tests';
process.env.KIOSK_TOKEN_SECRET = crypto.randomBytes(32).toString('base64url');
process.env.BIOMETRIC_TEMPLATE_KEY = crypto.randomBytes(32).toString('base64');

const config = require('../config/env');
const Business = require('../models/Business');
const BiometricCredential = require('../models/BiometricCredential');
const faceRecognition = require('../services/faceRecognition');
const { identifyFace, getKioskConfig } = require('../controllers/kioskController');

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

test('kiosk capability stays disabled when backend face models are unavailable', async t => {
  const originalIsReady = faceRecognition.isReady;
  const originalFindById = Business.findById;
  faceRecognition.isReady = () => false;
  Business.findById = () => ({
    select: async () => ({
      _id: '507f1f77bcf86cd799439012',
      businessName: 'Test Gym',
      faceAttendanceEnabled: true,
      qrAttendanceEnabled: true
    })
  });
  t.after(() => {
    faceRecognition.isReady = originalIsReady;
    Business.findById = originalFindById;
  });

  const res = response();
  await getKioskConfig({ kiosk: { tenantId: '507f1f77bcf86cd799439012' } }, res);

  assert.equal(config.biometricTemplateKeyConfigured, true);
  assert.equal(res.body.gym.faceAttendanceEnabled, false);
  assert.equal(res.body.gym.faceEnrollmentEnabled, false);
  assert.equal(res.body.gym.qrAttendanceEnabled, true);
});

test('face identification fails closed when backend model inference is unavailable', async t => {
  const originalDescriptorFromImage = faceRecognition.descriptorFromImage;
  const originalBusinessFindById = Business.findById;
  const originalCredentialFind = BiometricCredential.find;
  faceRecognition.descriptorFromImage = async () => {
    throw new faceRecognition.FaceRecognitionError(
      'BIOMETRIC_RECOGNITION_UNAVAILABLE',
      'Unavailable.',
      503
    );
  };
  Business.findById = () => ({
    select: async () => ({ faceAttendanceEnabled: true })
  });
  BiometricCredential.find = () => {
    throw new Error('Stored templates must not be queried when inference is unavailable.');
  };
  t.after(() => {
    faceRecognition.descriptorFromImage = originalDescriptorFromImage;
    Business.findById = originalBusinessFindById;
    BiometricCredential.find = originalCredentialFind;
  });

  const res = response();
  await identifyFace({
    body: { image: 'data:image/jpeg;base64,AAAA' },
    kiosk: {
      tenantId: '507f1f77bcf86cd799439012',
      businessId: '507f1f77bcf86cd799439013'
    }
  }, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'BIOMETRIC_RECOGNITION_UNAVAILABLE');
  assert.equal(res.body.success, false);
});
