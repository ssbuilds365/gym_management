const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const Business = require('../models/Business');
const Member = require('../models/Member');
const MemberMembership = require('../models/MemberMembership');
const Attendance = require('../models/Attendance');
const KioskCredential = require('../models/KioskCredential');
const KioskSession = require('../models/KioskSession');
const BiometricCredential = require('../models/BiometricCredential');
const {
  BiometricIdentityError,
  enrollFaceTemplate,
  withBiometricGymLock,
  getActiveCredentials,
  compareFaceDescriptor
} = require('../services/biometricIdentity');
const { signKioskToken, KIOSK_TOKEN_SECRET } = require('../middleware/kioskAuthMiddleware');
const { verifyKioskSecret } = require('../utils/kioskCredentialSecret');
const config = require('../config/env');
const faceRecognition = require('../services/faceRecognition');
const { getAttendanceDayBounds } = require('../utils/attendanceDates');
const { getMembershipExpiryWindow, isValidTimeZone } = require('../utils/membershipExpiry');

const getKioskCapabilities = business => {
  const faceServiceReady = Boolean(
    config.biometricTemplateKeyConfigured && faceRecognition.isReady()
  );
  return {
    faceAttendanceEnabled: Boolean(business?.faceAttendanceEnabled && faceServiceReady),
    faceEnrollmentEnabled: false,
    faceEnrollmentRequiresStaff: Boolean(business && faceServiceReady),
    qrAttendanceEnabled: Boolean(business?.qrAttendanceEnabled)
  };
};

exports.getKioskCapabilities = getKioskCapabilities;

exports.identifyMemberForEnrollment = async (req, res) => {
  return res.status(403).json({
    success: false,
    code: 'STAFF_ENROLLMENT_REQUIRED',
    message: 'Face registration must be completed by gym staff after verifying the member.'
  });
};

exports.enrollMemberFace = async (req, res) => {
  let stage = 'validation';
  try {
    const images = req.body?.images;
    const enrollmentToken = String(req.body?.enrollmentToken || '');
    const consentGranted = req.body?.consentGranted === true;
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
    if (!consentGranted) {
      return res.status(400).json({ success: false, code: 'CONSENT_REQUIRED', message: 'Explicit member consent is required.' });
    }
    let enrollment;
    try {
      enrollment = jwt.verify(enrollmentToken, KIOSK_TOKEN_SECRET, { issuer: 'ss-fitness-manager' });
    } catch {
      return res.status(401).json({ success: false, code: 'ENROLLMENT_TOKEN_INVALID', message: 'Face enrollment authorization expired. Start again.' });
    }
    if (
      enrollment.purpose !== 'face-enrollment' ||
      !mongoose.Types.ObjectId.isValid(enrollment.memberId) ||
      enrollment.tenantId !== String(req.kiosk.tenantId) ||
      enrollment.businessId !== String(req.kiosk.businessId) ||
      enrollment.credentialId !== req.kiosk.credentialId
    ) {
      return res.status(401).json({ success: false, code: 'ENROLLMENT_TOKEN_INVALID', message: 'Face enrollment authorization is invalid.' });
    }
    if (!config.biometricTemplateKeyConfigured) {
      return res.status(503).json({
        success: false,
        code: 'BIOMETRIC_ENCRYPTION_UNAVAILABLE',
        message: 'Face registration is temporarily unavailable. Please contact gym staff.'
      });
    }
    stage = 'identity-check';
    const descriptor = await faceRecognition.descriptorFromImages(images);
    const outcome = await enrollFaceTemplate({
      tenantId: req.kiosk.tenantId,
      businessId: req.kiosk.businessId,
      memberId: enrollment.memberId,
      descriptor,
      consentTextVersion: 'kiosk-face-consent-v2',
      createdBy: req.kiosk.createdBy || null
    });
    if (outcome.status === 'duplicate-face') {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_FACE_DETECTED',
        message: 'This face is already registered with another member. Please contact gym staff.'
      });
    }
    if (outcome.status === 'already-registered') {
      return res.status(409).json({
        success: false,
        code: 'FACE_ALREADY_REGISTERED',
        message: 'This member already has a registered face. Please contact gym staff.'
      });
    }
    if (outcome.status === 'migration-required') {
      return res.status(409).json({
        success: false,
        code: 'FACE_REREGISTRATION_REQUIRED',
        message: 'Face registration must be completed by gym staff using the current recognition model.'
      });
    }
    return res.status(201).json({
      success: true,
      code: 'FACE_REGISTERED',
      message: 'FACE REGISTERED SUCCESSFULLY'
    });
  } catch (error) {
    if (error instanceof BiometricIdentityError) {
      const message = error.code === 'MEMBER_NOT_FOUND'
        ? 'Member not found.'
        : error.code === 'INVALID_FACE_DESCRIPTOR' || error.code === 'INVALID_FACE_IMAGE'
          ? 'Unable to process face. Please try again.'
          : error.code === 'BIOMETRIC_ENCRYPTION_UNAVAILABLE'
            ? 'Face registration is temporarily unavailable. Please contact gym staff.'
            : 'Face registration is temporarily unavailable. Please contact gym staff.';
      return res.status(error.status).json({
        success: false,
        code: error.code,
        message
      });
    }
    if (error instanceof faceRecognition.FaceRecognitionError) {
      const message = error.code === 'NO_FACE' || error.code === 'MULTIPLE_FACES' || error.code === 'FACE_TOO_SMALL'
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
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        code: 'FACE_ALREADY_REGISTERED',
        message: 'This member already has a registered face. Please contact gym staff.'
      });
    }
    if (error?.code === 20 || /transaction numbers are only allowed/i.test(String(error?.message || ''))) {
      return res.status(503).json({
        success: false,
        code: 'BIOMETRIC_TRANSACTION_REQUIRED',
        message: 'Face registration is temporarily unavailable. Please contact gym staff.'
      });
    }
    console.error('Kiosk face enrollment failed:', {
      stage,
      code: error?.code || 'BIOMETRIC_ERROR'
    });
    return res.status(503).json({
      success: false,
      code: 'BIOMETRIC_SERVICE_UNAVAILABLE',
      message: 'Face registration is temporarily unavailable. Please contact gym staff.'
    });
  }
};

