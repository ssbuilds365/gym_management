const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Member = require('../models/Member');
const BiometricCredential = require('../models/BiometricCredential');
const KioskCredential = require('../models/KioskCredential');
const Business = require('../models/Business');
const { hashKioskSecret } = require('../utils/kioskCredentialSecret');
const config = require('../config/env');
const faceRecognition = require('../services/faceRecognition');
const {
  FACE_MODEL_VERSION,
  BiometricIdentityError,
  enrollFaceTemplate,
  getActiveCredentials,
  findDuplicateIdentityGroups,
  revokeFaceTemplates
} = require('../services/biometricIdentity');

const DUPLICATE_FACE_MESSAGE =
  'This face is already registered with another member. Please contact gym staff.';

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
  }).sort({ updatedAt: -1 }).select('registrationStatus modelVersion consentStatus consentAt consentTextVersion registeredAt updatedAt');
  if (!credential) {
    return res.json({ success: true, status: 'NotRegistered', registeredAt: null });
  }
  if (credential.modelVersion !== FACE_MODEL_VERSION) {
    return res.json({
      success: true,
      status: 'MigrationRequired',
      registeredAt: credential.registeredAt,
      updatedAt: credential.updatedAt
    });
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
    if (!requireGymAdministrator(req, res)) return;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid member ID.' });
    }
    const { images, consentGranted, consentTextVersion } = req.body || {};
    if (
      !Array.isArray(images) ||
      images.length !== 3 ||
      images.some(image => typeof image !== 'string')
    ) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_FACE_IMAGES',
        message: 'Three valid camera samples are required for face registration.'
      });
    }
    if (consentGranted !== true) {
      return res.status(400).json({ success: false, message: 'Informed member consent is required.' });
    }
    const normalizedConsentVersion = String(consentTextVersion || '').trim();
    if (!normalizedConsentVersion || normalizedConsentVersion.length > 100) {
      return res.status(400).json({ success: false, message: 'Consent text version is required.' });
    }
    const member = await Member.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      deletedAt: null,
      status: 'Active'
    });
    if (!member) return res.status(404).json({ success: false, message: 'Active member not found.' });

    const descriptor = await faceRecognition.descriptorFromImages(images);
    const outcome = await enrollFaceTemplate({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      memberId: member._id,
      descriptor,
      consentTextVersion: normalizedConsentVersion,
      createdBy: req.owner._id,
      replaceExisting: req.body?.replaceExisting === true
    });
    if (outcome.status === 'duplicate-face') {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_FACE_DETECTED',
        message: DUPLICATE_FACE_MESSAGE
      });
    }
    if (outcome.status === 'already-registered') {
      return res.status(409).json({
        success: false,
        code: 'FACE_ALREADY_REGISTERED',
        message: 'This member already has a registered face. Confirm an authorized replacement to continue.'
      });
    }
    if (outcome.status === 'migration-required') {
      return res.status(409).json({
        success: false,
        code: 'FACE_REREGISTRATION_REQUIRED',
        message: 'This member must be re-enrolled with the current face recognition model.'
      });
    }
    return res.status(201).json({
      success: true,
      message: 'Face registration saved securely.',
      status: 'Registered',
      modelVersion: FACE_MODEL_VERSION
    });
  } catch (error) {
    if (error instanceof BiometricIdentityError) {
      const message = error.code === 'MEMBER_NOT_FOUND'
        ? 'Active member not found.'
        : error.code === 'INVALID_FACE_DESCRIPTOR'
          ? 'A valid 128-value face template is required.'
          : error.code === 'BIOMETRIC_ENCRYPTION_UNAVAILABLE'
            ? 'Face registration is temporarily unavailable. Please contact gym staff.'
            : error.code === 'BIOMETRIC_SAVE_FAILED'
              ? 'Face registration could not be saved. Please retry.'
              : 'Biometric service is temporarily unavailable. Please contact gym staff.';
      return res.status(error.status).json({
        success: false,
        code: error.code,
        message
      });
    }
    if (error instanceof faceRecognition.FaceRecognitionError) {
      const message = error.code === 'BIOMETRIC_RECOGNITION_UNAVAILABLE'
        ? 'Face registration is temporarily unavailable. Please contact gym staff.'
        : error.code === 'NO_FACE' || error.code === 'MULTIPLE_FACES' || error.code === 'FACE_TOO_SMALL'
          ? 'Unable to process face. Please try again.'
          : error.code === 'INVALID_FACE_IMAGES' || error.code === 'INVALID_FACE_IMAGE'
            ? 'Unable to process face. Please try again.'
            : 'Face registration is temporarily unavailable. Please contact gym staff.';
      return res.status(error.status).json({
        success: false,
        code: error.code,
        message
      });
    }
    if (error?.code === 20 || /transaction numbers are only allowed/i.test(String(error?.message || ''))) {
      return res.status(503).json({
        success: false,
        code: 'BIOMETRIC_TRANSACTION_REQUIRED',
        message: 'Face registration is temporarily unavailable. Please contact gym staff.'
      });
    }
    console.error('Face registration failed:', { code: error?.code || 'BIOMETRIC_ERROR' });
    return res.status(503).json({
      success: false,
      code: 'BIOMETRIC_SERVICE_UNAVAILABLE',
      message: 'Face registration is temporarily unavailable. Please contact gym staff.'
    });
  }
};

