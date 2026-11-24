const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/ssfm-kiosk-enrollment-tests';
process.env.KIOSK_TOKEN_SECRET = crypto.randomBytes(32).toString('hex');
process.env.BIOMETRIC_TEMPLATE_KEY = crypto.randomBytes(32).toString('base64');

const Member = require('../models/Member');
const BiometricCredential = require('../models/BiometricCredential');
const BiometricEnrollmentLock = require('../models/BiometricEnrollmentLock');
const { KIOSK_TOKEN_SECRET } = require('../middleware/kioskAuthMiddleware');
const { enrollMemberFace, identifyMemberForEnrollment } = require('../controllers/kioskController');
const { decryptTemplate } = require('../utils/biometricTemplateEncryption');
const faceRecognition = require('../services/faceRecognition');

const tenantId = '507f1f77bcf86cd799439012';
const businessId = '507f1f77bcf86cd799439013';
const memberId = '507f1f77bcf86cd799439011';
const secondMemberId = '507f1f77bcf86cd799439015';
const descriptor = [1, ...Array(127).fill(0)];

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

const makeRequest = (targetMemberId = memberId, faceDescriptor = descriptor, tokenTenantId = tenantId) => ({
  body: {
    images: Array(3).fill(JSON.stringify(faceDescriptor)),
    consentGranted: true,
    enrollmentToken: jwt.sign({
      purpose: 'face-enrollment',
      tenantId: tokenTenantId,
      businessId,
      credentialId: 'kiosk_test',
      memberId: targetMemberId
    }, KIOSK_TOKEN_SECRET, {
      expiresIn: '5m',
      issuer: 'ss-fitness-manager'
    })
  },
  kiosk: { tenantId, businessId, credentialId: 'kiosk_test', createdBy: null }
});

const mockEnrollmentModels = (t, initialCredentials = []) => {
  const originalDescriptorFromImages = faceRecognition.descriptorFromImages;
  const originals = {
    startSession: mongoose.startSession,
    memberFindOne: Member.findOne,
    credentialFindOne: BiometricCredential.findOne,
    credentialFind: BiometricCredential.find,
    credentialCreate: BiometricCredential.create,
    credentialUpdateMany: BiometricCredential.updateMany,
    lockUpdateOne: BiometricEnrollmentLock.updateOne,
    lockFindById: BiometricEnrollmentLock.findById
  };
  const credentials = initialCredentials.map(item => ({ ...item }));
  let nextId = 0;
  let transactionTail = Promise.resolve();

  mongoose.startSession = async () => ({
    withTransaction: callback => {
      const previous = transactionTail;
      let release;
      transactionTail = new Promise(resolve => { release = resolve; });
      return previous.then(callback).finally(() => release());
    },
    endSession: async () => {}
  });
  Member.findOne = filter => ({
    select() {
      return this;
    },
    session: async () => {
      if (
        String(filter.tenantId) !== tenantId ||
        String(filter.businessId) !== businessId ||
        String(filter._id) === '507f1f77bcf86cd799439099'
      ) return null;
      return { _id: filter._id };
    }
  });
  BiometricEnrollmentLock.updateOne = async () => ({ acknowledged: true });
  BiometricEnrollmentLock.findById = () => ({ select: async () => ({ _id: 'lock' }) });
  BiometricCredential.findOne = filter => ({
    select() {
      return this;
    },
    session: async () => credentials.find(item =>
      item.tenantId === tenantId &&
      item.businessId === businessId &&
      String(item.memberId) === String(filter.memberId) &&
      item.registrationStatus === 'Active'
    ) || null
  });
  BiometricCredential.find = filter => ({
    select() {
      return this;
    },
    session: async () => credentials.filter(item =>
      item.tenantId === String(filter.tenantId) &&
      item.businessId === String(filter.businessId) &&
      item.biometricType === filter.biometricType &&
      item.registrationStatus === filter.registrationStatus &&
      (!filter.consentStatus || item.consentStatus === filter.consentStatus)
    )
  });
  BiometricCredential.create = async (documents, options) => {
    assert.ok(Array.isArray(documents));
    assert.ok(options?.session);
    const saved = documents.map(document => ({
      _id: `507f1f77bcf86cd7994390${String(++nextId).padStart(2, '0')}`,
      ...document,
      memberId: String(document.memberId),
      tenantId: String(document.tenantId),
      businessId: String(document.businessId)
    }));
    credentials.push(...saved);
    return saved;
  };
  BiometricCredential.updateMany = async (filter, update) => {
    let modifiedCount = 0;
    for (const item of credentials) {
      if (
        item.tenantId !== String(filter.tenantId) ||
        item.businessId !== String(filter.businessId) ||
        item.memberId !== String(filter.memberId) ||
        item.registrationStatus !== 'Active' ||
        (filter.modelVersion?.$ne && item.modelVersion === filter.modelVersion.$ne) ||
        (filter.modelVersion && !filter.modelVersion.$ne && item.modelVersion !== filter.modelVersion)
      ) continue;
      Object.assign(item, update.$set);
      delete item.encryptedTemplate;
      modifiedCount += 1;
    }
    return { modifiedCount };
  };
  faceRecognition.descriptorFromImages = async images => JSON.parse(images[0]);
  t.after(() => {
    faceRecognition.descriptorFromImages = originalDescriptorFromImages;
    mongoose.startSession = originals.startSession;
    Member.findOne = originals.memberFindOne;
    BiometricCredential.findOne = originals.credentialFindOne;
    BiometricCredential.find = originals.credentialFind;
    BiometricCredential.create = originals.credentialCreate;
    BiometricCredential.updateMany = originals.credentialUpdateMany;
    BiometricEnrollmentLock.updateOne = originals.lockUpdateOne;
    BiometricEnrollmentLock.findById = originals.lockFindById;
  });
  return credentials;
};

