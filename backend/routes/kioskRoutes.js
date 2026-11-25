const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const {
  authenticateKiosk,
  getKioskConfig,
  identifyFace,
  faceCheckIn,
  qrCheckIn,
  renewKiosk,
  lockKiosk,
  identifyMemberForEnrollment,
  enrollMemberFace
} = require('../controllers/kioskController');
const { registerFace } = require('../controllers/biometricController');
const { protectKiosk } = require('../middleware/kioskAuthMiddleware');
const { protectOwner } = require('../middleware/authMiddleware');
const requireKioskGymOwner = require('../middleware/kioskStaffAuthorization');

const kioskAuthRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

const kioskOperationRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

const kioskEnrollmentRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

const kioskFaceIdentifyRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

router.post('/auth', kioskAuthRateLimit, authenticateKiosk);
router.post('/renew', kioskAuthRateLimit, renewKiosk);
router.post('/lock', kioskOperationRateLimit, lockKiosk);
router.post('/enrollment/identify-member', kioskEnrollmentRateLimit, protectKiosk, identifyMemberForEnrollment);
router.post('/enrollment/face', kioskEnrollmentRateLimit, protectKiosk, enrollMemberFace);
router.post(
  '/staff/enrollment/face/:id',
  kioskEnrollmentRateLimit,
  protectKiosk,
  protectOwner,
  requireKioskGymOwner,
  registerFace
);
router.get('/config', kioskOperationRateLimit, protectKiosk, getKioskConfig);
router.post('/face/identify', kioskFaceIdentifyRateLimit, protectKiosk, identifyFace);
router.post('/attendance/check-in', kioskOperationRateLimit, protectKiosk, faceCheckIn);
router.post('/qr/check-in', kioskOperationRateLimit, protectKiosk, qrCheckIn);

module.exports = router;
