const express = require('express');
const router = express.Router();

const {
  checkIn,
  checkOut,
  getDailyAttendance,
  getMemberAttendance,
  checkInWithQR
} = require('../controllers/attendanceController');

const { protectOwner } = require('../middleware/authMiddleware');

// Mark member check-in
router.post('/check-in', protectOwner, checkIn);

// Mark member check-out
router.post('/check-out', protectOwner, checkOut);

// Get daily attendance
router.get('/daily', protectOwner, getDailyAttendance);

// Get member attendance history
router.get('/member/:memberId', protectOwner, getMemberAttendance);

router.post('/qr-check-in', protectOwner, checkInWithQR);

module.exports = router;