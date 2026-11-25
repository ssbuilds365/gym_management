const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const KioskCredential = require('../models/KioskCredential');
const KioskSession = require('../models/KioskSession');
const config = require('../config/env');

const KIOSK_TOKEN_SECRET = config.kioskTokenSecret;
const kioskTokenSecretConfigured = config.kioskTokenSecretConfigured;

const signKioskToken = (credential, sessionId) => jwt.sign(
  {
    purpose: 'attendance-kiosk',
    tenantId: String(credential.tenantId),
    businessId: String(credential.businessId),
    credentialId: credential.credentialId,
    sessionId: String(sessionId)
  },
  KIOSK_TOKEN_SECRET,
  { expiresIn: '15m', issuer: 'ss-fitness-manager' }
);

const protectKiosk = async (req, res, next) => {
  if (!kioskTokenSecretConfigured) {
    return res.status(503).json({
      success: false,
      code: 'KIOSK_AUTH_UNAVAILABLE',
      message: 'Kiosk authorization is not configured. Set KIOSK_TOKEN_SECRET to a value at least 32 characters long on the backend.'
    });
  }
  const authorization = String(req.headers.authorization || '');
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) {
    return res.status(401).json({
      success: false,
      code: 'KIOSK_TOKEN_REQUIRED',
      message: 'Kiosk authorization is required.'
    });
  }
  try {
    const payload = jwt.verify(token, KIOSK_TOKEN_SECRET, {
      issuer: 'ss-fitness-manager'
    });
    if (payload.purpose !== 'attendance-kiosk') throw new Error('Invalid kiosk purpose');
    if (!mongoose.Types.ObjectId.isValid(payload.sessionId)) {
      throw new Error('Invalid kiosk session');
    }
    const session = await KioskSession.findOne({
      _id: payload.sessionId,
      credentialId: payload.credentialId,
      tenantId: payload.tenantId,
      businessId: payload.businessId,
      revokedAt: null,
      expiresAt: { $gt: new Date() }
    }).select('_id');
    if (!session) throw new Error('Kiosk session is no longer active');
    const credential = await KioskCredential.findOne({
      credentialId: payload.credentialId,
      tenantId: payload.tenantId,
      businessId: payload.businessId,
      active: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      revokedAt: null
    }).select('_id tenantId businessId credentialId createdBy');
    if (!credential) throw new Error('Kiosk credential is no longer active');
    req.kiosk = {
      credentialId: credential.credentialId,
      tenantId: credential.tenantId,
      businessId: credential.businessId,
      sessionId: session._id,
      createdBy: credential.createdBy
    };
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      code: 'KIOSK_TOKEN_INVALID',
      message: 'Kiosk authorization is invalid or expired.'
    });
  }
};

module.exports = { signKioskToken, protectKiosk, KIOSK_TOKEN_SECRET };
