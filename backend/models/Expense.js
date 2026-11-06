const mongoose = require('mongoose');

const paymentEntrySchema = new mongoose.Schema({
  amountMinor: {
    type: Number,
    required: true,
    min: 1
  },
  paymentMethod: {
    type: String,
    enum: ['Cash', 'UPI', 'Bank Transfer', 'Card', 'Other'],
    required: true
  },
  paidAt: {
    type: Date,
    required: true
  },
  reference: {
    type: String,
    trim: true,
    default: ''
  },
  notes: {
    type: String,
    trim: true,
    default: ''
  },
  recordedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Owner',
    required: true
  }
}, { _id: true });

const expenseSchema = new mongoose.Schema({
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
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 120
  },
  category: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80
  },
  amountMinor: {
    type: Number,
    required: true,
    min: 1
  },
  paidAmountMinor: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  status: {
    type: String,
    enum: ['PAID', 'PENDING', 'PARTIALLY_PAID'],
    required: true,
    default: 'PENDING'
  },
  paymentMethod: {
    type: String,
    enum: ['Cash', 'UPI', 'Bank Transfer', 'Card', 'Other'],
    default: null
  },
  expenseDate: {
    type: Date,
    required: true
  },
  vendor: {
    type: String,
    trim: true,
    maxlength: 120,
    default: ''
  },
  invoiceNumber: {
    type: String,
    trim: true,
    maxlength: 80,
    default: ''
  },
  transactionReference: {
    type: String,
    trim: true,
    maxlength: 120,
    default: ''
  },
  description: {
    type: String,
    trim: true,
    maxlength: 2000,
    default: ''
  },
  payments: {
    type: [paymentEntrySchema],
    default: []
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Owner',
    required: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Owner',
    required: true
  },
  deletedAt: {
    type: Date,
    default: null
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Owner',
    default: null
  }
}, { timestamps: true });

expenseSchema.index({ tenantId: 1, deletedAt: 1, expenseDate: -1, createdAt: -1 });
expenseSchema.index({ tenantId: 1, deletedAt: 1, category: 1, expenseDate: -1 });
expenseSchema.index({ tenantId: 1, deletedAt: 1, status: 1, expenseDate: -1 });
expenseSchema.index({ tenantId: 1, deletedAt: 1, vendor: 1, expenseDate: -1 });

module.exports = mongoose.model('Expense', expenseSchema);
