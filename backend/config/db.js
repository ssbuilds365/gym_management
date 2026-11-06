const mongoose = require('mongoose');
const config = require('./env');

const connectDB = async () => {
  try {
    const connection = await mongoose.connect(config.mongodbUri);

    console.log(
      `MongoDB Connected: ${connection.connection.host}`
    );

  } catch (error) {
    console.error('MongoDB Connection Failed:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;