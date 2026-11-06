const express = require('express');
const router = express.Router();

const {
  createPlan,
  getAllPlans,
  updatePlan,
  deletePlan
} = require('../controllers/membershipPlanController');

const { protectOwner } = require('../middleware/authMiddleware');

// All routes require owner authentication
router.post('/', protectOwner, createPlan);

router.get('/', protectOwner, getAllPlans);

router.put('/:id', protectOwner, updatePlan);

router.delete('/:id', protectOwner, deletePlan);

module.exports = router;