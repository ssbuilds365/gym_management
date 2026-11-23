const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/ssfm-biometric-tests';
process.env.BIOMETRIC_TEMPLATE_KEY = crypto.randomBytes(32).toString('base64');

const Member = require('../models/Member');
const BiometricCredential = require('../models/BiometricCredential');
const {
  getFaceStatus,
  registerFace,
  removeFace
} = require('../controllers/biometricController');
const { decryptTemplate } = require('../utils/biometricTemplateEncryption');

const memberId = '507f1f77bcf86cd799439011';
const tenantId = '507f1f77bcf86cd799439012';
const businessId = '507f1f77bcf86cd799439013';
const ownerId = '507f1f77bcf86cd799439014';

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
  owner: { _id: ownerId, businessId },
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

test('face registration encrypts the descriptor and updates the scoped member record', async t => {
  const originalMemberFindOne = Member.findOne;
  const originalCredentialUpdate = BiometricCredential.findOneAndUpdate;
  t.after(() => {
    Member.findOne = originalMemberFindOne;
    BiometricCredential.findOneAndUpdate = originalCredentialUpdate;
  });

  let memberFilter;
  const updates = [];
  Member.findOne = async filter => {
    memberFilter = filter;
    return { _id: memberId };
  };
  BiometricCredential.findOneAndUpdate = async (filter, update, options) => {
    updates.push({ filter, update, options });
    return update.$set;
  };

  const descriptor = Array.from({ length: 128 }, (_, index) => index / 256);
  const registration = {
    descriptor,
    modelVersion: 'face-api.js-v1-128d',
    consentGranted: true,
    consentTextVersion: 'face-consent-v1'
  };
  const firstResponse = response();
  await registerFace(request(registration), firstResponse);
  const updatedDescriptor = descriptor.map(value => value - 0.1);
  const updateResponse = response();
  await registerFace(request({
    ...registration,
    descriptor: updatedDescriptor
  }), updateResponse);

  assert.equal(firstResponse.statusCode, 201);
  assert.equal(firstResponse.body.status, 'Registered');
  assert.equal(updateResponse.statusCode, 201);
  assert.equal(updateResponse.body.status, 'Registered');
  assert.deepEqual(memberFilter, {
    _id: memberId,
    tenantId,
    businessId,
    deletedAt: null,
    status: 'Active'
  });
  assert.equal(updates.length, 2);
  assert.equal(updates[0].filter.tenantId, tenantId);
  assert.equal(updates[0].filter.businessId, businessId);
  assert.equal(updates[0].filter.memberId, memberId);
  assert.equal(updates[0].options.upsert, true);
  assert.equal(updates[0].update.$set.consentStatus, 'Granted');
  assert.equal(updates[0].update.$set.createdBy, ownerId);
  assert.deepEqual(
    decryptTemplate(updates[0].update.$set.encryptedTemplate).descriptor,
    descriptor
  );
  assert.deepEqual(
    decryptTemplate(updates[1].update.$set.encryptedTemplate).descriptor,
    updatedDescriptor
  );
  assert.equal(Object.hasOwn(firstResponse.body, 'descriptor'), false);
});

test('face registration rejects invalid member IDs, descriptors, and missing consent', async t => {
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

  const invalidDescriptorResponse = response();
  await registerFace(request({
    descriptor: Array(128).fill(3),
    consentGranted: true,
    consentTextVersion: 'v1',
    modelVersion: 'model-v1'
  }), invalidDescriptorResponse);
  assert.equal(invalidDescriptorResponse.statusCode, 400);

  const missingConsentResponse = response();
  await registerFace(request({
    descriptor: Array(128).fill(0.1),
    consentGranted: false,
    consentTextVersion: 'v1',
    modelVersion: 'model-v1'
  }), missingConsentResponse);
  assert.equal(missingConsentResponse.statusCode, 400);
  assert.equal(memberQueryCount, 0);
});

test('face removal verifies tenant membership and withdraws consent while deleting the template', async t => {
  const originalMemberFindOne = Member.findOne;
  const originalCredentialUpdate = BiometricCredential.updateMany;
  t.after(() => {
    Member.findOne = originalMemberFindOne;
    BiometricCredential.updateMany = originalCredentialUpdate;
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
