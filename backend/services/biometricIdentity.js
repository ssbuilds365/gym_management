const mongoose = require('mongoose');

const Member = require('../models/Member');
const TrainerStaff = require('../models/TrainerStaff');
const BiometricCredential = require('../models/BiometricCredential');
const BiometricEnrollmentLock = require('../models/BiometricEnrollmentLock');
const { encryptTemplate, decryptTemplate } = require('../utils/biometricTemplateEncryption');
const config = require('../config/env');
const faceRecognition = require('./faceRecognition');

const FACE_MODEL_VERSION = faceRecognition.FACE_MODEL_VERSION;
const FACE_MATCH_SIMILARITY_THRESHOLD = 0.363;
const FACE_MATCH_AMBIGUITY_MARGIN = 0.05;

class BiometricIdentityError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BiometricIdentityError';
    this.code = code;
    this.status = status;
  }
}

const isValidDescriptor = faceRecognition.isValidDescriptor;

const cosineSimilarity = (left, right) => {
  if (!isValidDescriptor(left) || !isValidDescriptor(right)) return -Infinity;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm <= 1e-12 || rightNorm <= 1e-12) return -Infinity;
  return Math.max(-1, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)));
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
    registrationStatus: 'Active',
    modelVersion: FACE_MODEL_VERSION
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
  subjectType = 'Member',
  subjectId,
  descriptor,
  consentTextVersion,
  createdBy,
  replaceExisting = false
}) => {
  if (!isValidDescriptor(descriptor)) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[biometric-debug]', JSON.stringify({
        event: 'persistence-descriptor-rejected',
        ...faceRecognition.inspectDescriptor(descriptor)
      }));
    }
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
      let subject;
      if (subjectType === 'Member') {
        subject = await Member.findOne({
          _id: subjectId || memberId,
          tenantId,
          businessId,
          deletedAt: null,
          status: 'Active'
        }).select('_id').session(session);
        if (!subject) {
          throw new BiometricIdentityError('MEMBER_NOT_FOUND', 'Active member not found.', 404);
        }
      } else {
        subject = await TrainerStaff.findOne({
          _id: subjectId,
          tenantId,
          role: subjectType,
          status: 'Active'
        }).select('_id role').session(session);
        if (!subject) {
          throw new BiometricIdentityError('SUBJECT_NOT_FOUND', `Active ${subjectType.toLowerCase()} not found.`, 404);
        }
      }
      const resolvedSubjectId = subject._id;
      const subjectFilter = subjectType === 'Member'
        ? { memberId: resolvedSubjectId }
        : { subjectType, subjectId: resolvedSubjectId };

      const ownCredentialQuery = BiometricCredential.findOne({
        tenantId,
        businessId,
        biometricType: 'Face',
        registrationStatus: 'Active',
        ...subjectFilter
      }).select('_id modelVersion').session(session);
      const ownCredential = await ownCredentialQuery;
      const credentials = await getActiveCredentials(tenantId, businessId, session, false);
      if (ownCredential && !replaceExisting) {
        return {
          status: ownCredential.modelVersion === FACE_MODEL_VERSION
            ? 'already-registered'
            : 'migration-required'
        };
      }

      for (const record of credentials) {
        const recordSubjectId = record.subjectId || record.memberId;
        const recordSubjectType = record.subjectType || 'Member';
        if (String(recordSubjectId) === String(resolvedSubjectId) && recordSubjectType === subjectType) continue;
        const registeredDescriptor = decryptCredential(record);
        const similarity = cosineSimilarity(descriptor, registeredDescriptor);
        if (similarity >= FACE_MATCH_SIMILARITY_THRESHOLD) {
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
            biometricType: 'Face',
            registrationStatus: 'Active',
            modelVersion: { $ne: FACE_MODEL_VERSION },
            ...subjectFilter
          },
          {
            $set: { registrationStatus: 'MigrationRequired' }
          },
          { session }
        );
        await BiometricCredential.updateMany(
          {
            tenantId,
            businessId,
            biometricType: 'Face',
            registrationStatus: 'Active',
            modelVersion: FACE_MODEL_VERSION,
            ...subjectFilter
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

      const registeredAt = new Date();
      const [savedCredential] = await BiometricCredential.create([{
        tenantId,
        businessId,
        ...(subjectType === 'Member'
          ? { memberId: resolvedSubjectId }
          : { memberId: null, subjectType, subjectId: resolvedSubjectId,
              subjectRef: 'TrainerStaff' }),
        biometricType: 'Face',
        encryptedTemplate,
        modelVersion: FACE_MODEL_VERSION,
        registrationStatus: 'Active',
        consentStatus: 'Granted',
        consentTextVersion,
        consentAt: new Date(),
        registeredAt,
        createdBy: createdBy || null
      }], { session });

      if (!savedCredential?._id) {
        throw new BiometricIdentityError(
          'BIOMETRIC_SAVE_FAILED',
          'Face registration could not be saved. Please retry.',
          500
        );
      }
      return {
        status: 'registered',
        credentialId: String(savedCredential._id),
        registeredAt
      };
  });
};

const revokeFaceTemplates = (tenantId, businessId, memberId, actorId, subjectType = 'Member', subjectId = null) =>
  withBiometricGymLock(tenantId, businessId, session =>
    BiometricCredential.updateMany(
      {
        tenantId,
        businessId,
        biometricType: 'Face',
        registrationStatus: 'Active',
        ...(subjectType === 'Member'
          ? { memberId: memberId || subjectId }
          : { subjectType, subjectId: subjectId || memberId })
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
    similarity: cosineSimilarity(descriptor, decryptCredential(record))
  })).sort((left, right) => right.similarity - left.similarity);

  const qualified = matches.filter(match => match.similarity >= FACE_MATCH_SIMILARITY_THRESHOLD);
  const identityKey = record => record.subjectType && record.subjectId
    ? `${record.subjectType}:${record.subjectId}`
    : `Member:${record.memberId}`;
  const qualifiedMembers = new Set(qualified.map(match => identityKey(match.record)));
  if (qualifiedMembers.size > 1) {
    return { status: 'duplicate-identity', matches: qualified };
  }
  if (qualified.length === 0) return { status: 'unknown', matches };
  if (
    matches.length > 1 &&
    matches[0].similarity - matches[1].similarity < FACE_MATCH_AMBIGUITY_MARGIN &&
    identityKey(matches[1].record) !== identityKey(matches[0].record)
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
      const similarity = cosineSimilarity(leftDescriptor, decryptCredential(right));
      if (similarity < FACE_MATCH_SIMILARITY_THRESHOLD) continue;

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
  FACE_MATCH_SIMILARITY_THRESHOLD,
  ensureGymLock,
  incrementGymLock,
  withBiometricGymLock,
  BiometricIdentityError,
  isValidDescriptor,
  cosineSimilarity,
  decryptCredential,
  getActiveCredentials,
  enrollFaceTemplate,
  revokeFaceTemplates,
  compareFaceDescriptor,
  findDuplicateIdentityGroups
};
