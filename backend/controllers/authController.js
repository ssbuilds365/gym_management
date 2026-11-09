const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const OwnerSession = require('../models/OwnerSession');

const Owner = require('../models/Owner');
const Business = require('../models/Business');
const config = require('../config/env');
const {
  changeOwnerPassword,
  validatePasswordChangeInput,
  validateNewPassword
} = require('../services/passwordChange');
const {
  GENERIC_FORGOT_PASSWORD_MESSAGE,
  requestPasswordReset,
  findValidPasswordReset,
  resetOwnerPassword
} = require('../services/passwordReset');
const {
  SESSION_COOKIE_NAME,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_MAX_AGE_MS,
  TOKEN_ROTATION_GRACE_MS,
  createSessionToken,
  hashSessionToken,
  getSessionToken,
  getDeviceLabel,
  cookieOptions
} = require('../utils/ownerSession');

const publicSession = session => ({
  id: String(session._id),
  device: session.device,
  createdAt: session.createdAt,
  lastActivityAt: session.lastActivityAt,
  expiresAt: session.expiresAt
});

const issueSession = async (owner, req, res) => {
  const token = createSessionToken();
  const now = new Date();
  const session = await OwnerSession.create({
    ownerId: owner._id,
    tenantId: owner.tenantId,
    businessId: owner.businessId,
    tokenHash: hashSessionToken(token),
    device: getDeviceLabel(req.get('user-agent')),
    userAgent: String(req.get('user-agent') || '').slice(0, 500),
    lastActivityAt: now,
    expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_MS)
  });
  res.cookie(SESSION_COOKIE_NAME, token, cookieOptions(config.nodeEnv));
  return publicSession(session);
};

const clearSessionCookie = res => {
  const options = cookieOptions(config.nodeEnv);
  delete options.maxAge;
  res.clearCookie(SESSION_COOKIE_NAME, options);
};

const findActiveSession = (req, now) => OwnerSession.findOne({
  _id: req.session._id,
  ownerId: req.owner._id,
  tenantId: req.tenantId,
  revokedAt: null,
  expiresAt: { $gt: now },
  lastActivityAt: { $gt: new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS) }
});

const respondWithLatestSession = async (req, res, now) => {
  const session = await findActiveSession(req, now);
  if (!session) return false;
  res.status(409).json({
    success: false,
    code: 'SESSION_REFRESHED',
    message: 'This session was updated in another tab.',
    session: publicSession(session)
  });
  return true;
};

// OWNER REGISTRATION
exports.registerOwner = async (req, res) => {
  let createdBusiness;
  let createdOwner;

  try {
    const {
      name,
      email,
      phone,
      password,
      businessName,
      businessType,
      address
    } = req.body;

    if (
      !name || !email || !phone || !password ||
      !businessName || !businessType
    ) {
      return res.status(400).json({
        success: false,
        message: 'Please fill all required fields'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters'
      });
    }

    const validBusinessTypes = [
      'Gym',
      'Yoga Studio',
      'Fitness Studio',
      'Other'
    ];

    if (!validBusinessTypes.includes(businessType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid business type'
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existingOwner = await Owner.findOne({
      email: normalizedEmail
    });

    if (existingOwner) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists'
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // Create Business
    createdBusiness = await Business.create({
      businessName,
      businessType,
      ownerName: name,
      phone,
      email: normalizedEmail,
      address
    });

    // Create Owner
    const owner = await Owner.create({
      name,
      email: normalizedEmail,
      phone,
      password: hashedPassword,
      businessId: createdBusiness._id,
      tenantId: createdBusiness._id
    });
    createdOwner = owner;

    const session = await issueSession(owner, req, res);

    return res.status(201).json({
      success: true,
      message: 'Registration successful',
      session,
      owner: {
        id: owner._id,
        name: owner.name,
        email: owner.email,
        phone: owner.phone,
        businessId: owner.businessId,
        tenantId: owner.tenantId,
        role: owner.role
      },
      business: {
        id: createdBusiness._id,
        businessName: createdBusiness.businessName,
        businessType: createdBusiness.businessType
      }
    });

  } catch (error) {
    // Avoid leaving a partially registered account if session creation fails.
    if (createdOwner) {
      await Owner.findByIdAndDelete(createdOwner._id);
    }
    if (createdBusiness) {
      await Business.findByIdAndDelete(createdBusiness._id);
    }

    console.error('Registration Error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Registration failed'
    });
  }
};

// OWNER LOGIN
exports.loginOwner = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required'
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const owner = await Owner.findOne({
      email: normalizedEmail
    }).select('+password');

    if (!owner) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    if (!owner.isActive) {
      return res.status(403).json({
        success: false,
        message: 'Your account is inactive'
      });
    }

    const isPasswordValid = await bcrypt.compare(
      password,
      owner.password
    );

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password'
      });
    }

    const business = await Business.findById(owner.businessId);

    if (!business || business.status !== 'Active') {
      return res.status(403).json({
        success: false,
        message: 'Business account is unavailable'
      });
    }

    const session = await issueSession(owner, req, res);

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      session,
      owner: {
        id: owner._id,
        name: owner.name,
        email: owner.email,
        phone: owner.phone,
        tenantId: owner.tenantId,
        role: owner.role
      },
      business: {
        id: business._id,
        businessName: business.businessName,
        businessType: business.businessType
      }
    });

  } catch (error) {
    console.error('Login Error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Login failed'
    });
  }
};

