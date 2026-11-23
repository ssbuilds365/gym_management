const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Member = require('../models/Member');
const BiometricCredential = require('../models/BiometricCredential');
const KioskCredential = require('../models/KioskCredential');
const Business = require('../models/Business');
const { encryptTemplate } = require('../utils/biometricTemplateEncryption');
const { hashKioskSecret } = require('../utils/kioskCredentialSecret');
const config = require('../config/env');

const requireGymAdministrator = (req, res) => {
  if (!req.owner || req.owner.role !== 'owner' || req.owner.tenantId.toString() !== req.tenantId.toString()) {
    res.status(403).json({
      success: false,
      code: 'KIOSK_ADMIN_REQUIRED',
      message: 'Only the gym administrator may manage kiosk credentials.'
    });
    return false;
  }
  return true;
};

exports.getFaceStatus = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid member ID.' });
  }
  const member = await Member.findOne({
    _id: req.params.id,
    tenantId: req.tenantId,
    businessId: req.owner.businessId,
    deletedAt: null
  }).select('_id');
  if (!member) return res.status(404).json({ success: false, message: 'Member not found.' });
  const credential = await BiometricCredential.findOne({
    tenantId: req.tenantId,
    businessId: req.owner.businessId,
    memberId: member._id,
    biometricType: 'Face',
    registrationStatus: 'Active',
    consentStatus: 'Granted'
  }).sort({ updatedAt: -1 }).select('registrationStatus consentStatus consentAt consentTextVersion registeredAt updatedAt');
  if (!credential) {
    return res.json({ success: true, status: 'NotRegistered', registeredAt: null });
  }
  return res.json({
    success: true,
    status: 'Registered',
    registeredAt: credential.registeredAt,
    updatedAt: credential.updatedAt,
    consentStatus: credential.consentStatus,
    consentAt: credential.consentAt,
    consentTextVersion: credential.consentTextVersion
  });
};

exports.registerFace = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid member ID.' });
    }
    const { descriptor, modelVersion, consentGranted, consentTextVersion } = req.body || {};
    if (
      !Array.isArray(descriptor) ||
      descriptor.length !== 128 ||
      descriptor.some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 2)
    ) {
      return res.status(400).json({ success: false, message: 'A valid 128-value face template is required.' });
    }
    if (consentGranted !== true) {
      return res.status(400).json({ success: false, message: 'Informed member consent is required.' });
    }
    const normalizedConsentVersion = String(consentTextVersion || '').trim();
    if (!normalizedConsentVersion || normalizedConsentVersion.length > 100) {
      return res.status(400).json({ success: false, message: 'Consent text version is required.' });
    }
    const normalizedModelVersion = String(modelVersion || '').trim();
    if (!normalizedModelVersion || normalizedModelVersion.length > 100) {
      return res.status(400).json({ success: false, message: 'Recognition model version is required.' });
    }
    const member = await Member.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      deletedAt: null,
      status: 'Active'
    });
    if (!member) return res.status(404).json({ success: false, message: 'Active member not found.' });

    const encryptedTemplate = encryptTemplate({
      descriptor,
      modelVersion: normalizedModelVersion
    });
    await BiometricCredential.findOneAndUpdate(
      {
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        memberId: member._id,
        biometricType: 'Face'
      },
      {
        $set: {
          encryptedTemplate,
          modelVersion: normalizedModelVersion,
          registrationStatus: 'Active',
          consentStatus: 'Granted',
          consentTextVersion: normalizedConsentVersion,
          consentAt: new Date(),
          registeredAt: new Date(),
          createdBy: req.owner._id,
          revokedAt: null,
          revokedBy: null
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return res.status(201).json({
      success: true,
      message: 'Face registration saved securely.',
      status: 'Registered',
      modelVersion: normalizedModelVersion
    });
  } catch (error) {
    console.error('Face registration error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to save face registration.' });
  }
};

