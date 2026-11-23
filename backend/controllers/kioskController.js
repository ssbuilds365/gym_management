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
const { decryptTemplate } = require('../utils/biometricTemplateEncryption');
const { signKioskToken, KIOSK_TOKEN_SECRET } = require('../middleware/kioskAuthMiddleware');
const { verifyKioskSecret } = require('../utils/kioskCredentialSecret');
const config = require('../config/env');
const { getAttendanceDayBounds } = require('../utils/attendanceDates');
const { getMembershipExpiryWindow, isValidTimeZone } = require('../utils/membershipExpiry');

const euclideanDistance = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
};

const normalizeMemberIdentifier = value => String(value || '').trim();
const getPublicMemberId = member =>
  String(member?.legacyMemberId || '').trim() ||
  `MEM${String(member?._id || '').slice(-6).toUpperCase()}`;

exports.identifyMemberForEnrollment = async (req, res) => {
  try {
    const identifier = normalizeMemberIdentifier(req.body?.identifier);
    if (!identifier) {
      return res.status(400).json({
        success: false,
        code: 'MEMBER_IDENTIFIER_REQUIRED',
        message: 'Enter a member ID or registered mobile number.'
      });
    }

    const directMember = mongoose.Types.ObjectId.isValid(identifier)
      ? await Member.findOne({
          _id: identifier,
          tenantId: req.kiosk.tenantId,
          businessId: req.kiosk.businessId,
          deletedAt: null
        }).select('_id fullName status legacyMemberId')
      : null;
    const member = directMember || await Member.findOne({
      tenantId: req.kiosk.tenantId,
      businessId: req.kiosk.businessId,
      deletedAt: null,
      $or: [
        { phone: identifier },
        { legacyMemberId: identifier }
      ]
    }).select('_id fullName status legacyMemberId');

    let resolvedMember = member;
    if (!resolvedMember && identifier.length <= 12) {
      const candidates = await Member.find({
        tenantId: req.kiosk.tenantId,
        businessId: req.kiosk.businessId,
        deletedAt: null
      }).select('_id fullName status legacyMemberId').limit(500);
      resolvedMember = candidates.find(candidate =>
        String(candidate._id).toLowerCase().endsWith(identifier.toLowerCase()) ||
        String(candidate.legacyMemberId || '').toLowerCase() === identifier.toLowerCase()
      );
    }
    if (!resolvedMember) {
      return res.status(404).json({
        success: false,
        code: 'MEMBER_NOT_FOUND',
        message: 'Member Not Found. Please contact gym staff.'
      });
    }
    if (resolvedMember.status !== 'Active') {
      return res.status(403).json({
        success: false,
        code: 'MEMBER_INACTIVE',
        message: 'This member is inactive or blocked. Please contact gym staff.'
      });
    }
    const existing = await BiometricCredential.findOne({
      tenantId: req.kiosk.tenantId,
      businessId: req.kiosk.businessId,
      memberId: resolvedMember._id,
      biometricType: 'Face',
      registrationStatus: 'Active',
      consentStatus: 'Granted'
    }).select('_id');
    if (existing) {
      return res.status(409).json({
        success: false,
        code: 'FACE_ALREADY_REGISTERED',
        message: 'Face Already Registered',
        member: {
          id: String(resolvedMember._id),
          displayId: getPublicMemberId(resolvedMember),
          name: resolvedMember.fullName
        }
      });
    }
    const enrollmentToken = jwt.sign({
      purpose: 'face-enrollment',
      tenantId: String(req.kiosk.tenantId),
      businessId: String(req.kiosk.businessId),
      credentialId: req.kiosk.credentialId,
      memberId: String(resolvedMember._id)
    }, KIOSK_TOKEN_SECRET, {
      expiresIn: '5m',
      issuer: 'ss-fitness-manager'
    });
    return res.json({
      success: true,
      member: {
        id: String(resolvedMember._id),
        displayId: getPublicMemberId(resolvedMember),
        name: resolvedMember.fullName
      },
      enrollmentToken,
      expiresInSeconds: 300
    });
  } catch (error) {
    console.error('Kiosk member enrollment lookup error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to verify the member.' });
  }
};

