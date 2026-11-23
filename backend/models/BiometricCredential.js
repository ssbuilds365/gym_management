const mongoose = require('mongoose');

const biometricCredentialSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
    biometricType: { type: String, enum: ['Face'], default: 'Face', required: true },
    encryptedTemplate: {
      ciphertext: { type: String, required: true, select: false },
      iv: { type: String, required: true, select: false },
      authTag: { type: String, required: true, select: false },
      keyVersion: { type: String, required: true }
    },
    modelVersion: { type: String, required: true },
    registrationStatus: { type: String, enum: ['Active', 'Revoked'], default: 'Active', required: true },
    consentStatus: { type: String, enum: ['Granted', 'Withdrawn'], default: 'Granted', required: true },
    consentTextVersion: { type: String, required: true },
    consentAt: { type: Date, required: true },
    registeredAt: { type: Date, required: true, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Owner', required: false, default: null },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Owner', default: null }
  },
  { timestamps: true }
);

biometricCredentialSchema.index(
  { tenantId: 1, memberId: 1, biometricType: 1 },
  { unique: true, partialFilterExpression: { registrationStatus: 'Active' } }
);
biometricCredentialSchema.index({ tenantId: 1, registrationStatus: 1, consentStatus: 1 });

module.exports = mongoose.model('BiometricCredential', biometricCredentialSchema);