// GET OWNER PROFILE
exports.getProfile = async (req, res) => {
  try {
    // Owner is already verified by authMiddleware
    const owner = req.owner;

    if (!owner) {
      return res.status(401).json({
        success: false,
        message: 'Owner authentication failed'
      });
    }

    const business = await Business.findById(owner.businessId);

    if (!business || business.status !== 'Active') {
      return res.status(403).json({
        success: false,
        message: 'Business account is unavailable'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Profile fetched successfully',

      owner: {
        id: owner._id,
        name: owner.name,
        email: owner.email,
        phone: owner.phone,
        businessId: owner.businessId,
        tenantId: owner.tenantId,
        role: owner.role
      },

      business: {
        id: business._id,
        businessName: business.businessName,
        businessType: business.businessType,
        address: business.address,
        logoUrl: business.logoUrl || ''
      },
      session: publicSession(req.session)
    });

  } catch (error) {
    console.error('Profile Error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to fetch profile'
    });
  }
};

exports.recordSessionActivity = async (req, res) => {
  try {
    const now = new Date();
    const token = getSessionToken(req.headers.cookie);
    const tokenHash = hashSessionToken(token);
    const updated = await OwnerSession.findOneAndUpdate({
      _id: req.session._id,
      ownerId: req.owner._id,
      tenantId: req.tenantId,
      revokedAt: null,
      tokenHash,
      expiresAt: { $gt: now }
    }, {
      $set: {
        lastActivityAt: now,
        expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_MS)
      }
    }, { new: true });

    if (!updated) {
      if (await respondWithLatestSession(req, res, now)) return;
      clearSessionCookie(res);
      return res.status(401).json({
        success: false,
        code: 'SESSION_REVOKED',
        message: 'This session is no longer active. Please log in again.'
      });
    }

    res.cookie(SESSION_COOKIE_NAME, token, cookieOptions(config.nodeEnv));
    return res.status(200).json({ success: true, session: publicSession(updated) });
  } catch (error) {
    console.error('Record session activity error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to update session activity' });
  }
};

