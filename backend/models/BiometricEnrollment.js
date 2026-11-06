const mongoose = require('mongoose');

const biometricEnrollmentSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true
    },
    memberId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Member',
      required: true
    },
    templateFormat: {
      type: String,
      enum: ['ISO_19794_2', 'ANSI_378'],
      required: true
    },
    encryptedTemplate: {
      ciphertext: { type: String, required: true, select: false },
      iv: { type: String, required: true, select: false },
      authTag: { type: String, required: true, select: false },
      keyVersion: { type: String, required: true }
    },
    fingerIdentifier: {
      type: String,
      enum: [
        'Right Thumb',
        'Right Index',
        'Right Middle',
        'Right Ring',
        'Right Little',
        'Left Thumb',
        'Left Index',
        'Left Middle',
        'Left Ring',
        'Left Little'
      ],
      required: true
    },
    status: {
      type: String,
      enum: ['Active', 'Revoked'],
      default: 'Active',
      required: true
    },
    consentAt: {
      type: Date,
      required: true
    },
    enrolledAt: {
      type: Date,
      required: true,
      default: Date.now
    }
  },
  { timestamps: true }
);

biometricEnrollmentSchema.index(
  { tenantId: 1, memberId: 1, fingerIdentifier: 1 },
  { unique: true }
);
biometricEnrollmentSchema.index({ tenantId: 1, status: 1 });

module.exports = mongoose.model(
  'BiometricEnrollment',
  biometricEnrollmentSchema
);