test('kiosk enrollment persists only an encrypted, gym-scoped template', async t => {
  const credentials = mockEnrollmentModels(t);
  const res = makeResponse();
  await enrollMemberFace(makeRequest(), res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.code, 'FACE_REGISTERED');
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].tenantId, tenantId);
  assert.equal(credentials[0].businessId, businessId);
  assert.equal(credentials[0].memberId, memberId);
  assert.equal(credentials[0].consentStatus, 'Granted');
  assert.equal(Object.hasOwn(credentials[0].encryptedTemplate, 'descriptor'), false);
  assert.deepEqual(decryptTemplate(credentials[0].encryptedTemplate).descriptor, descriptor);
});

test('same face cannot be registered to a second member in the same gym', async t => {
  const credentials = mockEnrollmentModels(t);
  const firstResponse = makeResponse();
  await enrollMemberFace(makeRequest(memberId), firstResponse);
  assert.equal(firstResponse.statusCode, 201);

  const duplicateResponse = makeResponse();
  await enrollMemberFace(makeRequest(secondMemberId), duplicateResponse);
  assert.equal(duplicateResponse.statusCode, 409);
  assert.equal(duplicateResponse.body.code, 'DUPLICATE_FACE_DETECTED');
  assert.equal(
    duplicateResponse.body.message,
    'This face is already registered with another member. Please contact gym staff.'
  );
  assert.equal(credentials.length, 1);
  assert.equal(Object.hasOwn(duplicateResponse.body, 'member'), false);
});

test('a different face can be enrolled to another member', async t => {
  const credentials = mockEnrollmentModels(t);
  const firstResponse = makeResponse();
  await enrollMemberFace(makeRequest(memberId), firstResponse);
  const differentFace = [0, 1, ...Array(126).fill(0)];
  const secondResponse = makeResponse();
  await enrollMemberFace(makeRequest(secondMemberId, differentFace), secondResponse);

  assert.equal(firstResponse.statusCode, 201);
  assert.equal(secondResponse.statusCode, 201);
  assert.equal(credentials.length, 2);
});

test('simultaneous same-face enrollments serialize on the gym transaction lock', async t => {
  const credentials = mockEnrollmentModels(t);
  const responses = [makeResponse(), makeResponse()];
  await Promise.all([
    enrollMemberFace(makeRequest(memberId), responses[0]),
    enrollMemberFace(makeRequest(secondMemberId), responses[1])
  ]);

  assert.deepEqual(
    responses.map(response => response.statusCode).sort(),
    [201, 409]
  );
  assert.equal(
    responses.filter(response => response.body.code === 'DUPLICATE_FACE_DETECTED').length,
    1
  );
  assert.equal(credentials.length, 1);
});

test('member lookup is tenant-scoped and rejects another gym member', async t => {
  mockEnrollmentModels(t);
  const res = makeResponse();
  await enrollMemberFace(makeRequest('507f1f77bcf86cd799439099'), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'MEMBER_NOT_FOUND');
});

test('identifier-only kiosk self-enrollment is disabled pending staff identity verification', async () => {
  const res = makeResponse();
  await identifyMemberForEnrollment({
    body: { identifier: 'MEMBER123' },
    kiosk: { tenantId, businessId, credentialId: 'kiosk_test' }
  }, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'STAFF_ENROLLMENT_REQUIRED');
});