exports.refreshSession = async (req, res) => {
  try {
    const currentToken = getSessionToken(req.headers.cookie);
    const currentHash = hashSessionToken(currentToken);
    const now = new Date();
    if (currentHash !== req.session.tokenHash) {
      if (await respondWithLatestSession(req, res, now)) return;
      clearSessionCookie(res);
      return res.status(401).json({
        success: false,
        code: 'SESSION_EXPIRED',
        message: 'Your session has expired. Please log in again.'
      });
    }

    const nextToken = createSessionToken();
    const session = await OwnerSession.findOneAndUpdate({
      _id: req.session._id,
      ownerId: req.owner._id,
      tenantId: req.tenantId,
      revokedAt: null,
      tokenHash: currentHash,
      lastActivityAt: { $gt: new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS) },
      expiresAt: { $gt: now }
    }, {
      $set: {
        previousTokenHash: currentHash,
        previousTokenValidUntil: new Date(now.getTime() + TOKEN_ROTATION_GRACE_MS),
        tokenHash: hashSessionToken(nextToken),
        lastActivityAt: now,
        expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_MS)
      }
    }, { new: true });

    if (!session) {
      if (await respondWithLatestSession(req, res, now)) return;
      clearSessionCookie(res);
      return res.status(401).json({
        success: false,
        code: 'SESSION_EXPIRED',
        message: 'Your session has expired. Please log in again.'
      });
    }

    res.cookie(SESSION_COOKIE_NAME, nextToken, cookieOptions(config.nodeEnv));
    return res.status(200).json({ success: true, session: publicSession(session) });
  } catch (error) {
    console.error('Refresh session error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to refresh session' });
  }
};

exports.logoutSession = async (req, res) => {
  try {
    const token = getSessionToken(req.headers.cookie);
    if (token) {
      await OwnerSession.updateOne({
        tokenHash: hashSessionToken(token),
        revokedAt: null
      }, {
        $set: { revokedAt: new Date(), revokedReason: 'logout' }
      });
    }
    clearSessionCookie(res);
    return res.status(200).json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error.message);
    clearSessionCookie(res);
    return res.status(500).json({ success: false, message: 'Unable to invalidate session' });
  }
};

exports.getOwnerSessions = async (req, res) => {
  try {
    const now = new Date();
    const sessions = await OwnerSession.find({
      ownerId: req.owner._id,
      tenantId: req.tenantId,
      revokedAt: null,
      expiresAt: { $gt: now },
      lastActivityAt: { $gt: new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS) }
    }).sort({ lastActivityAt: -1 }).lean();
    return res.status(200).json({
      success: true,
      sessions: sessions.map(session => ({
        ...publicSession(session),
        current: String(session._id) === String(req.session._id)
      }))
    });
  } catch (error) {
    console.error('List owner sessions error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load active sessions' });
  }
};

exports.revokeOwnerSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return res.status(400).json({ success: false, message: 'Invalid session ID' });
    }
    const session = await OwnerSession.findOneAndUpdate({
      _id: sessionId,
      ownerId: req.owner._id,
      tenantId: req.tenantId,
      revokedAt: null
    }, {
      $set: { revokedAt: new Date(), revokedReason: 'revoked' }
    }, { new: true });
    if (!session) {
      return res.status(404).json({ success: false, message: 'Active session not found' });
    }
    const current = String(session._id) === String(req.session._id);
    if (current) clearSessionCookie(res);
    return res.status(200).json({ success: true, current });
  } catch (error) {
    console.error('Revoke owner session error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to revoke session' });
  }
};

exports.revokeOtherOwnerSessions = async (req, res) => {
  try {
    await OwnerSession.updateMany({
      ownerId: req.owner._id,
      tenantId: req.tenantId,
      _id: { $ne: req.session._id },
      revokedAt: null
    }, {
      $set: { revokedAt: new Date(), revokedReason: 'revoked' }
    });
    return res.status(200).json({ success: true, message: 'Other sessions were revoked' });
  } catch (error) {
    console.error('Revoke other sessions error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to revoke other sessions' });
  }
};

exports.revokeAllOwnerSessions = async (req, res) => {
  try {
    await OwnerSession.updateMany({
      ownerId: req.owner._id,
      tenantId: req.tenantId,
      revokedAt: null
    }, {
      $set: { revokedAt: new Date(), revokedReason: 'revoked' }
    });
    clearSessionCookie(res);
    return res.status(200).json({ success: true, message: 'All sessions were revoked' });
  } catch (error) {
    console.error('Revoke all sessions error:', error.message);
    clearSessionCookie(res);
    return res.status(500).json({ success: false, message: 'Unable to revoke sessions' });
  }
};

