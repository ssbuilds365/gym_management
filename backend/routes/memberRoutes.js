const express = require('express');
const router = express.Router();

const {
  createMember,
  getAllMembers,
  updateMember,
  deleteMember,
  generateMemberQR
} = require('../controllers/memberController');

const { protectOwner } = require('../middleware/authMiddleware');

router.post('/', protectOwner, createMember);

router.get('/', protectOwner, getAllMembers);

router.put('/:id', protectOwner, updateMember);

router.delete('/:id', protectOwner, deleteMember);

router.post('/:id/generate-qr', protectOwner, generateMemberQR);

module.exports = router;