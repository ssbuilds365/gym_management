const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Owner = require('../models/Owner');
const OwnerSession = require('../models/OwnerSession');
const OwnerSecurityAudit = require('../models/OwnerSecurityAudit');
const PasswordResetToken = require('../models/PasswordResetToken');
const { validateNewPassword } = require('./passwordChange');
const {
  isSmtpConfigured,
  sendPasswordResetEmail
} = require('./passwordResetEmail');

const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;
const GENERIC_FORGOT_PASSWORD_MESSAGE =
  'If an account exists for that email, a password reset link will be sent shortly.';

const hashResetToken = token =>
  crypto.createHash('sha256').update(token).digest('hex');

const createResetToken = () => crypto.randomBytes(32).toString('hex');

const createResetUrl = (frontendUrl, token, nodeEnv = 'development') => {
  const url = new URL('/reset-password', frontendUrl);
  if (nodeEnv === 'production' && url.protocol !== 'https:') {
    throw new Error('RESET_URL_MUST_USE_HTTPS');
  }
  url.searchParams.set('token', token);
  return url.toString();
};

const requestPasswordReset = async ({
  email,
  ownerModel = Owner,
  resetTokenModel = PasswordResetToken,
  emailSender = sendPasswordResetEmail,
  smtp = require('../config/env').smtp,
  frontendUrl = require('../config/env').frontendUrl,
  nodeEnv = require('../config/env').nodeEnv,
  now = new Date()
}) => {
  if (!isSmtpConfigured(smtp)) {
    const error = new Error('SMTP_NOT_CONFIGURED');
    error.code = 'SMTP_NOT_CONFIGURED';
    throw error;
  }
  try {
    const resetBaseUrl = new URL(frontendUrl);
    if (nodeEnv === 'production' && resetBaseUrl.protocol !== 'https:') {
      const error = new Error('RESET_URL_MUST_USE_HTTPS');
      error.code = 'RESET_URL_MUST_USE_HTTPS';
      throw error;
    }
  } catch (error) {
    if (error.code) throw error;
    const configurationError = new Error('RESET_URL_INVALID');
    configurationError.code = 'RESET_URL_INVALID';
    throw configurationError;
  }

  const owner = await ownerModel.findOne({
    email,
    isActive: true
  }).select('_id tenantId name email');
  if (!owner) return { success: true };

  await resetTokenModel.updateMany({
    ownerId: owner._id,
    tenantId: owner.tenantId,
    usedAt: null
  }, {
    $set: { usedAt: now }
  });

  const token = createResetToken();
  const resetUrl = createResetUrl(frontendUrl, token, nodeEnv);
  const resetRecord = await resetTokenModel.create({
    ownerId: owner._id,
    tenantId: owner.tenantId,
    tokenHash: hashResetToken(token),
    expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS)
  });

  try {
    await emailSender({
      email: owner.email,
      ownerName: owner.name,
      resetUrl,
      smtp
    });
  } catch (error) {
    await resetTokenModel.updateOne({
      _id: resetRecord._id,
      usedAt: null
    }, {
      $set: { usedAt: now }
    });
    const deliveryError = new Error('PASSWORD_RESET_EMAIL_DELIVERY_FAILED');
    deliveryError.code = 'PASSWORD_RESET_EMAIL_DELIVERY_FAILED';
    throw deliveryError;
  }

  return { success: true };
};

const findValidPasswordReset = async ({
  token,
  resetTokenModel = PasswordResetToken,
  now = new Date()
}) => {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) return null;
  return resetTokenModel.findOne({
    tokenHash: hashResetToken(token),
    usedAt: null,
    expiresAt: { $gt: now }
  }).select('+tokenHash');
};

const resetOwnerPassword = async ({
  token,
  newPassword,
  resetTokenModel = PasswordResetToken,
  ownerModel = Owner,
  sessionModel = OwnerSession,
  auditModel = OwnerSecurityAudit,
  mongooseInstance = mongoose,
  now = new Date()
}) => {
  const record = await findValidPasswordReset({ token, resetTokenModel, now });
  if (!record) return { error: 'RESET_TOKEN_INVALID' };

  const owner = await ownerModel.findOne({
    _id: record.ownerId,
    tenantId: record.tenantId,
    isActive: true
  }).select('+password');
  if (!owner) return { error: 'RESET_TOKEN_INVALID' };

  const passwordError = validateNewPassword(newPassword);
  if (passwordError) return { error: 'NEW_PASSWORD_INVALID', message: passwordError };
  if (await bcrypt.compare(newPassword, owner.password)) {
    return {
      error: 'PASSWORD_UNCHANGED',
      message: 'Choose a password that differs from your current password.'
    };
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  const transaction = await mongooseInstance.startSession();
  try {
    await transaction.withTransaction(async () => {
      const consumedToken = await resetTokenModel.updateOne({
        _id: record._id,
        ownerId: record.ownerId,
        tenantId: record.tenantId,
        tokenHash: hashResetToken(token),
        usedAt: null,
        expiresAt: { $gt: now }
      }, {
        $set: { usedAt: now }
      }, { session: transaction });
      if (consumedToken.matchedCount !== 1) {
        throw new Error('PASSWORD_RESET_TOKEN_ALREADY_USED');
      }

      const updatedOwner = await ownerModel.updateOne({
        _id: owner._id,
        tenantId: record.tenantId,
        isActive: true,
        password: owner.password
      }, {
        $set: {
          password: passwordHash,
          passwordChangedAt: now
        }
      }, { session: transaction });
      if (updatedOwner.matchedCount !== 1) {
        throw new Error('OWNER_PASSWORD_CHANGED_CONCURRENTLY');
      }

      await sessionModel.updateMany({
        ownerId: owner._id,
        tenantId: record.tenantId,
        revokedAt: null
      }, {
        $set: {
          revokedAt: now,
          revokedReason: 'password_changed'
        }
      }, { session: transaction });

      await resetTokenModel.updateMany({
        ownerId: owner._id,
        tenantId: record.tenantId,
        usedAt: null
      }, {
        $set: { usedAt: now }
      }, { session: transaction });

      await auditModel.create([{
        ownerId: owner._id,
        tenantId: record.tenantId,
        action: 'PASSWORD_RESET',
        occurredAt: now
      }], { session: transaction });
    });
  } catch (error) {
    if (error.message === 'PASSWORD_RESET_TOKEN_ALREADY_USED') {
      return { error: 'RESET_TOKEN_INVALID' };
    }
    throw error;
  } finally {
    await transaction.endSession();
  }

  return { success: true };
};

module.exports = {
  PASSWORD_RESET_TTL_MS,
  GENERIC_FORGOT_PASSWORD_MESSAGE,
  hashResetToken,
  createResetToken,
  createResetUrl,
  requestPasswordReset,
  findValidPasswordReset,
  resetOwnerPassword
};
