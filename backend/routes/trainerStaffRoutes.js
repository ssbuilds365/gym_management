const express = require('express');
const { protectOwner } = require('../middleware/authMiddleware');
const {
  listTrainerStaff,
  createTrainerStaff,
  updateTrainerStaff,
  deleteTrainerStaff,
  getTrainerStaffReport
} = require('../controllers/trainerStaffController');
const {
  getTrainerAssignments,
  assignMemberToTrainer,
  removeTrainerAssignment
} = require('../controllers/trainerAssignmentController');
const {
  listTrainerPTPackages,
  createTrainerPTPackage,
  recordTrainerPTPayment,
  refundTrainerPTPayment
} = require('../controllers/trainerPTController');
const { trainerFinancialPerformance } = require('../controllers/trainerFinanceController');

const router = express.Router();
router.use(protectOwner);
router.get('/', listTrainerStaff);
router.post('/', createTrainerStaff);
router.get('/financial-performance', trainerFinancialPerformance);
router.get('/reports', getTrainerStaffReport);
router.post('/pt-payments/:paymentId/refunds', refundTrainerPTPayment);
router.post('/pt-packages/:packageId/payments', recordTrainerPTPayment);
router.get('/:id/assignments', getTrainerAssignments);
router.post('/:id/assignments', assignMemberToTrainer);
router.delete('/:id/assignments/:memberId', removeTrainerAssignment);
router.get('/:id/pt-packages', listTrainerPTPackages);
router.post('/:id/pt-packages', createTrainerPTPackage);
router.put('/:id', updateTrainerStaff);
router.delete('/:id', deleteTrainerStaff);

module.exports = router;
