const express = require('express');
const { protectOwner } = require('../middleware/authMiddleware');
const {
  uploadBusinessLogo,
  removeBusinessLogo
} = require('../controllers/businessController');
const {
  getSettings,
  updateSettings,
  getSubscription
} = require('../controllers/businessController');

const router = express.Router();
router.use(protectOwner);
router.get('/settings', getSettings);
router.put('/settings', updateSettings);
const parseBusinessLogoBody = express.raw({
  type: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'],
  limit: '200kb'
});
router.post('/settings/logo', (req, res, next) => {
  parseBusinessLogoBody(req, res, error => {
    if (!error) return next();
    return res.status(error.status === 413 ? 413 : 400).json({
      success: false,
      message: error.status === 413
        ? 'Logo image must be 200 KB or smaller.'
        : 'Unable to read the selected logo image.'
    });
  });
}, uploadBusinessLogo);
router.delete('/settings/logo', removeBusinessLogo);
router.get('/subscription', getSubscription);

module.exports = router;
