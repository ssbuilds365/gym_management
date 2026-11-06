const express = require('express');
const router = express.Router();

const {
  assignMembership,
  getMemberMemberships
} = require('../controllers/memberMembershipController');

const { protectOwner } = require('../middleware/authMiddleware');

router.post('/assign', protectOwner, assignMembership);
router.get('/member/:memberId', protectOwner, getMemberMemberships);

module.exports = router;