const Member = require('../models/Member');
const MemberMembership = require('../models/MemberMembership');
const Payment = require('../models/Payment');
const TrainerStaff = require('../models/TrainerStaff');
const TrainerPTPackage = require('../models/TrainerPTPackage');
const TrainerPTPayment = require('../models/TrainerPTPayment');
const { fromMinorUnits, toMinorUnits } = require('../utils/currency');
const { netPaymentMinor } = require('../utils/trainerFinance');

const trainerFinancialPerformance = async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const businessId = req.owner.businessId;
    const [trainers, members, memberships, membershipPayments, ptPackages, ptPayments] = await Promise.all([
      TrainerStaff.find({ tenantId, role: 'Trainer' })
        .select('_id name status specialization salaryAmount compensationType')
        .sort({ name: 1 })
        .lean(),
      Member.find({
        tenantId,
        businessId,
        deletedAt: null
      }).select('_id status assignedTrainerId additionalTrainerIds').lean(),
      MemberMembership.find({
        tenantId,
        businessId,
        attributedTrainerId: { $ne: null },
        status: { $ne: 'Cancelled' }
      }).select('_id memberId attributedTrainerId planPrice startDate endDate status').lean(),
      Payment.find({
        tenantId,
        businessId,
        attributedTrainerId: { $ne: null },
        status: { $in: ['Success', 'Refunded'] }
      }).select('membershipId attributedTrainerId amount status paymentDate').lean(),
      TrainerPTPackage.find({
        tenantId,
        businessId,
        status: { $ne: 'Cancelled' }
      }).select('_id memberId trainerId totalFeeMinor startDate endDate status').lean(),
      TrainerPTPayment.find({
        tenantId,
        businessId,
        status: { $in: ['Success', 'Refunded'] }
      }).select('packageId trainerId amountMinor refunds status paymentDate').lean()
    ]);

    const trainerIds = new Set(trainers.map(row => String(row._id)));
    const summary = new Map(trainers.map(trainer => [String(trainer._id), {
      assignedMemberIds: new Set(),
      activeGymMemberIds: new Set(),
      activePTMemberIds: new Set(),
      membershipExpectedMinor: 0,
      membershipCollectedMinor: 0,
      ptExpectedMinor: 0,
      ptCollectedMinor: 0
    }]));

    let membersWithoutTrainer = 0;
    for (const member of members) {
      const assigned = new Set([
        ...(member.assignedTrainerId ? [String(member.assignedTrainerId)] : []),
        ...(member.additionalTrainerIds || []).map(String)
      ].filter(id => trainerIds.has(id)));
      if (!assigned.size) membersWithoutTrainer += 1;
      assigned.forEach(id => summary.get(id).assignedMemberIds.add(String(member._id)));
    }

    const membershipById = new Map(memberships.map(record => [String(record._id), record]));
    for (const membership of memberships) {
      const row = summary.get(String(membership.attributedTrainerId));
      if (!row) continue;
      const priceMinor = toMinorUnits(membership.planPrice);
      if (priceMinor === null) {
        throw new Error(`Invalid membership amount for membership ${membership._id}`);
      }
      row.membershipExpectedMinor += priceMinor;
      const now = new Date();
      if (
        membership.status === 'Active' &&
        new Date(membership.startDate) <= now &&
        new Date(membership.endDate) >= now
      ) {
        row.activeGymMemberIds.add(String(membership.memberId));
      }
    }

    for (const payment of membershipPayments) {
      const membership = membershipById.get(String(payment.membershipId));
      const row = summary.get(String(payment.attributedTrainerId));
      if (!membership || !row || payment.status !== 'Success') continue;
      const amountMinor = toMinorUnits(payment.amount);
      if (amountMinor === null) throw new Error(`Invalid membership payment amount`);
      row.membershipCollectedMinor += amountMinor;
    }

    const packageById = new Map(ptPackages.map(record => [String(record._id), record]));
    for (const ptPackage of ptPackages) {
      const row = summary.get(String(ptPackage.trainerId));
      if (!row) continue;
      row.ptExpectedMinor += Number(ptPackage.totalFeeMinor || 0);
      const now = new Date();
      if (
        ptPackage.status === 'Active' &&
        new Date(ptPackage.startDate) <= now &&
        new Date(ptPackage.endDate) >= now
      ) {
        row.activePTMemberIds.add(String(ptPackage.memberId));
      }
    }

    for (const payment of ptPayments) {
      const ptPackage = packageById.get(String(payment.packageId));
      const row = summary.get(String(payment.trainerId));
      if (!ptPackage || !row) continue;
      row.ptCollectedMinor += netPaymentMinor(payment);
    }

    const performance = trainers.map(trainer => {
      const row = summary.get(String(trainer._id));
      const membershipPendingMinor = Math.max(
        0,
        row.membershipExpectedMinor - row.membershipCollectedMinor
      );
      const ptPendingMinor = Math.max(0, row.ptExpectedMinor - row.ptCollectedMinor);
      return {
        trainer: {
          _id: trainer._id,
          name: trainer.name,
          status: trainer.status,
          specialization: trainer.specialization || ''
        },
        clients: {
          totalUniqueAssigned: row.assignedMemberIds.size,
          activeGymMembers: row.activeGymMemberIds.size,
          activePTClients: row.activePTMemberIds.size
        },
        gymMembership: {
          expected: fromMinorUnits(row.membershipExpectedMinor),
          collected: fromMinorUnits(row.membershipCollectedMinor),
          pending: fromMinorUnits(membershipPendingMinor),
          attribution: 'Primary trainer at membership issue; legacy records without a snapshot are excluded.'
        },
        personalTraining: {
          expected: fromMinorUnits(row.ptExpectedMinor),
          collected: fromMinorUnits(row.ptCollectedMinor),
          pending: fromMinorUnits(ptPendingMinor)
        },
        collectionEfficiency: {
          gymMembership: row.membershipExpectedMinor
            ? Number((row.membershipCollectedMinor / row.membershipExpectedMinor * 100).toFixed(2))
            : null,
          personalTraining: row.ptExpectedMinor
            ? Number((row.ptCollectedMinor / row.ptExpectedMinor * 100).toFixed(2))
            : null
        },
        salaryTransactionsAvailable: false,
        incentivesAvailable: false,
        directExpensesAvailable: false,
        overheadAllocationAvailable: false
      };
    });

    return res.json({
      success: true,
      period: 'All time',
      summary: {
        totalTrainers: trainers.length,
        activeTrainers: trainers.filter(trainer => trainer.status === 'Active').length,
        inactiveTrainers: trainers.filter(trainer => trainer.status !== 'Active').length,
        totalAssignedMemberLinks: performance.reduce((total, row) => total + row.clients.totalUniqueAssigned, 0),
        membersWithoutTrainer: membersWithoutTrainer,
        gymMembershipExpected: performance.reduce((total, row) => total + row.gymMembership.expected, 0),
        gymMembershipCollected: performance.reduce((total, row) => total + row.gymMembership.collected, 0),
        gymMembershipPending: performance.reduce((total, row) => total + row.gymMembership.pending, 0),
        ptExpected: performance.reduce((total, row) => total + row.personalTraining.expected, 0),
        ptCollected: performance.reduce((total, row) => total + row.personalTraining.collected, 0),
        ptPending: performance.reduce((total, row) => total + row.personalTraining.pending, 0)
      },
      trainers: performance,
      limitations: [
        'Salary profile amounts are not salary transactions and are not included in contribution.',
        'Incentive, direct-expense and overhead ledgers are not configured; contribution and estimated net profit are therefore unavailable.',
        'Membership attribution is only reported where the trainer was snapshotted when the membership was issued. Existing records are not retroactively attributed.'
      ]
    });
  } catch (error) {
    console.error('Trainer financial performance error:', error);
    return res.status(500).json({
      success: false,
      message: 'Unable to load trainer financial performance'
    });
  }
};

module.exports = { trainerFinancialPerformance };
