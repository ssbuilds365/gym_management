const express = require('express');
const { protectOwner } = require('../middleware/authMiddleware');
const {
  listTrainerStaff,
  createTrainerStaff,
  updateTrainerStaff,
  deleteTrainerStaff,
  getTrainerAssignments,
  assignMemberToTrainer,
  removeTrainerAssignment,
  getTrainerStaffReport
} = require('../controllers/trainerStaffController');

const router = express.Router();
router.use(protectOwner);
router.get('/', listTrainerStaff);
router.post('/', createTrainerStaff);
router.get('/reports', getTrainerStaffReport);
router.get('/:id/assignments', getTrainerAssignments);
router.post('/:id/assignments', assignMemberToTrainer);
router.delete('/:id/assignments/:memberId', removeTrainerAssignment);
router.put('/:id', updateTrainerStaff);
router.delete('/:id', deleteTrainerStaff);

module.exports = router;
