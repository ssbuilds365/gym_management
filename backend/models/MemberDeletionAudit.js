const mongoose = require('mongoose');

const memberDeletionAuditSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true
    },

    deletedMemberId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true
    },

    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Owner',
      required: true
    },

    retainedPaymentCount: {
      type: Number,
      min: 0,
      required: true
    },

    retainedMembershipCount: {
      type: Number,
      min: 0,
      required: true
    },

    deletedAttendanceCount: {
      type: Number,
      min: 0,
      required: true
    },

    deletedBiometricEnrollmentCount: {
      type: Number,
      min: 0,
      required: true
    },

    deletedMembershipCount: {
      type: Number,
      min: 0,
      required: true
    }
  },
  { timestamps: true }
);

memberDeletionAuditSchema.index(
  { tenantId: 1, deletedMemberId: 1 },
  { unique: true }
);

module.exports = mongoose.model(
  'MemberDeletionAudit',
  memberDeletionAuditSchema
);
