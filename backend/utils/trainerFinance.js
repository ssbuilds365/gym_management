const netPaymentMinor = payment => {
  const refunded = (payment.refunds || []).reduce(
    (total, refund) => total + Number(refund.amountMinor || 0),
    0
  );
  return Math.max(0, Number(payment.amountMinor || 0) - refunded);
};

const packageBalance = (totalFeeMinor, payments) => {
  const collectedMinor = payments
    .filter(payment => ['Success', 'Refunded'].includes(payment.status))
    .reduce((total, payment) => total + netPaymentMinor(payment), 0);
  const expectedMinor = Number(totalFeeMinor);
  return {
    expectedMinor,
    collectedMinor,
    pendingMinor: Math.max(0, expectedMinor - collectedMinor),
    paymentStatus: collectedMinor >= expectedMinor
      ? 'Paid'
      : collectedMinor > 0
        ? 'Partial'
        : 'Pending'
  };
};

const trainerContributionMinor = ({
  ptCollectedMinor,
  fixedSalaryMinor,
  approvedIncentivesMinor,
  approvedDirectExpensesMinor
}) => Number(ptCollectedMinor || 0)
  - Number(fixedSalaryMinor || 0)
  - Number(approvedIncentivesMinor || 0)
  - Number(approvedDirectExpensesMinor || 0);

const estimatedNetProfitMinor = (contributionMinor, allocatedOverheadMinor) =>
  Number(contributionMinor || 0) - Number(allocatedOverheadMinor || 0);

module.exports = {
  netPaymentMinor,
  packageBalance,
  trainerContributionMinor,
  estimatedNetProfitMinor
};
