
const mongoose = require('mongoose');

const memberMembershipSchema = new mongoose.Schema(
  {
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

    attributedTrainerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TrainerStaff',
      default: null
    },

    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MembershipPlan',
      required: true
    },

    startDate: {
      type: Date,
      required: true
    },

    endDate: {
      type: Date,
      required: true
    },

    planPrice: {
      type: Number,
      required: true,
      min: 0
    },

    paidAmount: {
      type: Number,
      default: 0,
      min: 0
    },

    paymentStatus: {
      type: String,
      enum: ['Pending', 'Partial', 'Paid'],
      default: 'Pending'
    },

    gstSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },

    invoiceNumber: {
      type: String,
      trim: true
    },

    placeOfSupplyStateCode: {
      type: String,
      trim: true
    },

    taxBreakdown: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },

    status: {
      type: String,
      enum: ['Active', 'Expired', 'Cancelled'],
      default: 'Active'
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Owner',
      required: true
    }
  },
  { timestamps: true }
);

memberMembershipSchema.index({
  tenantId: 1,
  memberId: 1,
  createdAt: -1
});
memberMembershipSchema.index({
  tenantId: 1,
  businessId: 1,
  memberId: 1,
  startDate: -1,
  createdAt: -1
});
memberMembershipSchema.index({ tenantId: 1, status: 1 });
memberMembershipSchema.index({ tenantId: 1, attributedTrainerId: 1, status: 1, startDate: -1 });
memberMembershipSchema.index(
  { businessId: 1, invoiceNumber: 1 },
  { unique: true, partialFilterExpression: { invoiceNumber: { $type: 'string' } } }
);

module.exports = mongoose.model(
  'MemberMembership',
  memberMembershipSchema
);
