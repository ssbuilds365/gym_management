const mongoose = require('mongoose');

const Member = require('../models/Member');
const BiometricCredential = require('../models/BiometricCredential');
const BiometricEnrollmentLock = require('../models/BiometricEnrollmentLock');
const { encryptTemplate, decryptTemplate } = require('../utils/biometricTemplateEncryption');
const config = require('../config/env');

const FACE_MODEL_VERSION = 'face-api.js-v1-128d';
const FACE_MATCH_DISTANCE_THRESHOLD = 0.45;
const FACE_MATCH_AMBIGUITY_MARGIN = 0.05;

class BiometricIdentityError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BiometricIdentityError';
    this.code = code;
    this.status = status;
  }
}

const isValidDescriptor = descriptor =>
  Array.isArray(descriptor) &&
  descriptor.length === 128 &&
  descriptor.every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 2);

const euclideanDistance = (left, right) => {
  if (!isValidDescriptor(left) || !isValidDescriptor(right)) return Infinity;
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    sum += (left[index] - right[index]) ** 2;
  }
  return Math.sqrt(sum);
};

const ensureGymLock = async (tenantId, businessId) => {
  const lockId = `biometric-enrollment:${String(tenantId)}:${String(businessId)}`;
  try {
    await BiometricEnrollmentLock.updateOne(
      { _id: lockId },
      {
        $setOnInsert: { tenantId, businessId },
        $inc: { version: 0 }
      },
      { upsert: true }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const lock = await BiometricEnrollmentLock.findById(lockId).select('_id');
    if (!lock) throw error;
  }
  return lockId;
};

const incrementGymLock = (lockId, tenantId, businessId, session) =>
  BiometricEnrollmentLock.updateOne(
    { _id: lockId, tenantId, businessId },
    { $inc: { version: 1 } },
    { session }
  );

const withBiometricGymLock = async (tenantId, businessId, operation) => {
  const lockId = await ensureGymLock(tenantId, businessId);
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      await incrementGymLock(lockId, tenantId, businessId, session);
      result = await operation(session);
      return result;
    });
    return result;
  } finally {
    await session.endSession();
  }
};

const decryptCredential = record => {
  const template = decryptTemplate(record.encryptedTemplate);
  if (
    record.modelVersion !== FACE_MODEL_VERSION ||
    template.modelVersion !== FACE_MODEL_VERSION ||
    !isValidDescriptor(template.descriptor)
  ) {
    throw new BiometricIdentityError(
      'BIOMETRIC_TEMPLATE_UNAVAILABLE',
      'A stored face template is incompatible with the active recognition model.',
      503
    );
  }
  return template.descriptor;
};

const getActiveCredentials = (tenantId, businessId, session, requireGrantedConsent = true) => {
  const filter = {
    tenantId,
    businessId,
    biometricType: 'Face',
    registrationStatus: 'Active'
  };
  if (requireGrantedConsent) filter.consentStatus = 'Granted';
  const query = BiometricCredential.find(filter)
    .select('+encryptedTemplate.ciphertext +encryptedTemplate.iv +encryptedTemplate.authTag');
  return session ? query.session(session) : query;
};

const enrollFaceTemplate = async ({
  tenantId,
  businessId,
  memberId,
  descriptor,
  consentTextVersion,
  createdBy,
  replaceExisting = false
}) => {
  if (!isValidDescriptor(descriptor)) {
    throw new BiometricIdentityError(
      'INVALID_FACE_DESCRIPTOR',
      'A valid 128-value face template is required.',
      400
    );
  }
  if (!config.biometricTemplateKeyConfigured) {
    throw new BiometricIdentityError(
      'BIOMETRIC_ENCRYPTION_UNAVAILABLE',
      'Face registration is temporarily unavailable. Please contact gym staff.',
      503
    );
  }

  return withBiometricGymLock(tenantId, businessId, async session => {
      const member = await Member.findOne({
        _id: memberId,
        tenantId,
        businessId,
        deletedAt: null,
        status: 'Active'
      }).select('_id').session(session);
      if (!member) {
        throw new BiometricIdentityError('MEMBER_NOT_FOUND', 'Active member not found.', 404);
      }

      const ownCredentialQuery = BiometricCredential.findOne({
        tenantId,
        businessId,
        memberId: member._id,
        biometricType: 'Face',
        registrationStatus: 'Active'
      }).select('_id').session(session);
      const ownCredential = await ownCredentialQuery;
      const credentials = await getActiveCredentials(tenantId, businessId, session, false);
      if (ownCredential && !replaceExisting) {
        return { status: 'already-registered' };
      }

      for (const record of credentials) {
        if (String(record.memberId) === String(member._id)) continue;
        const registeredDescriptor = decryptCredential(record);
        const distance = euclideanDistance(descriptor, registeredDescriptor);
        if (distance <= FACE_MATCH_DISTANCE_THRESHOLD) {
          return { status: 'duplicate-face' };
        }
      }

      const encryptedTemplate = encryptTemplate({
        descriptor,
        modelVersion: FACE_MODEL_VERSION
      });

      if (replaceExisting) {
        await BiometricCredential.updateMany(
          {
            tenantId,
            businessId,
            memberId: member._id,
            biometricType: 'Face',
            registrationStatus: 'Active'
          },
          {
            $set: {
              registrationStatus: 'Revoked',
              consentStatus: 'Withdrawn',
              revokedAt: new Date(),
              revokedBy: createdBy || null
            },
            $unset: { encryptedTemplate: 1 }
          },
          { session }
        );
      }

      const [savedCredential] = await BiometricCredential.create([{
        tenantId,
        businessId,
        memberId: member._id,
        biometricType: 'Face',
        encryptedTemplate,
        modelVersion: FACE_MODEL_VERSION,
        registrationStatus: 'Active',
        consentStatus: 'Granted',
        consentTextVersion,
        consentAt: new Date(),
        registeredAt: new Date(),
        createdBy: createdBy || null
      }], { session });

      if (!savedCredential?._id) {
        throw new BiometricIdentityError(
          'BIOMETRIC_SAVE_FAILED',
          'Face registration could not be saved. Please retry.',
          500
        );
      }
      return { status: 'registered', credentialId: String(savedCredential._id) };
  });
};

