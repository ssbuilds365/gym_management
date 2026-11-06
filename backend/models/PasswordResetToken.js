const mongoose = require('mongoose');

const passwordResetTokenSchema = new mongoose.Schema({
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
  tokenHash: {
    type: String,
    required: true,
    unique: true,
    select: false
  },
  expiresAt: {
    type: Date,
    required: true
  },
  usedAt: {
    type: Date,
    default: null
  }
}, { timestamps: true, versionKey: false });

passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
passwordResetTokenSchema.index({ ownerId: 1, tenantId: 1, usedAt: 1 });

module.exports = mongoose.model('PasswordResetToken', passwordResetTokenSchema);
