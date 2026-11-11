
const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
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

    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Member',
      required: true
    },

    membershipId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MemberMembership',
      required: true
    },

    attributedTrainerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TrainerStaff',
      default: null
    },

    amount: {
      type: Number,
      required: true,
      min: 0.01
    },

    paymentMethod: {
      type: String,
      enum: ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Razorpay'],
      required: true
    },

    paymentType: {
      type: String,
      enum: ['Membership Fee', 'Registration Fee', 'Other'],
      default: 'Membership Fee'
    },

    transactionId: {
      type: String,
      trim: true,
      default: ''
    },

    paymentDate: {
      type: Date,
      default: Date.now
    },

    status: {
      type: String,
      enum: ['Success', 'Pending', 'Failed', 'Refunded'],
      default: 'Success'
    },

    notes: {
      type: String,
      trim: true,
      default: ''
    },

    receiptNumber: {
      type: String,
      trim: true,
      unique: true,
      sparse: true
    },

    receiptSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },

    refund: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },

    statusHistory: {
      type: [{
        status: {
          type: String,
          enum: ['Success', 'Pending', 'Failed', 'Refunded'],
          required: true
        },
        changedAt: {
          type: Date,
          required: true
        },
        changedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Owner',
          required: true
        },
        reason: {
          type: String,
          trim: true,
          default: ''
        }
      }],
      default: []
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Owner',
      required: true
    }
  },
  { timestamps: true }
);

paymentSchema.index({ tenantId: 1, memberId: 1, paymentDate: -1 });
paymentSchema.index({ tenantId: 1, businessId: 1, membershipId: 1, status: 1 });
paymentSchema.index({ tenantId: 1, status: 1 });
paymentSchema.index({ tenantId: 1, paymentDate: -1 });
paymentSchema.index({ tenantId: 1, attributedTrainerId: 1, status: 1, paymentDate: -1 });

module.exports = mongoose.model('Payment', paymentSchema);
