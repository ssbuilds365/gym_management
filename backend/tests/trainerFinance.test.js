const test = require('node:test');
const assert = require('node:assert/strict');
const {
  netPaymentMinor,
  packageBalance,
  trainerContributionMinor,
  estimatedNetProfitMinor
} = require('../utils/trainerFinance');

test('personal training package balance subtracts partial and full refunds from successful collections', () => {
  const balance = packageBalance(300000, [
    { amountMinor: 200000, status: 'Success', refunds: [{ amountMinor: 50000 }] },
    { amountMinor: 100000, status: 'Refunded', refunds: [{ amountMinor: 100000 }] },
    { amountMinor: 25000, status: 'Failed', refunds: [] }
  ]);

  assert.equal(balance.expectedMinor, 300000);
  assert.equal(balance.collectedMinor, 150000);
  assert.equal(balance.pendingMinor, 150000);
  assert.equal(balance.paymentStatus, 'Partial');
  assert.equal(netPaymentMinor({ amountMinor: 200000, refunds: [{ amountMinor: 50000 }] }), 150000);
});

test('trainer contribution and estimated net profit remain separate calculations', () => {
  const contribution = trainerContributionMinor({
    ptCollectedMinor: 4000000,
    fixedSalaryMinor: 1500000,
    approvedIncentivesMinor: 200000,
    approvedDirectExpensesMinor: 100000
  });

  assert.equal(contribution, 2200000);
  assert.equal(estimatedNetProfitMinor(contribution, 300000), 1900000);
});

test('unrecorded amounts are not treated as financial inputs', () => {
  assert.equal(trainerContributionMinor({
    ptCollectedMinor: 0,
    fixedSalaryMinor: 0,
    approvedIncentivesMinor: 0,
    approvedDirectExpensesMinor: 0
  }), 0);
  assert.equal(estimatedNetProfitMinor(0, 0), 0);
});
