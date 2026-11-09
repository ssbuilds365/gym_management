const mongoose = require('mongoose');

const trainerPTPackageSchema = new mongoose.Schema({
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
  assignmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TrainerAssignment',
    default: null
  },
  packageName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 120
  },
  packageType: {
    type: String,
    enum: ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'One-Time Package', 'Custom Duration'],
    required: true
  },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  totalFeeMinor: { type: Number, required: true, min: 0 },
  collectedAmountMinor: { type: Number, required: true, min: 0, default: 0 },
  paymentFrequency: {
    type: String,
    enum: ['One-Time', 'Monthly', 'Quarterly', 'Custom'],
    required: true
  },
  status: {
    type: String,
    enum: ['Active', 'Expired', 'Cancelled'],
    required: true,
    default: 'Active'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Owner',
    required: true
  }
}, { timestamps: true });

trainerPTPackageSchema.index({ tenantId: 1, memberId: 1, startDate: -1 });
trainerPTPackageSchema.index({ tenantId: 1, trainerId: 1, status: 1, endDate: 1 });
trainerPTPackageSchema.index({ tenantId: 1, businessId: 1, startDate: -1 });

module.exports = mongoose.model('TrainerPTPackage', trainerPTPackageSchema);
