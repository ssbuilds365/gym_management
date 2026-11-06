const express = require('express');
const router = express.Router();

const { protectOwner } = require('../middleware/authMiddleware');
const { getDashboardStats } = require('../controllers/dashboardController');
const { getMembershipExpiry } = require('../controllers/membershipExpiryController');

router.get('/stats', protectOwner, getDashboardStats);
router.get('/membership-expiry', protectOwner, getMembershipExpiry);

module.exports = router;