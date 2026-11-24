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

const vectorWithCosine = similarity => [
  similarity,
  Math.sqrt(1 - similarity * similarity),
  ...Array(126).fill(0)
];

test('face identification rejects unknown embeddings', () => {
  const input = [1, ...Array(127).fill(0)];
  const records = [template('member-a', [0, 1, ...Array(126).fill(0)])];
  const comparison = compareFaceDescriptor(input, records);
  assert.equal(comparison.status, 'unknown');
});

test('face identification rejects multiple member identities matching the same embedding', () => {
  const descriptor = [1, ...Array(127).fill(0)];
  const records = [
    template('member-a', descriptor),
    template('member-b', descriptor)
  ];
  const comparison = compareFaceDescriptor(descriptor, records);
  assert.equal(comparison.status, 'duplicate-identity');
});

test('face identification rejects a near-tied best and second-best match', () => {
  const input = [1, ...Array(127).fill(0)];
  const comparison = compareFaceDescriptor(input, [
    template('member-a', vectorWithCosine(0.38)),
    template('member-b', vectorWithCosine(0.34))
  ]);
  assert.equal(comparison.status, 'ambiguous');
});

test('duplicate diagnostic groups current-model templates without exposing embeddings', () => {
  const near = [1, ...Array(127).fill(0)];
  const nearSecond = vectorWithCosine(0.99);
  const far = [0, 1, ...Array(126).fill(0)];
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
  const broken = template('member-a', [1, ...Array(127).fill(0)]);
  broken.encryptedTemplate.authTag = crypto.randomBytes(16).toString('base64');
  assert.throws(() => compareFaceDescriptor(Array(128).fill(0), [broken]));
});
