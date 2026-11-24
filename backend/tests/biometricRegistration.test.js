const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/ssfm-biometric-tests';
process.env.BIOMETRIC_TEMPLATE_KEY = crypto.randomBytes(32).toString('base64');

const Member = require('../models/Member');
const BiometricCredential = require('../models/BiometricCredential');
const BiometricEnrollmentLock = require('../models/BiometricEnrollmentLock');
const {
  getFaceStatus,
  getFaceDuplicateReport,
  registerFace,
  removeFace
} = require('../controllers/biometricController');
const { encryptTemplate, decryptTemplate } = require('../utils/biometricTemplateEncryption');
const faceRecognition = require('../services/faceRecognition');
const {
  FACE_MODEL_VERSION,
  enrollFaceTemplate
} = require('../services/biometricIdentity');

const memberId = '507f1f77bcf86cd799439011';
const tenantId = '507f1f77bcf86cd799439012';
const businessId = '507f1f77bcf86cd799439013';
const ownerId = '507f1f77bcf86cd799439014';
const originalDescriptorFromImages = faceRecognition.descriptorFromImages;
faceRecognition.descriptorFromImages = async images =>
  faceRecognition.normalizeDescriptor(JSON.parse(images[0]));
test.after(() => {
  faceRecognition.descriptorFromImages = originalDescriptorFromImages;
});

const encodedSamples = descriptor => Array(3).fill(JSON.stringify(descriptor));

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

const request = (body = {}) => ({
  params: { id: memberId },
  tenantId,
  owner: { _id: ownerId, tenantId, businessId, role: 'owner' },
  body
});

test('face status is read only for a member in the owner tenant and business', async t => {
  const originalMemberFindOne = Member.findOne;
  const originalCredentialFindOne = BiometricCredential.findOne;
  t.after(() => {
    Member.findOne = originalMemberFindOne;
    BiometricCredential.findOne = originalCredentialFindOne;
  });

  let memberFilter;
  let credentialFilter;
  Member.findOne = filter => {
    memberFilter = filter;
    return { select: async () => ({ _id: memberId }) };
  };
  BiometricCredential.findOne = filter => {
    credentialFilter = filter;
    return {
      sort: () => ({
        select: async () => ({
          registrationStatus: 'Active',
          modelVersion: FACE_MODEL_VERSION,
          consentStatus: 'Granted',
          registeredAt: new Date('2026-01-01T00:00:00.000Z')
        })
      })
    };
  };

  const res = response();
  await getFaceStatus(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'Registered');
  assert.deepEqual(memberFilter, {
    _id: memberId,
    tenantId,
    businessId,
    deletedAt: null
  });
  assert.equal(credentialFilter.tenantId, tenantId);
  assert.equal(credentialFilter.businessId, businessId);
  assert.equal(credentialFilter.memberId, memberId);
  assert.equal(credentialFilter.consentStatus, 'Granted');
  assert.equal(Object.hasOwn(res.body, 'encryptedTemplate'), false);
});

