const mongoose = require('mongoose');

const membershipPlanSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true
    },

    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true
    },

    planName: {
      type: String,
      required: true,
      trim: true
    },

    duration: {
      type: Number,
      required: true,
      min: 1
    },

    durationType: {
      type: String,
      enum: ['Days', 'Months', 'Years'],
      default: 'Months'
    },

    price: {
      type: Number,
      required: true,
      min: 0
    },

    description: {
      type: String,
      default: ''
    },

    benefits: [{
      type: String,
      trim: true
    }],

    status: {
      type: String,
      enum: ['Active', 'Inactive'],
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

membershipPlanSchema.index({ tenantId: 1, planName: 1 });

module.exports = mongoose.model('MembershipPlan', membershipPlanSchema);