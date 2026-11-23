const mongoose = require('mongoose');
const config = require('../config/env');

const collectionName = 'attendances';
const indexName = 'tenant_kiosk_idempotency_unique';
const key = { tenantId: 1, kioskIdempotencyKey: 1 };

const isTargetIndex = index => {
  const fields = Object.keys(index.key || {});
  return fields.length === 2 &&
    index.key.tenantId === 1 &&
    index.key.kioskIdempotencyKey === 1;
};

const isCorrectIndex = index =>
  index.name === indexName &&
  index.unique === true &&
  index.partialFilterExpression?.kioskIdempotencyKey?.$type === 'string';

async function migrate() {
  await mongoose.connect(config.mongodbUri, { autoIndex: false });
  const collection = mongoose.connection.db.collection(collectionName);
  const indexes = await collection.indexes();
  const existing = indexes.filter(isTargetIndex);

  if (existing.some(isCorrectIndex) && existing.length === 1) {
    console.log('Kiosk idempotency index is already correct.');
    return;
  }

  for (const index of existing) {
    await collection.dropIndex(index.name);
  }

  await collection.createIndex(key, {
    name: indexName,
    unique: true,
    partialFilterExpression: { kioskIdempotencyKey: { $type: 'string' } }
  });
  console.log('Kiosk idempotency index migrated. No attendance records were changed.');
}

migrate()
  .catch(error => {
    console.error('Kiosk idempotency index migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