test('face registration rejects implicit overwrite and atomically revokes before authorized replacement', async t => {
  const originalMemberFindOne = Member.findOne;
  const originalStartSession = mongoose.startSession;
  const originalCredentialFindOne = BiometricCredential.findOne;
  const originalCredentialFind = BiometricCredential.find;
  const originalCredentialCreate = BiometricCredential.create;
  const originalCredentialUpdateMany = BiometricCredential.updateMany;
  const originalLockUpdateOne = BiometricEnrollmentLock.updateOne;
  t.after(() => {
    Member.findOne = originalMemberFindOne;
    mongoose.startSession = originalStartSession;
    BiometricCredential.findOne = originalCredentialFindOne;
    BiometricCredential.find = originalCredentialFind;
    BiometricCredential.create = originalCredentialCreate;
    BiometricCredential.updateMany = originalCredentialUpdateMany;
    BiometricEnrollmentLock.updateOne = originalLockUpdateOne;
  });

  let memberFilter;
  const credentials = [];
  let originalEncryptedTemplate;
  let credentialSequence = 0;
  const memberQuery = {
    select() { return this; },
    session: async () => ({ _id: memberId }),
    then(resolve, reject) {
      return Promise.resolve({ _id: memberId }).then(resolve, reject);
    }
  };
  Member.findOne = filter => {
    memberFilter = filter;
    return memberQuery;
  };
  mongoose.startSession = async () => ({
    withTransaction: callback => callback(),
    endSession: async () => {}
  });
  BiometricEnrollmentLock.updateOne = async () => ({ acknowledged: true });
  BiometricCredential.findOne = filter => ({
    select() { return this; },
    session: async () => credentials.find(item =>
      item.memberId === String(filter.memberId) &&
      item.registrationStatus === 'Active'
    ) || null
  });
  BiometricCredential.find = filter => ({
    select() { return this; },
    session: async () => credentials.filter(item =>
      item.tenantId === tenantId &&
      item.businessId === businessId &&
      item.registrationStatus === 'Active' &&
      (!filter.consentStatus || item.consentStatus === filter.consentStatus)
    )
  });
  BiometricCredential.create = async (documents, options) => {
    assert.ok(options?.session);
    const saved = documents.map(document => ({
      _id: `credential-${++credentialSequence}`,
      ...document,
      tenantId,
      businessId,
      memberId
    }));
    credentials.push(...saved);
    return saved;
  };
  BiometricCredential.updateMany = async (filter, update) => {
    const active = credentials.filter(item =>
      item.memberId === String(filter.memberId) &&
      item.registrationStatus === 'Active' &&
      (!filter.modelVersion?.$ne || item.modelVersion !== filter.modelVersion.$ne) &&
      (!filter.modelVersion || filter.modelVersion.$ne || item.modelVersion === filter.modelVersion)
    );
    for (const item of active) {
      originalEncryptedTemplate = item.encryptedTemplate;
      Object.assign(item, update.$set);
      if (update.$unset?.encryptedTemplate) delete item.encryptedTemplate;
    }
    return { modifiedCount: active.length };
  };

  const descriptor = Array.from({ length: 128 }, (_, index) => index / 256);
  const registration = {
    images: encodedSamples(descriptor),
    consentGranted: true,
    consentTextVersion: 'face-consent-v1'
  };
  const firstResponse = response();
  await registerFace(request(registration), firstResponse);
  const implicitOverwriteResponse = response();
  await registerFace(request({
    ...registration,
    images: encodedSamples(descriptor.map(value => value - 0.1))
  }), implicitOverwriteResponse);
  const replacementDescriptor = descriptor.map(value => value - 0.1);
  const replacementResponse = response();
  await registerFace(request({
    ...registration,
    images: encodedSamples(replacementDescriptor),
    replaceExisting: true
  }), replacementResponse);

  assert.equal(firstResponse.statusCode, 201);
  assert.equal(firstResponse.body.status, 'Registered');
  assert.equal(implicitOverwriteResponse.statusCode, 409);
  assert.equal(implicitOverwriteResponse.body.code, 'FACE_ALREADY_REGISTERED');
  assert.equal(replacementResponse.statusCode, 201);
  assert.deepEqual(memberFilter, {
    _id: memberId,
    tenantId,
    businessId,
    deletedAt: null,
    status: 'Active'
  });
  assert.equal(credentials.length, 2);
  assert.equal(credentials[0].registrationStatus, 'Revoked');
  assert.equal(credentials[0].consentStatus, 'Withdrawn');
  assert.equal(Object.hasOwn(credentials[0], 'encryptedTemplate'), false);
  assert.equal(credentials[1].consentStatus, 'Granted');
  assert.equal(credentials[1].createdBy, ownerId);
  assert.deepEqual(
    decryptTemplate(originalEncryptedTemplate).descriptor,
    faceRecognition.normalizeDescriptor(descriptor)
  );
  assert.deepEqual(
    decryptTemplate(credentials[1].encryptedTemplate).descriptor,
    faceRecognition.normalizeDescriptor(replacementDescriptor)
  );
  assert.equal(Object.hasOwn(replacementResponse.body, 'descriptor'), false);
});

test('staff registration rejects an invalid model descriptor before persistence', async t => {
  const originalDescriptorFromImages = faceRecognition.descriptorFromImages;
  const originalMemberFindOne = Member.findOne;
  t.after(() => {
    faceRecognition.descriptorFromImages = originalDescriptorFromImages;
    Member.findOne = originalMemberFindOne;
  });
  faceRecognition.descriptorFromImages = async () => Array(128).fill(0);
  Member.findOne = async () => ({ _id: memberId });

  const res = response();
  await registerFace(request({
    images: encodedSamples([1, ...Array(127).fill(0)]),
    consentGranted: true,
    consentTextVersion: 'face-consent-v1'
  }), res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'INVALID_FACE_DESCRIPTOR');
  assert.equal(
    res.body.message,
    'The recognition model did not produce a valid 128-value face template.'
  );
});

