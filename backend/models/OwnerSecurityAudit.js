const mongoose = require('mongoose');

const ownerSecurityAuditSchema = new mongoose.Schema({
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Owner',
    required: true,
    index: true
  },
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  action: {
    type: String,
    enum: ['PASSWORD_CHANGED', 'PASSWORD_RESET'],
    required: true
  },
  occurredAt: {
    type: Date,
    required: true,
    default: Date.now
  }
}, { versionKey: false });

ownerSecurityAuditSchema.index({ tenantId: 1, occurredAt: -1 });

module.exports = mongoose.model('OwnerSecurityAudit', ownerSecurityAuditSchema);
