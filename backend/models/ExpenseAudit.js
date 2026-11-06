const mongoose = require('mongoose');

const expenseAuditSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  expenseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Expense',
    required: true
  },
  action: {
    type: String,
    enum: ['CREATED', 'UPDATED', 'PAYMENT_RECORDED', 'DELETED'],
    required: true
  },
  actorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Owner',
    required: true
  },
  before: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  after: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  }
}, { timestamps: true });

expenseAuditSchema.index({ tenantId: 1, expenseId: 1, createdAt: -1 });

module.exports = mongoose.model('ExpenseAudit', expenseAuditSchema);
