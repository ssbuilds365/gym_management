const express = require('express');
const { protectOwner } = require('../middleware/authMiddleware');
const {
  listExpenses,
  getExpense,
  createExpense,
  updateExpense,
  deleteExpense,
  listExpenseCategories,
  createExpenseCategory,
  updateExpenseCategory,
  exportExpenses,
  getExpenseReport
} = require('../controllers/expenseController');

const router = express.Router();
router.use(protectOwner);
router.get('/categories', listExpenseCategories);
router.post('/categories', createExpenseCategory);
router.put('/categories/:id', updateExpenseCategory);
router.get('/export', exportExpenses);
router.get('/reports', getExpenseReport);
router.get('/', listExpenses);
router.post('/', createExpense);
router.get('/:id', getExpense);
router.put('/:id', updateExpense);
router.delete('/:id', deleteExpense);

module.exports = router;
