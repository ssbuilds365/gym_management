const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const TrainerPTPackage = require('../models/TrainerPTPackage');
const TrainerPTPayment = require('../models/TrainerPTPayment');
const {
  createTrainerPTPackage,
  recordTrainerPTPayment,
  refundTrainerPTPayment
} = require('../controllers/trainerPTController');
const { assignMemberToTrainer } = require('../controllers/trainerAssignmentController');

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});

test('PT package creation validates IDs and fee fields before database access', async () => {
  const res = response();
  await createTrainerPTPackage({
    params: { id: 'not-an-object-id' },
    body: {}
  }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /trainer and member IDs/i);
});

test('PT payment rejects zero, invalid, and unsupported payment methods', async () => {
  const res = response();
  await recordTrainerPTPayment({
    params: { packageId: '507f1f77bcf86cd799439011' },
    body: { amount: 0, paymentMethod: 'Bitcoin' }
  }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /payment amount and method/i);
});

test('PT payment ledger enforces business-scoped request idempotency', () => {
  const requestIndex = TrainerPTPayment.schema.indexes().find(([keys, options]) =>
    keys.businessId === 1 && keys.requestId === 1 && options.unique
  );
  assert.ok(requestIndex);
  assert.deepEqual(requestIndex[1].partialFilterExpression, {
    requestId: { $type: 'string', $gt: '' }
  });
});

test('PT payment recording updates package balance once and replays the same request safely', async t => {
  const packageId = '507f1f77bcf86cd799439011';
  const packageRecord = {
    _id: new mongoose.Types.ObjectId(packageId),
    tenantId: '507f1f77bcf86cd799439012',
    businessId: '507f1f77bcf86cd799439013',
    memberId: '507f1f77bcf86cd799439014',
    trainerId: '507f1f77bcf86cd799439015',
    assignmentId: null,
    totalFeeMinor: 600000,
    collectedAmountMinor: 0,
    toObject() {
      return { _id: this._id, totalFeeMinor: this.totalFeeMinor };
    }
  };
  const records = [];
  let updateCount = 0;
  const session = {
    withTransaction: callback => callback(),
    endSession: async () => {}
  };
  t.mock.method(mongoose, 'startSession', async () => session);
  t.mock.method(TrainerPTPackage, 'findOne', filter => {
    if (filter._id) assert.equal(String(filter._id), packageId);
    const query = {
      session: async () => packageRecord,
      then: (resolve, reject) => Promise.resolve(packageRecord).then(resolve, reject)
    };
    return query;
  });
  t.mock.method(TrainerPTPackage, 'updateOne', async (_filter, update) => {
    updateCount += 1;
    if (packageRecord.collectedAmountMinor + update.$inc.collectedAmountMinor > packageRecord.totalFeeMinor) {
      return { matchedCount: 0 };
    }
    packageRecord.collectedAmountMinor += update.$inc.collectedAmountMinor;
    return { matchedCount: 1 };
  });
  t.mock.method(TrainerPTPayment, 'findOne', filter => {
    const query = {
      session: async () => records.find(payment => payment.requestId === filter.requestId) || null,
      lean: async () => records.find(payment => payment.requestId === filter.requestId) || null
    };
    return query;
  });
  t.mock.method(TrainerPTPayment, 'exists', () => ({
    session: async () => false
  }));
  t.mock.method(TrainerPTPayment, 'find', () => ({
    sort() {
      return this;
    },
    session() {
      return this;
    },
    lean: async () => records
  }));
  t.mock.method(TrainerPTPayment, 'create', async ([payment]) => {
    const saved = {
      ...payment,
      _id: new mongoose.Types.ObjectId(),
      refunds: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };
    records.push(saved);
    return [saved];
  });

  const request = (amount = 3000, requestId = 'payment-request-1', reference = 'PT-REF-1') => ({
    params: { packageId },
    tenantId: packageRecord.tenantId,
    owner: { businessId: packageRecord.businessId, _id: '507f1f77bcf86cd799439016' },
    body: {
      amount,
      paymentMethod: 'UPI',
      transactionReference: reference,
      paymentDate: '2026-11-09',
      notes: 'Installment',
      requestId
    }
  });
  const firstResponse = response();
  await recordTrainerPTPayment(request(), firstResponse);
  assert.equal(firstResponse.statusCode, 201);
  assert.equal(firstResponse.body.package.collectedAmount, 3000);
  assert.equal(firstResponse.body.package.pendingAmount, 3000);
  assert.equal(firstResponse.body.package.paymentStatus, 'Partial');
  assert.equal(firstResponse.body.package.payments.length, 1);

  const replayResponse = response();
  await recordTrainerPTPayment(request(), replayResponse);
  assert.equal(replayResponse.statusCode, 200);
  assert.equal(replayResponse.body.duplicate, true);
  assert.equal(replayResponse.body.package.collectedAmount, 3000);
  assert.equal(records.length, 1);
  assert.equal(updateCount, 1);

  const overpaymentResponse = response();
  await recordTrainerPTPayment(request(3500, 'payment-request-overpay', 'PT-REF-OVERPAY'), overpaymentResponse);
  assert.equal(overpaymentResponse.statusCode, 409);
  assert.match(overpaymentResponse.body.message, /exceeds the PT package outstanding balance/i);
  assert.equal(records.length, 1);

  const remainingResponse = response();
  await recordTrainerPTPayment(request(3000, 'payment-request-2', 'PT-REF-2'), remainingResponse);
  assert.equal(remainingResponse.statusCode, 201);
  assert.equal(remainingResponse.body.package.collectedAmount, 6000);
  assert.equal(remainingResponse.body.package.pendingAmount, 0);
  assert.equal(remainingResponse.body.package.paymentStatus, 'Paid');
  assert.equal(records.length, 2);
});

test('PT refund requires explicit completion confirmation and reason', async () => {
  const res = response();
  await refundTrainerPTPayment({
    params: { paymentId: '507f1f77bcf86cd799439011' },
    body: { amount: 10, refundReference: 'R-1', reason: '', confirmRefund: false }
  }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /completed refund/i);
});

test('trainer assignment validates roles before opening a database transaction', async () => {
  const res = response();
  await assignMemberToTrainer({
    params: { id: '507f1f77bcf86cd799439011' },
    body: {
      memberId: '507f1f77bcf86cd799439012',
      assignmentRole: 'Manager'
    }
  }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /assignment role/i);
});