test('face model replacement retains the encrypted legacy template and marks it for migration', async t => {
  const originals = {
    memberFindOne: Member.findOne,
    startSession: mongoose.startSession,
    credentialFindOne: BiometricCredential.findOne,
    credentialFind: BiometricCredential.find,
    credentialCreate: BiometricCredential.create,
    credentialUpdateMany: BiometricCredential.updateMany,
    lockUpdateOne: BiometricEnrollmentLock.updateOne
  };
  const legacyModelVersion = 'face-api.js-v1-128d';
  const legacyTemplate = encryptTemplate({
    descriptor: [1, ...Array(127).fill(0)],
    modelVersion: legacyModelVersion
  });
  const legacyCredential = {
    _id: 'legacy-face-template',
    memberId,
    modelVersion: legacyModelVersion,
    registrationStatus: 'Active',
    encryptedTemplate: legacyTemplate
  };
  const changes = [];
  t.after(() => {
    Member.findOne = originals.memberFindOne;
    mongoose.startSession = originals.startSession;
    BiometricCredential.findOne = originals.credentialFindOne;
    BiometricCredential.find = originals.credentialFind;
    BiometricCredential.create = originals.credentialCreate;
    BiometricCredential.updateMany = originals.credentialUpdateMany;
    BiometricEnrollmentLock.updateOne = originals.lockUpdateOne;
  });

  Member.findOne = () => ({
    select() { return this; },
    session: async () => ({ _id: memberId })
  });
  mongoose.startSession = async () => ({
    withTransaction: callback => callback(),
    endSession: async () => {}
  });
  BiometricEnrollmentLock.updateOne = async () => ({ acknowledged: true });
  BiometricCredential.findOne = () => ({
    select() { return this; },
    session: async () => legacyCredential
  });
  BiometricCredential.find = () => ({
    select() { return this; },
    session: async () => []
  });
  BiometricCredential.updateMany = async (filter, update) => {
    changes.push({ filter, update });
    if (filter.modelVersion?.$ne) {
      legacyCredential.registrationStatus = update.$set.registrationStatus;
    }
    return { modifiedCount: 1 };
  };
  BiometricCredential.create = async (documents, options) => {
    assert.ok(options?.session);
    return documents.map(document => ({ _id: 'new-face-template', ...document }));
  };

  const result = await enrollFaceTemplate({
    tenantId,
    businessId,
    memberId,
    descriptor: [0, 1, ...Array(126).fill(0)],
    consentTextVersion: 'face-consent-v2',
    createdBy: ownerId,
    replaceExisting: true
  });

  assert.equal(result.status, 'registered');
  assert.equal(legacyCredential.registrationStatus, 'MigrationRequired');
  assert.deepEqual(legacyCredential.encryptedTemplate, legacyTemplate);
  assert.equal(changes[0].update.$unset, undefined);
  assert.equal(changes[0].filter.modelVersion.$ne, FACE_MODEL_VERSION);
});

