const mongoose = require('mongoose');

const kioskCredentialSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    credentialId: { type: String, required: true, unique: true, index: true },
    secretHash: { type: String, required: true, select: false },
    active: { type: Boolean, default: true },
    expiresAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Owner', required: true },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

kioskCredentialSchema.index({ tenantId: 1, active: 1, expiresAt: 1 });

module.exports = mongoose.model('KioskCredential', kioskCredentialSchema);