const revokeFaceTemplates = (tenantId, businessId, memberId, actorId) =>
  withBiometricGymLock(tenantId, businessId, session =>
    BiometricCredential.updateMany(
      {
        tenantId,
        businessId,
        memberId,
        biometricType: 'Face',
        registrationStatus: 'Active'
      },
      {
        $set: {
          registrationStatus: 'Revoked',
          consentStatus: 'Withdrawn',
          revokedAt: new Date(),
          revokedBy: actorId || null
        },
        $unset: { encryptedTemplate: 1 }
      },
      { session }
    )
  );

const compareFaceDescriptor = (descriptor, records) => {
  if (!isValidDescriptor(descriptor)) {
    throw new BiometricIdentityError(
      'INVALID_FACE_DESCRIPTOR',
      'A valid face template is required.',
      400
    );
  }
  const matches = records.map(record => ({
    record,
    distance: euclideanDistance(descriptor, decryptCredential(record))
  })).sort((left, right) => left.distance - right.distance);

  const qualified = matches.filter(match => match.distance <= FACE_MATCH_DISTANCE_THRESHOLD);
  const qualifiedMembers = new Set(qualified.map(match => String(match.record.memberId)));
  if (qualifiedMembers.size > 1) {
    return { status: 'duplicate-identity', matches: qualified };
  }
  if (qualified.length === 0) return { status: 'unknown', matches };
  if (
    matches.length > 1 &&
    matches[1].distance - matches[0].distance < FACE_MATCH_AMBIGUITY_MARGIN &&
    String(matches[1].record.memberId) !== String(matches[0].record.memberId)
  ) {
    return { status: 'ambiguous', matches };
  }
  return { status: 'matched', best: matches[0], matches };
};

const findDuplicateIdentityGroups = records => {
  const adjacency = new Map();
  for (let leftIndex = 0; leftIndex < records.length; leftIndex += 1) {
    const left = records[leftIndex];
    const leftDescriptor = decryptCredential(left);
    for (let rightIndex = leftIndex + 1; rightIndex < records.length; rightIndex += 1) {
      const right = records[rightIndex];
      if (String(left.memberId) === String(right.memberId)) continue;
      const distance = euclideanDistance(leftDescriptor, decryptCredential(right));
      if (distance > FACE_MATCH_DISTANCE_THRESHOLD) continue;

      const leftMemberId = String(left.memberId);
      const rightMemberId = String(right.memberId);
      if (!adjacency.has(leftMemberId)) adjacency.set(leftMemberId, new Set());
      if (!adjacency.has(rightMemberId)) adjacency.set(rightMemberId, new Set());
      adjacency.get(leftMemberId).add(rightMemberId);
      adjacency.get(rightMemberId).add(leftMemberId);
    }
  }

  const groups = [];
  const visited = new Set();
  for (const memberId of adjacency.keys()) {
    if (visited.has(memberId)) continue;
    const stack = [memberId];
    const component = [];
    visited.add(memberId);
    while (stack.length) {
      const current = stack.pop();
      component.push(current);
      for (const neighbor of adjacency.get(current) || []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }
    if (component.length > 1) {
      groups.push({
        memberIds: component.sort(),
        status: 'REVIEW_REQUIRED'
      });
    }
  }
  return groups;
};

module.exports = {
  FACE_MODEL_VERSION,
  FACE_MATCH_DISTANCE_THRESHOLD,
  ensureGymLock,
  incrementGymLock,
  withBiometricGymLock,
  BiometricIdentityError,
  isValidDescriptor,
  euclideanDistance,
  decryptCredential,
  getActiveCredentials,
  enrollFaceTemplate,
  revokeFaceTemplates,
  compareFaceDescriptor,
  findDuplicateIdentityGroups
};
