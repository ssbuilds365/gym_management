const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/ssfm-biometric-identity-tests';
process.env.BIOMETRIC_TEMPLATE_KEY = crypto.randomBytes(32).toString('base64');

const { encryptTemplate } = require('../utils/biometricTemplateEncryption');
const {
  FACE_MODEL_VERSION,
  compareFaceDescriptor,
  findDuplicateIdentityGroups
} = require('../services/biometricIdentity');

const template = (memberId, descriptor) => ({
  _id: `template-${memberId}`,
  memberId,
  modelVersion: FACE_MODEL_VERSION,
  encryptedTemplate: encryptTemplate({
    descriptor,
    modelVersion: FACE_MODEL_VERSION
  })
});

test('face identification rejects unknown embeddings', () => {
  const records = [template('member-a', Array(128).fill(1))];
  const comparison = compareFaceDescriptor(Array(128).fill(0), records);
  assert.equal(comparison.status, 'unknown');
});

test('face identification rejects multiple member identities matching the same embedding', () => {
  const descriptor = Array(128).fill(0);
  const records = [
    template('member-a', descriptor),
    template('member-b', Array(128).fill(0.01))
  ];
  const comparison = compareFaceDescriptor(descriptor, records);
  assert.equal(comparison.status, 'duplicate-identity');
});

test('face identification rejects a near-tied best and second-best match', () => {
  const input = Array(128).fill(0);
  const first = Array(128).fill(0);
  first[0] = 0.44;
  const second = Array(128).fill(0);
  second[0] = -0.47;
  const comparison = compareFaceDescriptor(input, [
    template('member-a', first),
    template('member-b', second)
  ]);
  assert.equal(comparison.status, 'ambiguous');
});

test('legacy duplicate diagnostic groups cross-member templates without exposing embeddings', () => {
  const near = Array(128).fill(0);
  const nearSecond = Array(128).fill(0.01);
  const far = Array(128).fill(1);
  const groups = findDuplicateIdentityGroups([
    template('member-a', near),
    template('member-b', nearSecond),
    template('member-c', far)
  ]);
  assert.deepEqual(groups, [{
    memberIds: ['member-a', 'member-b'],
    status: 'REVIEW_REQUIRED'
  }]);
  assert.equal(Object.hasOwn(groups[0], 'descriptor'), false);
  assert.equal(Object.hasOwn(groups[0], 'encryptedTemplate'), false);
});

test('decryption or model incompatibility fails closed', () => {
  const broken = template('member-a', Array(128).fill(0));
  broken.encryptedTemplate.authTag = crypto.randomBytes(16).toString('base64');
  assert.throws(() => compareFaceDescriptor(Array(128).fill(0), [broken]));
});
