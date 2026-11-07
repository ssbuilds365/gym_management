const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const requiredVariables = ['MONGODB_URI'];
const missingVariables = requiredVariables.filter(
  (name) => !process.env[name]?.trim()
);

if (missingVariables.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingVariables.join(', ')}`
  );
}

const port = Number(process.env.PORT || 5000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const nodeEnv = process.env.NODE_ENV || 'development';
if (nodeEnv === 'production' && !process.env.FRONTEND_URL?.trim()) {
  throw new Error('FRONTEND_URL must be configured in production');
}

const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4200';
const smtpPort = Number(process.env.SMTP_PORT || 587);
if (process.env.SMTP_PORT && (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)) {
  throw new Error('SMTP_PORT must be an integer between 1 and 65535');
}
const allowedOrigins = new Set([frontendUrl]);
if (nodeEnv !== 'production') {
  allowedOrigins.add('http://localhost:4200');
  allowedOrigins.add('http://localhost:60949');
}

const platformAdminOwnerIds = (process.env.PLATFORM_ADMIN_OWNER_IDS || '')
  .split(',')
  .map((id) => id.trim().toLowerCase())
  .filter(Boolean);
if (platformAdminOwnerIds.some(id => !/^[a-f\d]{24}$/i.test(id))) {
  throw new Error('PLATFORM_ADMIN_OWNER_IDS must contain comma-separated MongoDB ObjectIds');
}

module.exports = Object.freeze({
  port,
  nodeEnv,
  mongodbUri: process.env.MONGODB_URI,
  platformAdminOwnerIds: Object.freeze(platformAdminOwnerIds),
  atlas: Object.freeze({
    publicKey: process.env.ATLAS_PUBLIC_KEY || '',
    privateKey: process.env.ATLAS_PRIVATE_KEY || '',
    projectId: process.env.ATLAS_PROJECT_ID || '',
    clusterName: process.env.ATLAS_CLUSTER_NAME || ''
  }),
  jwtSecret: process.env.JWT_SECRET || '',
  frontendUrl,
  smtp: Object.freeze({
    host: process.env.SMTP_HOST || '',
    port: smtpPort,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || ''
  }),
  allowedOrigins: Object.freeze([...allowedOrigins]),
  backendUrl: process.env.BACKEND_URL || 'http://localhost:5000',
  razorpay: Object.freeze({
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || ''
  }),
  cloudinary: Object.freeze({
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
    uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET || ''
  })
});
