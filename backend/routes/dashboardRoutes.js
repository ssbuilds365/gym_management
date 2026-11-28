const express = require('express');
const router = express.Router();

const { protectOwner } = require('../middleware/authMiddleware');
const {
  getDashboardStats,
  getTodaysBirthdays
} = require('../controllers/dashboardController');
const { getMembershipExpiry } = require('../controllers/membershipExpiryController');
const { listExpiringPTClients } = require('../controllers/trainerPTExpiryController');

router.get('/stats', protectOwner, getDashboardStats);
router.get('/todays-birthdays', protectOwner, getTodaysBirthdays);
router.get('/membership-expiry', protectOwner, getMembershipExpiry);
router.get('/expiring-pt-clients', protectOwner, listExpiringPTClients);

module.exports = router;