const hashRefreshToken = token =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

const createRefreshSession = async credential => {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  try {
    await KioskSession.create({
      tenantId: credential.tenantId,
      businessId: credential.businessId,
      credentialId: credential.credentialId,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      lastUsedAt: new Date()
    });
  } catch (error) {
    if (error?.name === 'ValidationError') return null;
    throw error;
  }
  return refreshToken;
};

exports.authenticateKiosk = async (req, res) => {
  try {
    if (!config.kioskTokenSecretConfigured) {
      return res.status(503).json({
        success: false,
        code: 'KIOSK_AUTH_UNAVAILABLE',
        message: 'Kiosk authorization is not configured. Set KIOSK_TOKEN_SECRET to a value at least 32 characters long on the backend.'
      });
    }
    const credentialId = String(req.body?.credentialId || '').trim();
    const kioskSecret = String(req.body?.kioskSecret || '');
    if (!credentialId || !kioskSecret) {
      return res.status(400).json({ success: false, code: 'KIOSK_CREDENTIAL_REQUIRED', message: 'Credential ID and secret are required.' });
    }
    const credential = await KioskCredential.findOne({
      credentialId,
      active: true,
      revokedAt: null,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
    }).select('+secretHash');
    if (!credential) {
      return res.status(401).json({ success: false, code: 'KIOSK_AUTH_INVALID', message: 'Invalid kiosk credentials.' });
    }
    if (!verifyKioskSecret(kioskSecret, credential.secretHash)) {
      return res.status(401).json({ success: false, code: 'KIOSK_AUTH_INVALID', message: 'Invalid kiosk credentials.' });
    }
    await KioskCredential.updateOne({ _id: credential._id }, { $set: { lastUsedAt: new Date() } });
    const token = signKioskToken(credential);
    const refreshToken = await createRefreshSession(credential);
    const business = await Business.findById(credential.tenantId).select('businessName logoUrl faceAttendanceEnabled qrAttendanceEnabled timeZone');
    return res.json({
      success: true,
      token,
      refreshToken,
      expiresInSeconds: 900,
      gym: {
        id: String(credential.businessId),
        name: business?.businessName || 'Gym',
        logoUrl: business?.logoUrl || '',
        ...getKioskCapabilities(business)
      }
    });
  } catch (error) {
    console.error('Kiosk authentication error:', error);
    return res.status(500).json({ success: false, message: 'Unable to authorize kiosk.' });
  }
};

