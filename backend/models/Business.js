const mongoose = require('mongoose');

const businessSchema = new mongoose.Schema(
  {
    businessName: {
      type: String,
      required: true,
      trim: true
    },

    businessType: {
      type: String,
      enum: [
        'Gym',
        'Yoga Studio',
        'Fitness Studio',
        'Other'
      ],
      required: true
    },

    timeZone: {
      type: String,
      trim: true,
      default: process.env.DASHBOARD_TIME_ZONE || 'Asia/Kolkata'
    },

    expenseRetentionMonths: {
      type: Number,
      min: 1,
      max: 120,
      default: 12
    },

    ownerName: {
      type: String,
      required: true,
      trim: true
    },

    phone: {
      type: String,
      required: true,
      trim: true
    },

    email: {
      type: String,
      lowercase: true,
      trim: true
    },

    address: {
      type: String,
      trim: true
    },

    logoUrl: {
      type: String,
      trim: true,
      default: ''
    },

    gstEnabled: {
      type: Boolean,
      default: false
    },

    gstinNumber: {
      type: String,
      trim: true,
      uppercase: true,
      default: ''
    },

    legalBusinessName: {
      type: String,
      trim: true,
      default: ''
    },

    registeredBusinessAddress: {
      type: String,
      trim: true,
      default: ''
    },

    state: {
      type: String,
      trim: true,
      default: ''
    },

    stateCode: {
      type: String,
      trim: true,
      default: ''
    },

    gstPercentage: {
      type: Number,
      min: 0,
      max: 100,
      default: 0
    },

    taxInclusive: {
      type: Boolean,
      default: true
    },

    status: {
      type: String,
      enum: ['Active', 'Inactive', 'Suspended'],
      default: 'Active'
    },

    subscriptionStatus: {
      type: String,
      enum: ['Trial', 'Active', 'Expired', 'Cancelled'],
      default: 'Trial'
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('Business', businessSchema);