const connectDB = require('../config/db');
const TrainerStaff = require('../models/TrainerStaff');
const { ensureTrainerStaffPublicIds } = require('../controllers/trainerStaffController');

const migrate = async () => {
  await connectDB();
  const tenantIds = await TrainerStaff.distinct('tenantId');
  for (const tenantId of tenantIds) {
    await ensureTrainerStaffPublicIds(tenantId);
  }
  console.log(`Migrated trainer/staff IDs for ${tenantIds.length} gym tenant(s).`);
  process.exit(0);
};

migrate().catch(error => {
  console.error('Trainer/staff ID migration failed:', error.message);
  process.exit(1);
});
