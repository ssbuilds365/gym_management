const express = require('express');
const { protectOwner } = require('../middleware/authMiddleware');
const {
  listEnquiries,
  createEnquiry,
  getEnquiry,
  updateEnquiry,
  deleteEnquiry,
  updateEnquiryStatus,
  getStatusHistory,
  addFollowUp,
  getFollowUps,
  addTrial,
  getTrials,
  getEnquiryDashboard,
  getEnquiryAnalytics,
  convertEnquiryToMember
} = require('../controllers/enquiryController');

const router = express.Router();
router.use(protectOwner);

router.get('/dashboard', getEnquiryDashboard);
router.get('/analytics', getEnquiryAnalytics);
router.get('/', listEnquiries);
router.post('/', createEnquiry);
router.get('/:id/status-history', getStatusHistory);
router.get('/:id/follow-ups', getFollowUps);
router.post('/:id/follow-ups', addFollowUp);
router.get('/:id/trials', getTrials);
router.post('/:id/trials', addTrial);
router.patch('/:id/status', updateEnquiryStatus);
router.post('/:id/convert', convertEnquiryToMember);
router.get('/:id', getEnquiry);
router.put('/:id', updateEnquiry);
router.delete('/:id', deleteEnquiry);

module.exports = router;