test('owner Members-tab enrollment rejects another member with the same face', async t => {
  const originals = {
    memberFindOne: Member.findOne,
    startSession: mongoose.startSession,
    credentialFindOne: BiometricCredential.findOne,
    credentialFind: BiometricCredential.find,
    credentialCreate: BiometricCredential.create,
    lockUpdateOne: BiometricEnrollmentLock.updateOne
  };
  const credentials = [];
  let credentialSequence = 0;
  const secondMemberId = '507f1f77bcf86cd799439015';
  const memberQuery = member => ({
    select() { return this; },
    session: async () => ({ _id: member }),
    then(resolve, reject) {
      return Promise.resolve({ _id: member }).then(resolve, reject);
    }
  });
  Member.findOne = filter => memberQuery(filter._id);
  mongoose.startSession = async () => ({
    withTransaction: callback => callback(),
    endSession: async () => {}
  });
  BiometricEnrollmentLock.updateOne = async () => ({ acknowledged: true });
  BiometricCredential.findOne = filter => ({
    select() { return this; },
    session: async () => credentials.find(record =>
      record.memberId === String(filter.memberId) &&
      record.registrationStatus === 'Active'
    ) || null
  });
  BiometricCredential.find = filter => ({
    select() { return this; },
    session: async () => credentials.filter(record =>
      record.tenantId === tenantId &&
      record.businessId === businessId &&
      record.registrationStatus === 'Active'
    )
  });
  BiometricCredential.create = async (documents, options) => {
    assert.ok(options?.session);
    const saved = documents.map(document => ({
      _id: `member-face-${++credentialSequence}`,
      ...document,
      tenantId,
      businessId,
      memberId: String(document.memberId)
    }));
    credentials.push(...saved);
    return saved;
  };
  t.after(() => {
    Member.findOne = originals.memberFindOne;
    mongoose.startSession = originals.startSession;
    BiometricCredential.findOne = originals.credentialFindOne;
    BiometricCredential.find = originals.credentialFind;
    BiometricCredential.create = originals.credentialCreate;
    BiometricEnrollmentLock.updateOne = originals.lockUpdateOne;
  });

  const descriptor = Array.from({ length: 128 }, (_, index) => index / 256);
  const firstResponse = response();
  await registerFace({
    ...request({
      images: encodedSamples(descriptor),
      consentGranted: true,
      consentTextVersion: 'face-consent-v1'
    }),
    params: { id: memberId }
  }, firstResponse);
  const duplicateResponse = response();
  await registerFace({
    ...request({
      images: encodedSamples(descriptor),
      consentGranted: true,
      consentTextVersion: 'face-consent-v1'
    }),
    params: { id: secondMemberId }
  }, duplicateResponse);

  assert.equal(firstResponse.statusCode, 201);
  assert.equal(duplicateResponse.statusCode, 409);
  assert.equal(duplicateResponse.body.code, 'DUPLICATE_FACE_DETECTED');
  assert.equal(duplicateResponse.body.message,
    'This face is already registered with another member. Please contact gym staff.');
  assert.equal(credentials.length, 1);
});

test('face registration rejects invalid member IDs, malformed image samples, and missing consent', async t => {
  const originalMemberFindOne = Member.findOne;
  let memberQueryCount = 0;
  t.after(() => { Member.findOne = originalMemberFindOne; });
  Member.findOne = async () => {
    memberQueryCount += 1;
    return { _id: memberId };
  };

  const invalidIdResponse = response();
  await registerFace({
    ...request({ consentGranted: true }),
    params: { id: 'not-an-object-id' }
  }, invalidIdResponse);
  assert.equal(invalidIdResponse.statusCode, 400);

  const invalidImagesResponse = response();
  await registerFace(request({
    images: ['not-three-samples'],
    consentGranted: true,
    consentTextVersion: 'v1'
  }), invalidImagesResponse);
  assert.equal(invalidImagesResponse.statusCode, 400);

  const missingConsentResponse = response();
  await registerFace(request({
    images: encodedSamples(Array(128).fill(0.1)),
    consentGranted: false,
    consentTextVersion: 'v1'
  }), missingConsentResponse);
  assert.equal(missingConsentResponse.statusCode, 400);
  assert.equal(memberQueryCount, 0);
});

test('face removal verifies tenant membership and withdraws consent while deleting the template', async t => {
  const originalMemberFindOne = Member.findOne;
  const originalCredentialUpdate = BiometricCredential.updateMany;
  const originalStartSession = mongoose.startSession;
  const originalLockUpdateOne = BiometricEnrollmentLock.updateOne;
  t.after(() => {
    Member.findOne = originalMemberFindOne;
    BiometricCredential.updateMany = originalCredentialUpdate;
    mongoose.startSession = originalStartSession;
    BiometricEnrollmentLock.updateOne = originalLockUpdateOne;
  });

  let memberFilter;
  let credentialFilter;
  let credentialUpdate;
  Member.findOne = filter => {
    memberFilter = filter;
    return { select: async () => ({ _id: memberId }) };
  };
  BiometricCredential.updateMany = async (filter, update) => {
    credentialFilter = filter;
    credentialUpdate = update;
    return { modifiedCount: 1 };
  };
  mongoose.startSession = async () => ({
    withTransaction: callback => callback(),
    endSession: async () => {}
  });
  BiometricEnrollmentLock.updateOne = async () => ({ acknowledged: true });

  const res = response();
  await removeFace(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.removed, true);
  assert.deepEqual(memberFilter, {
    _id: memberId,
    tenantId,
    businessId,
    deletedAt: null
  });
  assert.equal(credentialFilter.tenantId, tenantId);
  assert.equal(credentialFilter.businessId, businessId);
  assert.equal(credentialFilter.memberId, memberId);
  assert.equal(credentialUpdate.$set.consentStatus, 'Withdrawn');
  assert.equal(credentialUpdate.$set.registrationStatus, 'Revoked');
  assert.deepEqual(credentialUpdate.$unset, { encryptedTemplate: 1 });
});

