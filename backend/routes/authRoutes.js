const express = require('express');
const router = express.Router();

const {
  registerOwner,
  loginOwner,
  getProfile,
  recordSessionActivity,
  refreshSession,
  logoutSession,
  getOwnerSessions,
  revokeOwnerSession,
  revokeOtherOwnerSessions,
  revokeAllOwnerSessions,
  changeOwnerPassword,
  forgotPassword,
  validatePasswordResetToken,
  resetPassword
} = require('../controllers/authController');

const {
  protectOwner
} = require('../middleware/authMiddleware');
const { rateLimit } = require('express-rate-limit');

const changePasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: req => String(req.owner._id),
  message: {
    success: false,
    message: 'Too many password change attempts. Try again in 15 minutes.'
  }
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many reset requests. Try again in 15 minutes.'
  }
});

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many reset attempts. Try again in 15 minutes.'
  }
});

// Owner Registration
router.post('/register', registerOwner);

// Owner Login
router.post('/login', loginOwner);
router.post('/forgot-password', forgotPasswordLimiter, forgotPassword);
router.post('/validate-reset-token', resetPasswordLimiter, validatePasswordResetToken);
router.post('/reset-password', resetPasswordLimiter, resetPassword);

// Get authenticated Owner + Business Profile
router.get('/profile', protectOwner, getProfile);
router.put('/change-password', protectOwner, changePasswordLimiter, changeOwnerPassword);
router.post('/activity', protectOwner, recordSessionActivity);
router.post('/refresh', protectOwner, refreshSession);
router.post('/logout', logoutSession);
router.get('/sessions', protectOwner, getOwnerSessions);
router.delete('/sessions/others', protectOwner, revokeOtherOwnerSessions);
router.delete('/sessions/all', protectOwner, revokeAllOwnerSessions);
router.delete('/sessions/:sessionId', protectOwner, revokeOwnerSession);

module.exports = router;