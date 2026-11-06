const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const Owner = require('../models/Owner');
const OwnerSession = require('../models/OwnerSession');
const OwnerSecurityAudit = require('../models/OwnerSecurityAudit');

const validateNewPassword = password => {
  if (typeof password !== 'string' || password.length < 8) {
    return 'New password must be at least 8 characters long.';
  }
  if (Buffer.byteLength(password, 'utf8') > 72) {
    return 'New password must be 72 bytes or fewer.';
  }
  return '';
};

const validatePasswordChangeInput = ({ currentPassword, newPassword, confirmPassword }) => {
  if ([currentPassword, newPassword, confirmPassword].some(
    value => typeof value !== 'string' || value.length === 0
  )) {
    return 'Current password, new password, and confirmation are required.';
  }
  const passwordError = validateNewPassword(newPassword);
  if (passwordError) return passwordError;
  if (newPassword !== confirmPassword) {
    return 'New password and confirmation do not match.';
  }
  return '';
};

const changeOwnerPassword = async ({
  ownerId,
  tenantId,
  currentPassword,
  newPassword,
  ownerModel = Owner,
  sessionModel = OwnerSession,
  auditModel = OwnerSecurityAudit,
  mongooseInstance = mongoose,
  now = new Date()
}) => {
  const owner = await ownerModel.findOne({
    _id: ownerId,
    tenantId,
    isActive: true
  }).select('+password');

  if (!owner) return { error: 'OWNER_UNAVAILABLE' };
  if (!(await bcrypt.compare(currentPassword, owner.password))) {
    return { error: 'CURRENT_PASSWORD_INVALID' };
  }
  if (await bcrypt.compare(newPassword, owner.password)) {
    return { error: 'PASSWORD_UNCHANGED' };
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  const transaction = await mongooseInstance.startSession();
  try {
    await transaction.withTransaction(async () => {
      const update = await ownerModel.updateOne({
        _id: ownerId,
        tenantId,
        isActive: true,
        password: owner.password
      }, {
        $set: {
          password: passwordHash,
          passwordChangedAt: now
        }
      }, { session: transaction });

      if (update.matchedCount !== 1) {
        throw new Error('OWNER_PASSWORD_CHANGED_CONCURRENTLY');
      }

      await sessionModel.updateMany({
        ownerId,
        tenantId,
        revokedAt: null
      }, {
        $set: {
          revokedAt: now,
          revokedReason: 'password_changed'
        }
      }, { session: transaction });

      await auditModel.create([{
        ownerId,
        tenantId,
        action: 'PASSWORD_CHANGED',
        occurredAt: now
      }], { session: transaction });
    });
  } finally {
    await transaction.endSession();
  }

  return { success: true };
};

module.exports = {
  changeOwnerPassword,
  validateNewPassword,
  validatePasswordChangeInput
};
