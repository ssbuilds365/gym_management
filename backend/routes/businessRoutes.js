const express = require('express');
const { protectOwner } = require('../middleware/authMiddleware');
const {
  getSettings,
  updateSettings,
  getSubscription
} = require('../controllers/businessController');

const router = express.Router();
router.use(protectOwner);
router.get('/settings', getSettings);
router.put('/settings', updateSettings);
router.get('/subscription', getSubscription);

module.exports = router;
