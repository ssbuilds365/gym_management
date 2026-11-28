const express = require('express');
const { protectOwner } = require('../middleware/authMiddleware');
const {
  getDashboard,
  listSessions,
  createSession,
  updateSession,
  deleteSession,
  listNotes,
  createNote,
  updateNote,
  deleteNote,
  getDashboardSummary,
  getDashboardFinancials,
  getDashboardSessions,
  getDashboardExpiringPlans
} = require('../controllers/personalTrainerController');

const router = express.Router();
router.use(protectOwner);

router.get('/dashboard', getDashboard);
router.get('/dashboard/summary', getDashboardSummary);
router.get('/dashboard/financials', getDashboardFinancials);
router.get('/dashboard/sessions', getDashboardSessions);
router.get('/dashboard/expiring-plans', getDashboardExpiringPlans);
router.get('/sessions', listSessions);
router.post('/sessions', createSession);
router.put('/sessions/:id', updateSession);
router.delete('/sessions/:id', deleteSession);
router.get('/notes', listNotes);
router.post('/notes', createNote);
router.put('/notes/:id', updateNote);
router.delete('/notes/:id', deleteNote);

module.exports = router;