exports.renewKiosk = async (req, res) => {
  try {
    if (!config.kioskTokenSecretConfigured) {
      return res.status(503).json({
        success: false,
        code: 'KIOSK_AUTH_UNAVAILABLE',
        message: 'Kiosk authorization is not configured.'
      });
    }
    const refreshToken = String(req.body?.refreshToken || '').trim();
    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        code: 'KIOSK_REFRESH_REQUIRED',
        message: 'Persistent kiosk authorization is required.'
      });
    }
    const session = await KioskSession.findOne({
      refreshTokenHash: hashRefreshToken(refreshToken),
      revokedAt: null,
      expiresAt: { $gt: new Date() }
    }).select('+refreshTokenHash');
    if (!session) {
      return res.status(401).json({
        success: false,
        code: 'KIOSK_REFRESH_INVALID',
        message: 'Persistent kiosk authorization is invalid or expired.'
      });
    }
    const credential = await KioskCredential.findOne({
      credentialId: session.credentialId,
      tenantId: session.tenantId,
      businessId: session.businessId,
      active: true,
      revokedAt: null,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
    });
    if (!credential) {
      await KioskSession.updateMany({
        credentialId: session.credentialId,
        tenantId: session.tenantId,
        businessId: session.businessId,
        revokedAt: null
      }, { $set: { revokedAt: new Date() } });
      return res.status(401).json({
        success: false,
        code: 'KIOSK_CREDENTIAL_REVOKED',
        message: 'The kiosk credential has been revoked.'
      });
    }

    session.revokedAt = new Date();
    await session.save();
    const rotatedRefreshToken = await createRefreshSession(credential);
    const token = signKioskToken(credential);
    await KioskCredential.updateOne({ _id: credential._id }, { $set: { lastUsedAt: new Date() } });
    return res.json({
      success: true,
      token,
      refreshToken: rotatedRefreshToken,
      expiresInSeconds: 900
    });
  } catch (error) {
    console.error('Kiosk renewal error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to renew kiosk authorization.' });
  }
};

