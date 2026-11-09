const express = require('express');
const router = express.Router();

const { protectOwner } = require('../middleware/authMiddleware');

const {
  createPayment,
  getEligiblePaymentMembers,
  getAllPayments,
  getMemberPayments,
  getPaymentReceipt,
  recordPaymentRefund
} = require('../controllers/paymentController');

// Record new payment
router.post('/', protectOwner, createPayment);
router.get('/eligible-members', protectOwner, getEligiblePaymentMembers);

// Get payment history of a specific member
router.get('/member/:memberId', protectOwner, getMemberPayments);

// Retrieve a verified immutable receipt snapshot for a payment.
router.get('/:paymentId/receipt', protectOwner, getPaymentReceipt);
router.post('/:paymentId/refund', protectOwner, recordPaymentRefund);

// Get all business payments
router.get('/', protectOwner, getAllPayments);

module.exports = router;