exports.changeOwnerPassword = async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  const validationError = validatePasswordChangeInput({
    currentPassword,
    newPassword,
    confirmPassword
  });
  if (validationError) return res.status(400).json({ success: false, message: validationError });

  try {
    const result = await changeOwnerPassword({
      ownerId: req.owner._id,
      tenantId: req.tenantId,
      currentPassword,
      newPassword
    });

    if (result.error === 'CURRENT_PASSWORD_INVALID') {
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect.'
      });
    }
    if (result.error === 'PASSWORD_UNCHANGED') {
      return res.status(400).json({
        success: false,
        message: 'Choose a new password that differs from your current password.'
      });
    }
    if (result.error === 'OWNER_UNAVAILABLE') {
      return res.status(401).json({
        success: false,
        message: 'The authenticated owner account is unavailable.'
      });
    }

    clearSessionCookie(res);
    return res.status(200).json({
      success: true,
      message: 'Password changed successfully. Please sign in again with your new password.'
    });
  } catch (error) {
    console.error('Change owner password failed:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Unable to change password. No changes were applied.'
    });
  }
};

const isValidEmail = email =>
  typeof email === 'string' &&
  email.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

exports.forgotPassword = async (req, res) => {
  const email = typeof req.body?.email === 'string'
    ? req.body.email.trim().toLowerCase()
    : '';
  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: 'Enter a valid email address.'
    });
  }

  try {
    await requestPasswordReset({ email });
    return res.status(200).json({
      success: true,
      message: GENERIC_FORGOT_PASSWORD_MESSAGE
    });
  } catch (error) {
    console.error('Password reset request failed:', error.code || 'INTERNAL_ERROR');
    const configurationError = [
      'SMTP_NOT_CONFIGURED',
      'RESET_URL_MUST_USE_HTTPS',
      'RESET_URL_INVALID'
    ].includes(error.code);
    return res.status(configurationError ? 503 : 502).json({
      success: false,
      message: configurationError
        ? 'Password reset is not configured securely. Please contact support.'
        : 'We could not send the reset email. Please try again later.'
    });
  }
};

exports.validatePasswordResetToken = async (req, res) => {
  try {
    const reset = await findValidPasswordReset({ token: req.body?.token });
    return res.status(200).json({ success: true, valid: Boolean(reset) });
  } catch (error) {
    console.error('Password reset token validation failed:', error.code || error.name);
    return res.status(503).json({
      success: false,
      message: 'Unable to verify this reset link right now.'
    });
  }
};

exports.resetPassword = async (req, res) => {
  const { token, newPassword, confirmPassword } = req.body || {};
  const passwordError = validateNewPassword(newPassword);
  if (passwordError) {
    return res.status(400).json({ success: false, message: passwordError });
  }
  if (typeof confirmPassword !== 'string' || newPassword !== confirmPassword) {
    return res.status(400).json({
      success: false,
      message: 'New password and confirmation do not match.'
    });
  }
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) {
    return res.status(400).json({
      success: false,
      message: 'This reset link is invalid or expired. Request a new link.'
    });
  }

  try {
    const result = await resetOwnerPassword({ token, newPassword });
    if (result.error === 'RESET_TOKEN_INVALID') {
      return res.status(400).json({
        success: false,
        message: 'This reset link is invalid, expired, or already used. Request a new link.'
      });
    }
    if (result.error) {
      return res.status(400).json({ success: false, message: result.message });
    }
    return res.status(200).json({
      success: true,
      message: 'Password reset successfully. Sign in with your new password.'
    });
  } catch (error) {
    console.error('Password reset failed:', error.code || error.name);
    return res.status(500).json({
      success: false,
      message: 'Unable to reset your password. Request a new reset link and try again.'
    });
  }
};