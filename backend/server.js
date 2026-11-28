
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const config = require('./config/env');
const connectDB = require('./config/db');
const { startAttendanceAutoCheckout } = require('./services/attendanceAutoCheckout');
const { initializeFaceRecognition } = require('./services/faceRecognition');

const dns = require('node:dns');
const { buildCorsOptions } = require('./utils/corsConfig');
const { configureProxyTrust } = require('./utils/proxyTrust');

dns.setServers([
  '1.1.1.1',
  '8.8.8.8'
]);

const app = express();
configureProxyTrust(app, config.nodeEnv);

// Security Middleware
app.use(helmet());

// CORS Configuration
app.use(cors(buildCorsOptions(config.allowedOrigins)));

app.use(express.json({ limit: '15mb' }));

if (config.nodeEnv !== 'production') {
  app.use('/api', (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const endpoint = req.route?.path
        ? `${req.baseUrl}${req.route.path}`
        : `${req.baseUrl}[unmatched]`;
      const slowLabel = durationMs >= 500 ? ' slow' : '';
      console.info(
        `[api] ${req.method} ${endpoint} ${res.statusCode} ${durationMs.toFixed(1)}ms${slowLabel}`
      );
    });
    next();
  });
}

// API Routes
app.use('/api/dashboard', require('./routes/dashboardRoutes'));
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/payments', require('./routes/paymentRoutes'));
app.use('/api/members', require('./routes/memberRoutes'));
app.use('/api/enquiries', require('./routes/enquiryRoutes'));
app.use('/api/membership-plans', require('./routes/membershipPlanRoutes'));
app.use('/api/attendance', require('./routes/attendanceRoutes'));

app.use(
  '/api/member-memberships',
  require('./routes/memberMembershipRoutes')
);
app.use('/api/trainers-staff', require('./routes/trainerStaffRoutes'));
app.use('/api/business', require('./routes/businessRoutes'));
app.use('/api/reports', require('./routes/reportRoutes'));
app.use('/api/expenses', require('./routes/expenseRoutes'));
app.use('/api/system', require('./routes/systemRoutes'));
app.use('/api/global-messages', require('./routes/globalMessageRoutes'));
app.use('/api/kiosk', require('./routes/kioskRoutes'));
app.use('/api/biometric', require('./routes/biometricRoutes'));
app.use('/api/personal-trainer', require('./routes/personalTrainerRoutes'));

// Root Route
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'SS Fitness Manager API is running!'
  });
});

// Health Check
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'Healthy',
    message: 'Backend server is working properly'
  });
});

// Start Server
const startServer = async () => {
  try {
    await connectDB();
    await startAttendanceAutoCheckout();
    await initializeFaceRecognition();
    if (!config.kioskTokenSecretConfigured) {
      console.warn(
        '[config] KIOSK_TOKEN_SECRET is missing or shorter than 32 characters; attendance kiosk authorization is disabled.'
      );
    }
    if (!config.biometricTemplateKeyConfigured) {
      console.warn(
        '[config] BIOMETRIC_TEMPLATE_KEY is missing or is not a Base64-encoded 32-byte key; face enrollment and identification are unavailable.'
      );
    }

    app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
    });
  } catch (error) {
    console.error('Server startup failed:', error.message);
    process.exit(1);
  }
};

startServer();