exports.removeFace = async (req, res) => {
  if (!requireGymAdministrator(req, res)) return;
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
  try {
    const result = await revokeFaceTemplates(
      req.tenantId,
      req.owner.businessId,
      member._id,
      req.owner._id
    );
    return res.json({
      success: true,
      message: 'Face registration removed.',
      removed: result.modifiedCount > 0
    });
  } catch (error) {
    if (error?.code === 20 || /transaction numbers are only allowed/i.test(String(error?.message || ''))) {
      return res.status(503).json({
        success: false,
        code: 'BIOMETRIC_TRANSACTION_REQUIRED',
        message: 'Face removal is temporarily unavailable. Please contact gym staff.'
      });
    }
    console.error('Face removal failed:', { code: error?.code || 'BIOMETRIC_ERROR' });
    return res.status(503).json({
      success: false,
      code: 'BIOMETRIC_SERVICE_UNAVAILABLE',
      message: 'Face removal is temporarily unavailable. Please contact gym staff.'
    });
  }
};

exports.getFaceDuplicateReport = async (req, res) => {
  if (!requireGymAdministrator(req, res)) return;
  if (!config.biometricTemplateKeyConfigured) {
    return res.status(503).json({
      success: false,
      code: 'BIOMETRIC_ENCRYPTION_UNAVAILABLE',
      message: 'The biometric diagnostic service is temporarily unavailable.'
    });
  }
  try {
    const records = await getActiveCredentials(
      req.tenantId,
      req.owner.businessId,
      undefined,
      false
    );
    const groups = findDuplicateIdentityGroups(records);
    return res.json({
      success: true,
      status: groups.length ? 'REVIEW_REQUIRED' : 'NO_DUPLICATES_FOUND',
      groups,
      scannedTemplateCount: records.length,
      migrationRequiredCount: await BiometricCredential.countDocuments({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        biometricType: 'Face',
        registrationStatus: 'Active',
        modelVersion: { $ne: FACE_MODEL_VERSION }
      })
    });
  } catch (error) {
    if (error instanceof BiometricIdentityError) {
      return res.status(error.status).json({
        success: false,
        code: error.code,
        message: 'The biometric diagnostic service could not verify stored templates.'
      });
    }
    console.error('Biometric duplicate diagnostic failed:', { code: error?.code || 'BIOMETRIC_ERROR' });
    return res.status(503).json({
      success: false,
      code: 'BIOMETRIC_SERVICE_UNAVAILABLE',
      message: 'The biometric diagnostic service is temporarily unavailable.'
    });
  }
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
