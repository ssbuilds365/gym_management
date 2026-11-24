const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/ssfm-kiosk-face-identify-tests';
process.env.KIOSK_TOKEN_SECRET = crypto.randomBytes(32).toString('base64url');
process.env.BIOMETRIC_TEMPLATE_KEY = crypto.randomBytes(32).toString('base64');

const Business = require('../models/Business');
const Member = require('../models/Member');
const BiometricCredential = require('../models/BiometricCredential');
const { KIOSK_TOKEN_SECRET } = require('../middleware/kioskAuthMiddleware');
const { encryptTemplate } = require('../utils/biometricTemplateEncryption');
const { FACE_MODEL_VERSION } = require('../services/biometricIdentity');
const faceRecognition = require('../services/faceRecognition');
const { identifyFace } = require('../controllers/kioskController');

const tenantId = '507f1f77bcf86cd799439012';
const businessId = '507f1f77bcf86cd799439013';
const memberId = '507f1f77bcf86cd799439011';
const credentialId = '507f1f77bcf86cd799439014';
const descriptor = [1, ...Array(127).fill(0)];

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

const credential = (id, member, values) => ({
  _id: id,
  memberId: member,
  modelVersion: FACE_MODEL_VERSION,
  encryptedTemplate: encryptTemplate({
    descriptor: values,
    modelVersion: FACE_MODEL_VERSION
  })
});

const mockIdentifyModels = (t, records) => {
  const originalDescriptorFromImage = faceRecognition.descriptorFromImage;
  const originalBusinessFindById = Business.findById;
  const originalCredentialFind = BiometricCredential.find;
  const originalMemberFindOne = Member.findOne;
  let memberLookupCount = 0;
  let queryFilter;
  Business.findById = () => ({
    select: async () => ({ faceAttendanceEnabled: true })
  });
  BiometricCredential.find = filter => {
    queryFilter = filter;
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
  Member.findOne = filter => {
    memberLookupCount += 1;
    assert.equal(String(filter.tenantId), tenantId);
    assert.equal(String(filter.businessId), businessId);
    assert.equal(String(filter._id), memberId);
    return {
      select: async () => ({ _id: memberId, fullName: 'Test Member', status: 'Active' })
    };
  };
  faceRecognition.descriptorFromImage = async image => JSON.parse(image);
  t.after(() => {
    faceRecognition.descriptorFromImage = originalDescriptorFromImage;
    Business.findById = originalBusinessFindById;
    BiometricCredential.find = originalCredentialFind;
    Member.findOne = originalMemberFindOne;
  });
  return {
    get memberLookupCount() { return memberLookupCount; },
    get queryFilter() { return queryFilter; }
  };
};

const request = (input = descriptor) => ({
  body: { image: JSON.stringify(input) },
  kiosk: { tenantId, businessId, credentialId: 'kiosk_test' }
});

test('face identification returns a signed match bound to the exact active template and member', async t => {
  const templateId = '507f1f77bcf86cd799439015';
  const mocks = mockIdentifyModels(t, [credential(templateId, memberId, descriptor)]);
  const res = response();
  await identifyFace(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(mocks.memberLookupCount, 1);
  assert.deepEqual(mocks.queryFilter, {
    tenantId,
    businessId,
    biometricType: 'Face',
    registrationStatus: 'Active',
    modelVersion: FACE_MODEL_VERSION,
    consentStatus: 'Granted'
  });
  const match = jwt.verify(res.body.matchToken, KIOSK_TOKEN_SECRET, {
    issuer: 'ss-fitness-manager'
  });
  assert.equal(match.memberId, memberId);
  assert.equal(match.templateId, templateId);
  assert.equal(Object.hasOwn(res.body.member, 'phone'), false);
});

test('face identification rejects a legacy face mapped to multiple members without selecting one', async t => {
  const mocks = mockIdentifyModels(t, [
    credential('507f1f77bcf86cd799439015', memberId, descriptor),
    credential('507f1f77bcf86cd799439016', '507f1f77bcf86cd799439017', descriptor)
  ]);
  const res = response();
  await identifyFace(request(), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'DUPLICATE_BIOMETRIC_IDENTITY');
  assert.equal(mocks.memberLookupCount, 0);
  assert.equal(Object.hasOwn(res.body, 'member'), false);
});

test('face identification returns UNKNOWN_FACE when the descriptor has no qualifying match', async t => {
  const mocks = mockIdentifyModels(t, [
    credential('507f1f77bcf86cd799439015', memberId, [0, 1, ...Array(126).fill(0)])
  ]);
  const res = response();
  await identifyFace(request(), res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'UNKNOWN_FACE');
  assert.equal(mocks.memberLookupCount, 0);
});
