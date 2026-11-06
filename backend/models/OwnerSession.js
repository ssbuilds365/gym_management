const mongoose = require('mongoose');

const ownerSessionSchema = new mongoose.Schema({
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
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  tokenHash: {
    type: String,
    required: true,
    unique: true,
    select: false
  },
  previousTokenHash: {
    type: String,
    default: null,
    select: false
  },
  previousTokenValidUntil: {
    type: Date,
    default: null,
    select: false
  },
  device: {
    type: String,
    required: true,
    maxlength: 120
  },
  userAgent: {
    type: String,
    default: '',
    maxlength: 500,
    select: false
  },
  lastActivityAt: {
    type: Date,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true
  },
  revokedAt: {
    type: Date,
    default: null
  },
  revokedReason: {
    type: String,
    enum: ['logout', 'revoked', 'expired', 'password_changed', null],
    default: null
  }
}, { timestamps: true });

ownerSessionSchema.index({ ownerId: 1, tenantId: 1, revokedAt: 1, expiresAt: 1 });
ownerSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('OwnerSession', ownerSessionSchema);
