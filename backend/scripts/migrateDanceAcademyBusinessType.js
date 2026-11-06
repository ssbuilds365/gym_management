const mongoose = require('mongoose');
const config = require('../config/env');

const migrate = async () => {
  try {
    await mongoose.connect(config.mongodbUri);
    const result = await mongoose.connection.collection('businesses').updateMany(
      { businessType: 'Dance Academy' },
      { $set: { businessType: 'Other' } }
    );
    console.log(`Migrated ${result.modifiedCount} business record(s).`);
  } catch (error) {
    console.error('Business type migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
};

migrate();