test('face status and removal reject invalid member IDs before database lookup', async t => {
  const originalMemberFindOne = Member.findOne;
  let queryCount = 0;
  t.after(() => { Member.findOne = originalMemberFindOne; });
  Member.findOne = () => {
    queryCount += 1;
    throw new Error('Invalid ID reached the database');
  };

  const invalidRequest = {
    ...request(),
    params: { id: 'invalid' }
  };
  const statusResponse = response();
  await getFaceStatus(invalidRequest, statusResponse);
  assert.equal(statusResponse.statusCode, 400);

  const removeResponse = response();
  await removeFace(invalidRequest, removeResponse);
  assert.equal(removeResponse.statusCode, 400);
  assert.equal(queryCount, 0);
});

test('a member outside the authenticated gym cannot reveal or remove biometric data', async t => {
  const originalMemberFindOne = Member.findOne;
  const originalCredentialFindOne = BiometricCredential.findOne;
  const originalCredentialUpdate = BiometricCredential.updateMany;
  let credentialLookupCount = 0;
  let credentialUpdateCount = 0;
  t.after(() => {
    Member.findOne = originalMemberFindOne;
    BiometricCredential.findOne = originalCredentialFindOne;
    BiometricCredential.updateMany = originalCredentialUpdate;
  });
  Member.findOne = filter => {
    assert.equal(filter.tenantId, tenantId);
    assert.equal(filter.businessId, businessId);
    return { select: async () => null };
  };
  BiometricCredential.findOne = () => {
    credentialLookupCount += 1;
    throw new Error('Cross-tenant biometric lookup should not occur');
  };
  BiometricCredential.updateMany = () => {
    credentialUpdateCount += 1;
    throw new Error('Cross-tenant biometric removal should not occur');
  };

  const statusResponse = response();
  await getFaceStatus(request(), statusResponse);
  assert.equal(statusResponse.statusCode, 404);

  const removeResponse = response();
  await removeFace(request(), removeResponse);
  assert.equal(removeResponse.statusCode, 404);
  assert.equal(credentialLookupCount, 0);
  assert.equal(credentialUpdateCount, 0);
});

test('duplicate diagnostic is owner-only and returns only scoped member IDs', async t => {
  const originalCredentialFind = BiometricCredential.find;
  const originalCountDocuments = BiometricCredential.countDocuments;
  const descriptor = [1, ...Array(127).fill(0)];
  const records = ['member-a', 'member-b'].map(memberId => ({
    memberId,
    modelVersion: FACE_MODEL_VERSION,
    encryptedTemplate: encryptTemplate({
      descriptor,
      modelVersion: FACE_MODEL_VERSION
    })
  }));
  let credentialFilter;
  BiometricCredential.find = filter => {
    credentialFilter = filter;
    return {
      select() {
        return {
          then(resolve, reject) {
            return Promise.resolve(records).then(resolve, reject);
          }
        };
      }
    };
  };
  BiometricCredential.countDocuments = async () => 0;
  t.after(() => {
    BiometricCredential.find = originalCredentialFind;
    BiometricCredential.countDocuments = originalCountDocuments;
  });

  const res = response();
  await getFaceDuplicateReport(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'REVIEW_REQUIRED');
  assert.deepEqual(res.body.groups, [{
    memberIds: ['member-a', 'member-b'],
    status: 'REVIEW_REQUIRED'
  }]);
  assert.equal(credentialFilter.tenantId, tenantId);
  assert.equal(credentialFilter.businessId, businessId);
  assert.equal(credentialFilter.registrationStatus, 'Active');
  assert.equal(Object.hasOwn(credentialFilter, 'consentStatus'), false);
  assert.equal(Object.hasOwn(res.body.groups[0], 'encryptedTemplate'), false);

  let lookupCount = 0;
  BiometricCredential.find = () => {
    lookupCount += 1;
    throw new Error('Unauthenticated diagnostic must not query templates.');
  };
  const deniedResponse = response();
  await getFaceDuplicateReport({
    ...request(),
    owner: { ...request().owner, role: 'staff' }
  }, deniedResponse);
  assert.equal(deniedResponse.statusCode, 403);
  assert.equal(lookupCount, 0);
});