exports.enrollMemberFace = async (req, res) => {
  try {
    const descriptor = req.body?.descriptor;
    const enrollmentToken = String(req.body?.enrollmentToken || '');
    const consentGranted = req.body?.consentGranted === true;
    if (
      !Array.isArray(descriptor) ||
      descriptor.length !== 128 ||
      descriptor.some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 2)
    ) {
      return res.status(400).json({ success: false, code: 'INVALID_FACE_DESCRIPTOR', message: 'A valid 128-value face template is required.' });
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
      enrollment.tenantId !== String(req.kiosk.tenantId) ||
      enrollment.businessId !== String(req.kiosk.businessId) ||
      enrollment.credentialId !== req.kiosk.credentialId
    ) {
      return res.status(401).json({ success: false, code: 'ENROLLMENT_TOKEN_INVALID', message: 'Face enrollment authorization is invalid.' });
    }
    const member = await Member.findOne({
      _id: enrollment.memberId,
      tenantId: req.kiosk.tenantId,
      businessId: req.kiosk.businessId,
      deletedAt: null,
      status: 'Active'
    }).select('_id');
    if (!member) {
      return res.status(404).json({ success: false, code: 'MEMBER_NOT_FOUND', message: 'Member not found.' });
    }
    const existing = await BiometricCredential.findOne({
      tenantId: req.kiosk.tenantId,
      businessId: req.kiosk.businessId,
      memberId: member._id,
      biometricType: 'Face',
      registrationStatus: 'Active',
      consentStatus: 'Granted'
    }).select('_id');
    if (existing) {
      return res.status(409).json({ success: false, code: 'FACE_ALREADY_REGISTERED', message: 'Face Already Registered' });
    }
    const encryptedTemplate = encryptTemplate({
      descriptor,
      modelVersion: 'face-api.js-v1-128d'
    });
    await BiometricCredential.create({
      tenantId: req.kiosk.tenantId,
      businessId: req.kiosk.businessId,
      memberId: member._id,
      biometricType: 'Face',
      encryptedTemplate,
      modelVersion: 'face-api.js-v1-128d',
      registrationStatus: 'Active',
      consentStatus: 'Granted',
      consentTextVersion: 'kiosk-face-consent-v1',
      consentAt: new Date(),
      registeredAt: new Date(),
      createdBy: req.kiosk.createdBy || null
    });
    return res.status(201).json({
      success: true,
      code: 'FACE_REGISTERED',
      message: 'FACE REGISTERED SUCCESSFULLY'
    });
  } catch (error) {
    console.error('Kiosk face enrollment error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to save face registration.' });
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
        faceAttendanceEnabled: Boolean(business?.faceAttendanceEnabled),
        qrAttendanceEnabled: Boolean(business?.qrAttendanceEnabled)
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
      faceAttendanceEnabled: Boolean(business.faceAttendanceEnabled),
      qrAttendanceEnabled: Boolean(business.qrAttendanceEnabled),
      timeZone: isValidTimeZone(business.timeZone) ? business.timeZone : 'Asia/Kolkata'
    }
  });
};

exports.identifyFace = async (req, res) => {
  try {
    const descriptor = req.body?.descriptor;
    if (
      !Array.isArray(descriptor) ||
      descriptor.length !== 128 ||
      descriptor.some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 2)
    ) {
      return res.status(400).json({ success: false, code: 'INVALID_FACE_DESCRIPTOR', message: 'A valid face template is required.' });
    }
    const business = await Business.findById(req.kiosk.tenantId).select('faceAttendanceEnabled');
    if (!business?.faceAttendanceEnabled) {
      return res.status(403).json({ success: false, code: 'FACE_ATTENDANCE_DISABLED', message: 'Face attendance is disabled for this gym.' });
    }
    const records = await BiometricCredential.find({
      tenantId: req.kiosk.tenantId,
      businessId: req.kiosk.businessId,
      biometricType: 'Face',
      registrationStatus: 'Active',
      consentStatus: 'Granted'
    }).select('+encryptedTemplate.ciphertext +encryptedTemplate.iv +encryptedTemplate.authTag');
    if (records.length === 0) {
      return res.status(404).json({
        success: false,
        code: 'FACE_NOT_REGISTERED',
        message: 'Your face is not registered. Please use Register Face or contact gym staff.'
      });
    }
    let best = null;
    for (const record of records) {
      try {
        const template = decryptTemplate(record.encryptedTemplate);
        const registeredDescriptor = template.descriptor;
        if (!Array.isArray(registeredDescriptor) || registeredDescriptor.length !== descriptor.length) continue;
        const distance = euclideanDistance(descriptor, registeredDescriptor);
        if (!best || distance < best.distance) best = { record, distance };
      } catch (error) {
        console.error('Unable to decrypt biometric template:', error.message);
      }
    }
    if (!best || best.distance > 0.45) {
      return res.status(404).json({ success: false, code: 'MEMBER_NOT_RECOGNIZED', message: 'Member not recognized.' });
    }
    const member = await Member.findOne({
      _id: best.record.memberId,
      tenantId: req.kiosk.tenantId,
      businessId: req.kiosk.businessId,
      deletedAt: null
    }).select('_id fullName phone status');
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
      memberId: String(member._id)
    }, KIOSK_TOKEN_SECRET, {
      expiresIn: '60s',
      issuer: 'ss-fitness-manager'
    });
    return res.json({
      success: true,
      member: { id: String(member._id), fullName: member.fullName, phone: member.phone },
      matchConfidence: Number((1 - Math.min(best.distance, 1)).toFixed(4)),
      matchToken
    });
  } catch (error) {
    console.error('Face identification error:', error);
    return res.status(500).json({ success: false, message: 'Unable to verify face.' });
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
      match.memberId !== memberId
    ) {
      return res.status(401).json({ success: false, code: 'FACE_MATCH_INVALID', message: 'Face match does not authorize this check-in.' });
    }
    const business = await Business.findById(req.kiosk.tenantId).select('faceAttendanceEnabled');
    if (!business?.faceAttendanceEnabled) {
      return res.status(403).json({ success: false, code: 'FACE_ATTENDANCE_DISABLED', message: 'Face attendance is disabled for this gym.' });
    }
    const registration = await BiometricCredential.findOne({
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
      const attendance = await Attendance.create({
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
      });
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
    console.error('Face check-in error:', error);
    return res.status(500).json({ success: false, message: 'Unable to mark attendance.' });
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
