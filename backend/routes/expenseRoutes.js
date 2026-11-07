const express = require('express');
const { protectOwner } = require('../middleware/authMiddleware');
const {
  listExpenses,
  getExpense,
  createExpense,
  updateExpense,
  deleteExpense,
  archiveExpense,
  restoreExpense,
  recordExpensePayment,
  getExpenseRetention,
  updateExpenseRetention,
  createExpenseReceiptUpload,
  attachExpenseReceipt,
  getExpenseReceipt,
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
router.get('/retention', getExpenseRetention);
router.put('/retention', updateExpenseRetention);
router.post('/:id/payments', recordExpensePayment);
router.post('/:id/receipt/upload-signature', createExpenseReceiptUpload);
router.post('/:id/receipt', attachExpenseReceipt);
router.get('/:id/receipt', getExpenseReceipt);
router.patch('/:id/archive', archiveExpense);
router.patch('/:id/restore', restoreExpense);
router.get('/', listExpenses);
router.post('/', createExpense);
router.get('/:id', getExpense);
router.put('/:id', updateExpense);
router.delete('/:id', deleteExpense);

module.exports = router;
