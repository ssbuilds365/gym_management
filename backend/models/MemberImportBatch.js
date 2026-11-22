const mongoose = require('mongoose');

const memberImportBatchSchema = new mongoose.Schema(
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
    idempotencyKey: {
      type: String,
      required: true,
      trim: true
    },
    filename: {
      type: String,
      required: true,
      trim: true
    },
    importedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Owner',
      required: true
    },
    status: {
      type: String,
      enum: ['PENDING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED'],
      default: 'PENDING'
    },
    totalRows: { type: Number, default: 0, min: 0 },
    importedCount: { type: Number, default: 0, min: 0 },
    duplicateCount: { type: Number, default: 0, min: 0 },
    failedCount: { type: Number, default: 0, min: 0 },
    membershipImportedCount: { type: Number, default: 0, min: 0 },
    paymentImportedCount: { type: Number, default: 0, min: 0 },
    report: {
      type: [{
        rowNumber: Number,
        legacyMemberId: String,
        fullName: String,
        phone: String,
        status: {
          type: String,
          enum: ['IMPORTED', 'DUPLICATE', 'INVALID', 'FAILED']
        },
        reason: String,
        memberId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Member',
          default: null
        }
      }],
      default: []
    }
  },
  { timestamps: true }
);

memberImportBatchSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true }
);
memberImportBatchSchema.index({ tenantId: 1, createdAt: -1 });

module.exports = mongoose.model('MemberImportBatch', memberImportBatchSchema);
