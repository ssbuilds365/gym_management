const mongoose = require('mongoose');

const databaseManagementAuditSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  actorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Owner',
    required: true
  },
  actorRole: {
    type: String,
    required: true
  },
  category: {
    type: String,
    enum: ['members', 'trainersStaff', 'expenses'],
    required: true
  },
  operation: {
    type: String,
    enum: ['DELETE_SELECTED'],
    required: true
  },
  affectedRecordCount: {
    type: Number,
    min: 0,
    required: true,
    default: 0
  },
  filters: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  reason: {
    type: String,
    required: true,
    maxlength: 500
  },
  status: {
    type: String,
    enum: ['PENDING', 'SUCCEEDED', 'PARTIAL', 'FAILED'],
    required: true,
    default: 'PENDING'
  },
  requestId: {
    type: String,
    required: true
  }
}, { timestamps: true, versionKey: false });

databaseManagementAuditSchema.index(
  { tenantId: 1, requestId: 1 },
  { unique: true }
);
databaseManagementAuditSchema.index({ tenantId: 1, createdAt: -1 });

module.exports = mongoose.model('DatabaseManagementAudit', databaseManagementAuditSchema);
