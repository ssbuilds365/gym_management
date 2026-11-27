const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { protectOwner } = require('../middleware/authMiddleware');
const {
  getFaceStatus,
  getFaceDuplicateReport,
  registerFace,
  removeFace,
  createKioskCredential,
  listKioskCredentials,
  rotateKioskCredential,
  revokeKioskCredential,
  getTeamFaceStatus,
  registerTeamFace,
  removeTeamFace
} = require('../controllers/biometricController');

const biometricEnrollmentRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

const biometricDiagnosticRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

router.use(protectOwner);
router.get('/credentials/status/:id', getFaceStatus);
router.get('/duplicates', biometricDiagnosticRateLimit, getFaceDuplicateReport);
router.post('/credentials/member/:id/face', biometricEnrollmentRateLimit, registerFace);
router.delete('/credentials/member/:id/face', removeFace);
router.get('/credentials/:subjectType/:id/face/status', getTeamFaceStatus);
router.post('/credentials/:subjectType/:id/face', biometricEnrollmentRateLimit, registerTeamFace);
router.delete('/credentials/:subjectType/:id/face', removeTeamFace);
router.post('/kiosk-credentials', createKioskCredential);
router.get('/kiosk-credentials', listKioskCredentials);
router.post('/kiosk-credentials/:id/rotate', rotateKioskCredential);
router.delete('/kiosk-credentials/:id', revokeKioskCredential);

module.exports = router;
