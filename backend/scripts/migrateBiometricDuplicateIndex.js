const mongoose = require('mongoose');
const config = require('../config/env');
const BiometricCredential = require('../models/BiometricCredential');

const run = async () => {
  try {
    await mongoose.connect(config.mongodbUri);
    await BiometricCredential.collection.createIndex(
      {
        tenantId: 1,
        businessId: 1,
        biometricType: 1,
        registrationStatus: 1,
        consentStatus: 1
      },
      { name: 'biometric_identity_scan' }
    );
    console.log('Biometric identity scan index is ready.');
  } catch {
    console.error('Unable to create the biometric identity scan index.');
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
};

run();
