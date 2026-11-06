const fs = require('node:fs');
const path = require('node:path');

const publicEnvironmentVariables = {
  appName: 'NG_APP_NAME',
  appVersion: 'NG_APP_VERSION',
  frontendUrl: 'NG_APP_FRONTEND_URL',
  backendUrl: 'NG_APP_BACKEND_URL',
  razorpayKeyId: 'NG_APP_RAZORPAY_KEY_ID'
};

const environmentOverrides = {};

for (const [property, variable] of Object.entries(publicEnvironmentVariables)) {
  if (process.env[variable] !== undefined) {
    environmentOverrides[property] = process.env[variable];
  }
}

const cloudinaryOverrides = {};
for (const [property, variable] of Object.entries({
  cloudName: 'NG_APP_CLOUDINARY_CLOUD_NAME',
  uploadPreset: 'NG_APP_CLOUDINARY_UPLOAD_PRESET'
})) {
  if (process.env[variable] !== undefined) {
    cloudinaryOverrides[property] = process.env[variable];
  }
}

if (Object.keys(cloudinaryOverrides).length > 0) {
  environmentOverrides.cloudinary = cloudinaryOverrides;
}

const generatedEnvironmentPath = path.join(
  __dirname,
  '..',
  'src',
  'environments',
  'environment.production.generated.ts'
);

const generatedEnvironment = [
  "import { environment as defaults } from './environment.production';",
  '',
  'export const environment = {',
  '  ...defaults,',
  `  ...${JSON.stringify(environmentOverrides)},`,
  '  cloudinary: {',
  '    ...defaults.cloudinary,',
  `    ...${JSON.stringify(cloudinaryOverrides)}`,
  '  }',
  '};',
  ''
].join('\n');

fs.writeFileSync(generatedEnvironmentPath, generatedEnvironment);
