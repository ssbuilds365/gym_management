const mongoose = require('mongoose');

const refundSchema = new mongoose.Schema({
  amountMinor: { type: Number, required: true, min: 1 },
  reference: { type: String, trim: true, maxlength: 120, default: '' },
  reason: { type: String, trim: true, required: true, maxlength: 500 },
  refundedAt: { type: Date, required: true },
  recordedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Owner',
    required: true
  }
}, { _id: true });

const trainerPTPaymentSchema = new mongoose.Schema({
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
  packageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TrainerPTPackage',
    required: true
  },
  assignmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TrainerAssignment',
    default: null
  },
  memberId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Member',
    required: true
  },
  trainerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TrainerStaff',
    required: true
  },
  amountMinor: { type: Number, required: true, min: 1 },
  paymentMethod: {
    type: String,
    enum: ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'],
    required: true
  },
  transactionReference: { type: String, trim: true, maxlength: 120, default: '' },
  requestId: { type: String, trim: true, maxlength: 120, default: '' },
  paymentDate: { type: Date, required: true },
  status: {
    type: String,
    enum: ['Success', 'Pending', 'Failed', 'Refunded'],
    required: true,
    default: 'Success'
  },
  refunds: { type: [refundSchema], default: [] },
  notes: { type: String, trim: true, maxlength: 1000, default: '' },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Owner',
    required: true
  }
}, { timestamps: true });

trainerPTPaymentSchema.index({ tenantId: 1, packageId: 1, paymentDate: -1 });
trainerPTPaymentSchema.index({ tenantId: 1, trainerId: 1, status: 1, paymentDate: -1 });
trainerPTPaymentSchema.index(
  { businessId: 1, transactionReference: 1 },
  { unique: true, partialFilterExpression: { transactionReference: { $type: 'string', $gt: '' } } }
);
trainerPTPaymentSchema.index(
  { businessId: 1, requestId: 1 },
  { unique: true, partialFilterExpression: { requestId: { $type: 'string', $gt: '' } } }
);

module.exports = mongoose.model('TrainerPTPayment', trainerPTPaymentSchema);
