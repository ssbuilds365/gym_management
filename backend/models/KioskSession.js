const mongoose = require('mongoose');

const kioskSessionSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    credentialId: { type: String, required: true, index: true },
    refreshTokenHash: { type: String, required: true, unique: true, select: false },
    expiresAt: { type: Date, required: true, index: true },
    revokedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

kioskSessionSchema.index({ credentialId: 1, revokedAt: 1, expiresAt: 1 });

module.exports = mongoose.model('KioskSession', kioskSessionSchema);
