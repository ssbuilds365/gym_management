const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/ssfm-member-deletion-tests';
process.env.BIOMETRIC_TEMPLATE_KEY = crypto.randomBytes(32).toString('base64');

const Member = require('../models/Member');
const Payment = require('../models/Payment');
const MemberMembership = require('../models/MemberMembership');
const Attendance = require('../models/Attendance');
const BiometricEnrollment = require('../models/BiometricEnrollment');
const BiometricCredential = require('../models/BiometricCredential');
const BiometricEnrollmentLock = require('../models/BiometricEnrollmentLock');
const MemberDeletionAudit = require('../models/MemberDeletionAudit');
const { deleteMember } = require('../controllers/memberController');

const tenantId = '507f1f77bcf86cd799439012';
const businessId = '507f1f77bcf86cd799439013';
const memberId = '507f1f77bcf86cd799439011';
const ownerId = '507f1f77bcf86cd799439014';

test('member deletion revokes and erases current face templates inside its transaction', async t => {
  const originals = {
    startSession: mongoose.startSession,
    memberFindOne: Member.findOne,
    paymentFind: Payment.find,
    membershipFind: MemberMembership.find,
    membershipDeleteMany: MemberMembership.deleteMany,
    attendanceDeleteMany: Attendance.deleteMany,
    biometricEnrollmentDeleteMany: BiometricEnrollment.deleteMany,
    biometricCredentialUpdateMany: BiometricCredential.updateMany,
    biometricLockUpdateOne: BiometricEnrollmentLock.updateOne,
    auditCreate: MemberDeletionAudit.create
  };
  let credentialFilter;
  let credentialUpdate;
  let auditRecord;
  const session = { id: 'test-session' };
  session.withTransaction = async callback => {
    await callback();
  };
  session.endSession = async () => {};
  mongoose.startSession = async () => session;
  BiometricEnrollmentLock.updateOne = async () => ({ acknowledged: true });
  Member.findOne = filter => ({
    session: async receivedSession => {
      assert.equal(receivedSession, session);
      assert.equal(filter.businessId, businessId);
      return {
        _id: memberId,
        businessId,
        save: async options => {
          assert.equal(options.session, session);
        }
      };
    }
  });
  const emptyListQuery = {
    select() { return this; },
    session() { return this; },
    lean: async () => []
  };
  Payment.find = () => emptyListQuery;
  MemberMembership.find = () => emptyListQuery;
  MemberMembership.deleteMany = () => ({
    session: async () => ({ deletedCount: 0 })
  });
  Attendance.deleteMany = () => ({
    session: async () => ({ deletedCount: 0 })
  });
  BiometricEnrollment.deleteMany = () => ({
    session: async () => ({ deletedCount: 0 })
  });
  BiometricCredential.updateMany = (filter, update) => ({
    session: async receivedSession => {
      credentialFilter = filter;
      credentialUpdate = update;
      assert.equal(receivedSession, session);
      return { modifiedCount: 1 };
    }
  });
  MemberDeletionAudit.create = async (records, options) => {
    auditRecord = records[0];
    assert.equal(options.session, session);
  };
  t.after(() => {
    mongoose.startSession = originals.startSession;
    Member.findOne = originals.memberFindOne;
    Payment.find = originals.paymentFind;
    MemberMembership.find = originals.membershipFind;
    MemberMembership.deleteMany = originals.membershipDeleteMany;
    Attendance.deleteMany = originals.attendanceDeleteMany;
    BiometricEnrollment.deleteMany = originals.biometricEnrollmentDeleteMany;
    BiometricCredential.updateMany = originals.biometricCredentialUpdateMany;
    BiometricEnrollmentLock.updateOne = originals.biometricLockUpdateOne;
    MemberDeletionAudit.create = originals.auditCreate;
  });

  const response = {
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
  await deleteMember({
    params: { id: memberId },
    tenantId,
    owner: { _id: ownerId, businessId, role: 'owner' }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(credentialFilter.tenantId, tenantId);
  assert.equal(credentialFilter.businessId, businessId);
  assert.equal(credentialFilter.memberId, memberId);
  assert.equal(credentialUpdate.$set.registrationStatus, 'Revoked');
  assert.equal(credentialUpdate.$set.consentStatus, 'Withdrawn');
  assert.deepEqual(credentialUpdate.$unset, { encryptedTemplate: 1 });
  assert.equal(auditRecord.revokedBiometricCredentialCount, 1);
});