exports.removeFace = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid member ID.' });
  }
  const member = await Member.findOne({
    _id: req.params.id,
    tenantId: req.tenantId,
    businessId: req.owner.businessId,
    deletedAt: null
  }).select('_id');
  if (!member) return res.status(404).json({ success: false, message: 'Member not found.' });
  const result = await BiometricCredential.updateMany({
    tenantId: req.tenantId,
    businessId: req.owner.businessId,
    memberId: member._id,
    biometricType: 'Face',
    registrationStatus: 'Active'
  }, {
    $set: {
      registrationStatus: 'Revoked',
      consentStatus: 'Withdrawn',
      revokedAt: new Date(),
      revokedBy: req.owner._id
    },
    $unset: { encryptedTemplate: 1 }
  });
  return res.json({
    success: true,
    message: 'Face registration removed.',
    removed: result.modifiedCount > 0
  });
};

exports.createKioskCredential = async (req, res) => {
  try {
    if (!requireGymAdministrator(req, res)) return;
    if (!config.kioskTokenSecretConfigured) {
      return res.status(503).json({
        success: false,
        code: 'KIOSK_AUTH_UNAVAILABLE',
        message: 'Configure KIOSK_TOKEN_SECRET on the backend before creating kiosk credentials.'
      });
    }
    const label = String(req.body?.label || '').trim();
    if (!label) return res.status(400).json({ success: false, message: 'Kiosk label is required.' });
    const credentialId = `kiosk_${crypto.randomBytes(12).toString('hex')}`;
    const secret = crypto.randomBytes(32).toString('base64url');
    await KioskCredential.create({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      label,
      credentialId,
      secretHash: hashKioskSecret(secret),
      active: true,
      createdBy: req.owner._id,
      expiresAt: null
    });
    return res.status(201).json({
      success: true,
      credential: { credentialId, label, secret },
      message: 'Store this kiosk secret securely. It will not be shown again.'
    });
  } catch (error) {
    console.error('Kiosk credential creation error:', error);
    return res.status(500).json({ success: false, message: 'Unable to create kiosk credential.' });
  }
};

exports.listKioskCredentials = async (req, res) => {
  if (!requireGymAdministrator(req, res)) return;
  const credentials = await KioskCredential.find({
    tenantId: req.tenantId,
    businessId: req.owner.businessId
  }).sort({ createdAt: -1 }).select('credentialId label active expiresAt lastUsedAt revokedAt createdAt');
  return res.json({ success: true, credentials });
};

exports.rotateKioskCredential = async (req, res) => {
  try {
    if (!requireGymAdministrator(req, res)) return;
    if (!config.kioskTokenSecretConfigured) {
      return res.status(503).json({
        success: false,
        code: 'KIOSK_AUTH_UNAVAILABLE',
        message: 'Configure KIOSK_TOKEN_SECRET on the backend before rotating kiosk credentials.'
      });
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid credential ID.' });
    }
    const existing = await KioskCredential.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
      businessId: req.owner.businessId
    });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Kiosk credential not found.' });
    }
    const label = String(req.body?.label || existing.label).trim();
    if (!label) return res.status(400).json({ success: false, message: 'Kiosk label is required.' });
    const credentialId = `kiosk_${crypto.randomBytes(12).toString('hex')}`;
    const secret = crypto.randomBytes(32).toString('base64url');
    await KioskCredential.create({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      label,
      credentialId,
      secretHash: hashKioskSecret(secret),
      active: true,
      createdBy: req.owner._id,
      expiresAt: null
    });
    existing.active = false;
    existing.revokedAt = new Date();
    await existing.save();
    return res.status(201).json({
      success: true,
      credential: { credentialId, label, secret },
      message: 'Credential rotated. The previous credential is revoked and the secret is shown only once.'
    });
  } catch (error) {
    console.error('Kiosk credential rotation error:', error);
    return res.status(500).json({ success: false, message: 'Unable to rotate kiosk credential.' });
  }
};

exports.revokeKioskCredential = async (req, res) => {
  if (!requireGymAdministrator(req, res)) return;
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: 'Invalid credential ID.' });
  }
  const credential = await KioskCredential.findOneAndUpdate({
    _id: req.params.id,
    tenantId: req.tenantId,
    businessId: req.owner.businessId
  }, { $set: { active: false, revokedAt: new Date() } }, { new: true });
  if (!credential) return res.status(404).json({ success: false, message: 'Kiosk credential not found.' });
  return res.json({ success: true, message: 'Kiosk credential revoked.' });
};
