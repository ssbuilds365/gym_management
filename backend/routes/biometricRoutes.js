const express = require('express');
const router = express.Router();
const { protectOwner } = require('../middleware/authMiddleware');
const {
  getFaceStatus,
  registerFace,
  removeFace,
  createKioskCredential,
  listKioskCredentials,
  rotateKioskCredential,
  revokeKioskCredential
} = require('../controllers/biometricController');

router.use(protectOwner);
router.get('/credentials/status/:id', getFaceStatus);
router.post('/credentials/member/:id/face', registerFace);
router.delete('/credentials/member/:id/face', removeFace);
router.post('/kiosk-credentials', createKioskCredential);
router.get('/kiosk-credentials', listKioskCredentials);
router.post('/kiosk-credentials/:id/rotate', rotateKioskCredential);
router.delete('/kiosk-credentials/:id', revokeKioskCredential);

module.exports = router;