exports.lockKiosk = async (req, res) => {
  const refreshToken = String(req.body?.refreshToken || '').trim();
  if (refreshToken) {
    await KioskSession.updateOne(
      { refreshTokenHash: hashRefreshToken(refreshToken), revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
  }
  if (req.kiosk?.credentialId) {
    await KioskSession.updateMany(
      { credentialId: req.kiosk.credentialId, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
  }
  return res.json({ success: true, message: 'Kiosk locked.' });
};

exports.getKioskConfig = async (req, res) => {
  const business = await Business.findById(req.kiosk.tenantId)
    .select('businessName logoUrl faceAttendanceEnabled qrAttendanceEnabled timeZone');
  if (!business) return res.status(404).json({ success: false, message: 'Gym not found.' });
  return res.json({
    success: true,
    gym: {
      id: String(business._id),
      name: business.businessName,
      logoUrl: business.logoUrl || '',
      ...getKioskCapabilities(business),
      timeZone: isValidTimeZone(business.timeZone) ? business.timeZone : 'Asia/Kolkata'
    }
  });
};

exports.identifyFace = async (req, res) => {
  try {
    const image = req.body?.image;
    if (typeof image !== 'string') {
      return res.status(400).json({
        success: false,
        code: 'INVALID_FACE_IMAGE',
        message: 'A valid camera image is required.'
      });
    }
    const business = await Business.findById(req.kiosk.tenantId).select('faceAttendanceEnabled');
    if (!business?.faceAttendanceEnabled) {
      return res.status(403).json({ success: false, code: 'FACE_ATTENDANCE_DISABLED', message: 'Face attendance is disabled for this gym.' });
    }
    if (!config.biometricTemplateKeyConfigured) {
      return res.status(503).json({
        success: false,
        code: 'BIOMETRIC_ENCRYPTION_UNAVAILABLE',
        message: 'Face recognition is temporarily unavailable. Please contact gym staff.'
      });
    }
    const descriptor = await faceRecognition.descriptorFromImage(image);
    const records = await getActiveCredentials(req.kiosk.tenantId, req.kiosk.businessId);
    if (records.length === 0) {
      return res.status(404).json({
        success: false,
        code: 'UNKNOWN_FACE',
        message: 'Face not recognized. Please try again.'
      });
    }
    const comparison = compareFaceDescriptor(descriptor, records);
    if (comparison.status === 'unknown') {
      return res.status(404).json({
        success: false,
        code: 'UNKNOWN_FACE',
        message: 'Face not recognized. Please try again.'
      });
    }
    if (comparison.status === 'duplicate-identity') {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_BIOMETRIC_IDENTITY',
        message: 'Unable to verify identity. Please contact gym staff.'
      });
    }
    if (comparison.status === 'ambiguous') {
      return res.status(409).json({
        success: false,
        code: 'AMBIGUOUS_FACE',
        message: 'Unable to verify identity. Please reposition your face.'
      });
    }
    const best = comparison.best;
    const member = await Member.findOne({
      _id: best.record.memberId,
      tenantId: req.kiosk.tenantId,
      businessId: req.kiosk.businessId,
      deletedAt: null
    }).select('_id fullName status');
    if (!member) {
      return res.status(404).json({ success: false, code: 'MEMBER_NOT_RECOGNIZED', message: 'Member not recognized.' });
    }
    if (member.status !== 'Active') {
      return res.status(403).json({
        success: false,
        code: 'MEMBER_INACTIVE',
        message: 'Member access is inactive or blocked.'
      });
    }
    const matchToken = jwt.sign({
      purpose: 'face-match',
      tenantId: String(req.kiosk.tenantId),
      businessId: String(req.kiosk.businessId),
      credentialId: req.kiosk.credentialId,
      memberId: String(member._id),
      templateId: String(best.record._id)
    }, KIOSK_TOKEN_SECRET, {
      expiresIn: '60s',
      issuer: 'ss-fitness-manager'
    });
    return res.json({
      success: true,
      member: { id: String(member._id), fullName: member.fullName },
      matchConfidence: Number(best.similarity.toFixed(4)),
      matchToken
    });
  } catch (error) {
    if (error instanceof faceRecognition.FaceRecognitionError) {
      const message = error.code === 'NO_FACE'
        ? 'Face not recognized. Please try again.'
        : error.code === 'MULTIPLE_FACES' || error.code === 'FACE_TOO_SMALL'
          ? 'Unable to verify identity. Please reposition your face.'
          : error.code === 'INVALID_FACE_IMAGE'
            ? 'Unable to process face. Please try again.'
            : 'Face recognition is temporarily unavailable. Please contact gym staff.';
      return res.status(error.status).json({
        success: false,
        code: error.code,
        message
      });
    }
    if (error instanceof BiometricIdentityError) {
      return res.status(error.status).json({
        success: false,
        code: error.code,
        message: 'Unable to verify the face. Please try again or contact gym staff.'
      });
    }
    console.error('Face identification failed:', { code: error?.code || 'BIOMETRIC_ERROR' });
    return res.status(503).json({
      success: false,
      code: 'BIOMETRIC_TEMPLATE_UNAVAILABLE',
      message: 'Biometric service is temporarily unavailable.'
    });
  }
};

const validateMembershipAndDuplicate = async (req, memberId) => {
  const member = await Member.findOne({
    _id: memberId,
    tenantId: req.kiosk.tenantId,
    businessId: req.kiosk.businessId,
    deletedAt: null
  });
  if (!member) return { code: 'MEMBER_NOT_FOUND', status: 404, message: 'Active member not found.' };
  if (member.status !== 'Active') {
    return {
      code: 'MEMBER_INACTIVE',
      status: 403,
      message: 'Member access is inactive or blocked.',
      member: { id: String(member._id), fullName: member.fullName }
    };
  }

  const business = await Business.findById(req.kiosk.tenantId).select('timeZone');
  const timeZone = isValidTimeZone(business?.timeZone) ? business.timeZone : 'Asia/Kolkata';
  const now = new Date();
  const expiryWindow = getMembershipExpiryWindow(now, timeZone);
  const membership = await MemberMembership.findOne({
    tenantId: req.kiosk.tenantId,
    businessId: req.kiosk.businessId,
    memberId: member._id,
    status: 'Active',
    startDate: { $lt: expiryWindow.tomorrowStart },
    endDate: { $gte: expiryWindow.todayStart }
  }).sort({ endDate: -1, createdAt: -1 }).populate('planId', 'planName').lean();
  if (!membership) {
    const latestMembership = await MemberMembership.findOne({
      tenantId: req.kiosk.tenantId,
      businessId: req.kiosk.businessId,
      memberId: member._id,
      status: { $in: ['Active', 'Expired'] }
    }).sort({ endDate: -1, createdAt: -1 }).lean();
    return {
      code: 'MEMBERSHIP_EXPIRED',
      status: 409,
      message: 'Membership Expired',
      member: { id: String(member._id), fullName: member.fullName },
      expiryDate: latestMembership?.endDate || null
    };
  }

  const dayStart = getAttendanceDayBounds(now, timeZone).start;
  const existing = await Attendance.findOne({
    tenantId: req.kiosk.tenantId,
    memberId: member._id,
    attendanceDate: dayStart
  }).sort({ checkIn: -1 });
  if (existing) {
    return {
      code: 'ALREADY_CHECKED_IN',
      status: 409,
      message: 'Attendance Already Marked',
      member: { id: String(member._id), fullName: member.fullName },
      checkInTime: existing.checkIn
    };
  }
  return { member, membership, dayStart, now };
};

exports.faceCheckIn = async (req, res) => {
  try {
    const memberId = String(req.body?.memberId || '');
    const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
    const matchToken = String(req.body?.matchToken || '');
    if (!mongoose.Types.ObjectId.isValid(memberId)) {
      return res.status(400).json({ success: false, code: 'INVALID_MEMBER', message: 'Invalid member reference.' });
    }
    if (!idempotencyKey || idempotencyKey.length > 100) {
      return res.status(400).json({ success: false, code: 'INVALID_IDEMPOTENCY_KEY', message: 'An idempotency key is required.' });
    }
    let match;
    try {
      match = jwt.verify(matchToken, KIOSK_TOKEN_SECRET, { issuer: 'ss-fitness-manager' });
    } catch {
      return res.status(401).json({ success: false, code: 'FACE_MATCH_REQUIRED', message: 'A recent face match is required.' });
    }
    if (
      match.purpose !== 'face-match' ||
      match.tenantId !== String(req.kiosk.tenantId) ||
      match.businessId !== String(req.kiosk.businessId) ||
      match.credentialId !== req.kiosk.credentialId ||
      match.memberId !== memberId ||
      !mongoose.Types.ObjectId.isValid(match.templateId)
    ) {
      return res.status(401).json({ success: false, code: 'FACE_MATCH_INVALID', message: 'Face match does not authorize this check-in.' });
    }
    const business = await Business.findById(req.kiosk.tenantId).select('faceAttendanceEnabled');
    if (!business?.faceAttendanceEnabled) {
      return res.status(403).json({ success: false, code: 'FACE_ATTENDANCE_DISABLED', message: 'Face attendance is disabled for this gym.' });
    }
    const registration = await BiometricCredential.findOne({
      _id: match.templateId,
      tenantId: req.kiosk.tenantId,
      businessId: req.kiosk.businessId,
      memberId,
      biometricType: 'Face',
      registrationStatus: 'Active',
      consentStatus: 'Granted'
    }).select('_id');
    if (!registration) {
      return res.status(404).json({ success: false, code: 'MEMBER_NOT_RECOGNIZED', message: 'Member not recognized.' });
    }
    const existingIdempotent = await Attendance.findOne({
      tenantId: req.kiosk.tenantId,
      memberId,
      attendanceType: 'Biometric',
      kioskIdempotencyKey: idempotencyKey
    }).select('checkIn memberId attendanceType');
    if (existingIdempotent) {
      const member = await Member.findById(existingIdempotent.memberId).select('_id fullName');
      return res.status(200).json({
        success: true,
        code: 'ATTENDANCE_SUCCESS',
        message: 'Attendance Marked Successfully',
        member: { id: String(member._id), fullName: member.fullName },
        checkInTime: existingIdempotent.checkIn
      });
    }

    const validation = await validateMembershipAndDuplicate(req, memberId);
    if (validation.code) return res.status(validation.status).json({ success: false, ...validation });

    try {
      const checkInOutcome = await withBiometricGymLock(
        req.kiosk.tenantId,
        req.kiosk.businessId,
        async session => {
          const currentRegistration = await BiometricCredential.findOne({
            _id: match.templateId,
            tenantId: req.kiosk.tenantId,
            businessId: req.kiosk.businessId,
            memberId,
            biometricType: 'Face',
            registrationStatus: 'Active',
            consentStatus: 'Granted'
          }).select('_id').session(session);
          if (!currentRegistration) return { revoked: true };

          const [attendance] = await Attendance.create([{
            tenantId: req.kiosk.tenantId,
            businessId: req.kiosk.businessId,
            memberId: validation.member._id,
            attendanceDate: validation.dayStart,
            checkIn: validation.now,
            attendanceType: 'Biometric',
            status: 'Present',
            notes: 'Face recognition kiosk check-in',
            kioskIdempotencyKey: idempotencyKey,
            createdBy: req.kiosk.createdBy
          }], { session });
          return { attendance };
        }
      );
      if (checkInOutcome.revoked) {
        return res.status(404).json({
          success: false,
          code: 'MEMBER_NOT_RECOGNIZED',
          message: 'Member not recognized.'
        });
      }
      const attendance = checkInOutcome.attendance;
      return res.status(201).json({
        success: true,
        code: 'ATTENDANCE_SUCCESS',
        message: 'Attendance Marked Successfully',
        member: { id: String(validation.member._id), fullName: validation.member.fullName },
        membership: {
          planName: validation.membership?.planId?.planName || 'Membership',
          validUntil: validation.membership?.endDate || null
        },
        checkInTime: attendance.checkIn
      });
    } catch (error) {
      if (error?.code === 11000) {
        const existing = await Attendance.findOne({
          tenantId: req.kiosk.tenantId,
          memberId: memberId,
          attendanceDate: validation.dayStart
        }).sort({ checkIn: -1 });
        return res.status(409).json({
          success: false,
          code: 'ALREADY_CHECKED_IN',
          message: 'You are already checked in today',
          member: { id: String(validation.member._id), fullName: validation.member.fullName },
          checkInTime: existing?.checkIn || validation.now
        });
      }
      throw error;
    }
  } catch (error) {
    if (error?.code === 20 || /transaction numbers are only allowed/i.test(String(error?.message || ''))) {
      return res.status(503).json({
        success: false,
        code: 'BIOMETRIC_TRANSACTION_REQUIRED',
        message: 'Face attendance is temporarily unavailable. Please contact gym staff.'
      });
    }
    console.error('Face check-in failed:', { code: error?.code || 'ATTENDANCE_ERROR' });
    return res.status(503).json({
      success: false,
      code: 'BIOMETRIC_SERVICE_UNAVAILABLE',
      message: 'Face attendance is temporarily unavailable. Please try QR check-in or contact gym staff.'
    });
  }
};

exports.qrCheckIn = async (req, res) => {
  const business = await Business.findById(req.kiosk.tenantId).select('faceAttendanceEnabled qrAttendanceEnabled');
  if (!business?.qrAttendanceEnabled) {
    return res.status(403).json({ success: false, code: 'QR_ATTENDANCE_DISABLED', message: 'QR attendance is disabled.' });
  }
  const qrToken = String(req.body?.qrToken || '');
  if (!qrToken) return res.status(400).json({ success: false, code: 'QR_REQUIRED', message: 'QR token is required.' });
  const tokenHash = crypto.createHash('sha256').update(qrToken).digest('hex');
  const member = await Member.findOne({
    tenantId: req.kiosk.tenantId,
    businessId: req.kiosk.businessId,
    qrTokenHash: tokenHash,
    deletedAt: null,
    status: 'Active'
  });
  if (!member) return res.status(404).json({ success: false, code: 'MEMBER_NOT_FOUND', message: 'Invalid QR code or inactive member.' });
  const validation = await validateMembershipAndDuplicate(req, member._id);
  if (validation.code) return res.status(validation.status).json({ success: false, ...validation });
  try {
    const attendance = await Attendance.create({
      tenantId: req.kiosk.tenantId,
      businessId: req.kiosk.businessId,
      memberId: member._id,
      attendanceDate: validation.dayStart,
      checkIn: validation.now,
      attendanceType: 'QR',
      status: 'Present',
      notes: 'QR kiosk check-in',
      createdBy: req.kiosk.createdBy
    });
    return res.status(201).json({
      success: true,
      code: 'ATTENDANCE_SUCCESS',
      message: 'Attendance Marked Successfully',
      member: { id: String(member._id), fullName: member.fullName },
      membership: {
        planName: validation.membership?.planId?.planName || 'Membership',
        validUntil: validation.membership?.endDate || null
      },
      checkInTime: attendance.checkIn
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, code: 'ALREADY_CHECKED_IN', message: 'You are already checked in today' });
    }
    throw error;
  }
};
