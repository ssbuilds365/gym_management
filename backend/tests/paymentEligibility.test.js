const test = require('node:test');
const assert = require('node:assert/strict');
const MemberMembership = require('../models/MemberMembership');
const TrainerPTPackage = require('../models/TrainerPTPackage');
const { getEligiblePaymentMembers } = require('../controllers/paymentController');

const createResponse = () => ({
  statusCode: 200,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});

test('eligible payment endpoint rejects unsupported categories without querying data', async () => {
  const response = createResponse();
  await getEligiblePaymentMembers({
    query: { category: 'membership' },
    tenantId: 'tenant-id',
    owner: { businessId: 'business-id' }
  }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.success, false);
});

test('gym membership eligibility is calculated from tenant-scoped successful payments', async t => {
  const tenantId = 'tenant-id';
  const businessId = 'business-id';
  let pipeline;
  t.mock.method(MemberMembership, 'aggregate', async value => {
    pipeline = value;
    return [{
      _id: 'member-id',
      fullName: 'Alex Member',
      phone: '5551234567',
      totalFee: 10000,
      alreadyPaid: 4000,
      pendingAmount: 6000,
      memberships: [{ _id: 'membership-id', pendingAmount: 6000 }]
    }];
  });

  const response = createResponse();
  await getEligiblePaymentMembers({
    query: { category: 'gym-membership' },
    tenantId,
    owner: { businessId }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.category, 'gym-membership');
  assert.equal(response.body.members[0].pendingAmount, 6000);
  assert.equal(pipeline[0].$match.tenantId, tenantId);
  assert.equal(pipeline[0].$match.businessId, businessId);
  const paymentLookup = pipeline.find(stage => stage.$lookup?.from === 'payments').$lookup;
  assert.ok(JSON.stringify(paymentLookup.pipeline).includes('"Success"'));
  const eligibleStage = pipeline.find(stage => stage.$match?.pendingAmount);
  assert.deepEqual(eligibleStage.$match.pendingAmount, { $gt: 0 });
});

test('PT eligibility only queries outstanding packages in the authenticated business', async t => {
  const tenantId = 'tenant-id';
  const businessId = 'business-id';
  let pipeline;
  t.mock.method(TrainerPTPackage, 'aggregate', async value => {
    pipeline = value;
    return [{
      _id: 'member-id',
      fullName: 'Alex Member',
      phone: '5551234567',
      totalFee: 5000,
      alreadyPaid: 2000,
      pendingAmount: 3000,
      ptPackages: [{ _id: 'package-id', pendingAmount: 3000 }]
    }];
  });

  const response = createResponse();
  await getEligiblePaymentMembers({
    query: { category: 'personal-training' },
    tenantId,
    owner: { businessId }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.category, 'personal-training');
  assert.equal(response.body.members[0].pendingAmount, 3000);
  assert.equal(pipeline[0].$match.tenantId, tenantId);
  assert.equal(pipeline[0].$match.businessId, businessId);
  assert.deepEqual(pipeline[0].$match.$expr, {
    $gt: ['$totalFeeMinor', '$collectedAmountMinor']
  });
});
