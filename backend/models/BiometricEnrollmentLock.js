const mongoose = require('mongoose');

const biometricEnrollmentLockSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
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
    version: { type: Number, default: 0, required: true }
  },
  { timestamps: true, collection: 'biometricenrollmentlocks' }
);

module.exports = mongoose.model(
  'BiometricEnrollmentLock',
  biometricEnrollmentLockSchema
);
