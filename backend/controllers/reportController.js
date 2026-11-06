const mongoose = require('mongoose');
const Attendance = require('../models/Attendance');
const Business = require('../models/Business');
const Member = require('../models/Member');
const MemberMembership = require('../models/MemberMembership');
const Payment = require('../models/Payment');
const TrainerStaff = require('../models/TrainerStaff');
const { resolveReportPeriod } = require('../utils/reportPeriods');

const rangeMatch = range => ({ $gte: range.from, $lt: range.toExclusive });
const total = (rows, key) => rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);

const memberLookup = tenantId => ({
  $lookup: {
    from: 'members',
    let: { memberId: '$memberId' },
    pipeline: [{
      $match: {
        $expr: {
          $and: [
            { $eq: ['$_id', '$$memberId'] },
            { $eq: ['$tenantId', tenantId] },
            { $eq: ['$deletedAt', null] }
          ]
        }
      }
    }],
    as: 'member'
  }
});

const membershipLookup = tenantId => ({
  $lookup: {
    from: 'membermemberships',
    let: { membershipId: '$membershipId' },
    pipeline: [{
      $match: {
        $expr: {
          $and: [
            { $eq: ['$_id', '$$membershipId'] },
            { $eq: ['$tenantId', tenantId] }
          ]
        }
      }
    }],
    as: 'membership'
  }
});

const planLookup = tenantId => ({
  $lookup: {
    from: 'membershipplans',
    let: { planId: { $arrayElemAt: ['$membership.planId', 0] } },
    pipeline: [{
      $match: {
        $expr: {
          $and: [
            { $eq: ['$_id', '$$planId'] },
            { $eq: ['$tenantId', tenantId] }
          ]
        }
      }
    }],
    as: 'plan'
  }
});

const getOverview = async ({ tenantId, businessId, range, now }) => {
  const paymentMatch = { tenantId, businessId };
  const memberMatch = { tenantId, businessId, deletedAt: null };
  const membershipMatch = { tenantId, businessId };
  const activeMembership = {
    status: { $ne: 'Cancelled' },
    startDate: { $lte: range.to },
    endDate: { $gte: range.from }
  };
  const [
    payments,
    currentFees,
    members,
    attendanceByMonth,
    planDistribution,
    membershipCounts,
    attendanceSummary,
    attendanceByWeekday,
    peakHours,
    trainerSummary,
    staffSummary,
    gstSummary,
    expiryRows,
    attendanceLeaders
  ] = await Promise.all([
    Payment.aggregate([
      { $match: paymentMatch },
      {
        $facet: {
          successful: [
            { $match: { status: 'Success', paymentDate: rangeMatch(range) } },
            {
              $group: {
                _id: null,
                amount: { $sum: '$amount' },
                count: { $sum: 1 },
                average: { $avg: '$amount' }
              }
            }
          ],
          pending: [
            { $match: { status: 'Pending', paymentDate: rangeMatch(range) } },
            { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }
          ],
          refunded: [
            { $match: { status: 'Refunded', 'refund.refundedAt': rangeMatch(range) } },
            { $group: { _id: null, amount: { $sum: '$refund.amount' }, count: { $sum: 1 } } }
          ],
          failed: [
            { $match: { status: 'Failed', paymentDate: rangeMatch(range) } },
            { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }
          ],
          methodCollection: [
            { $match: { status: 'Success', paymentDate: rangeMatch(range) } },
            { $group: { _id: '$paymentMethod', amount: { $sum: '$amount' }, count: { $sum: 1 } } },
            { $sort: { amount: -1 } }
          ],
          paymentStatus: [
            { $match: { paymentDate: rangeMatch(range) } },
            { $group: { _id: '$status', amount: { $sum: '$amount' }, count: { $sum: 1 } } }
          ],
          monthly: [
            { $match: { status: 'Success', paymentDate: rangeMatch(range) } },
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m', date: '$paymentDate', timezone: range.timeZone } },
                amount: { $sum: '$amount' },
                count: { $sum: 1 }
              }
            },
            { $sort: { _id: 1 } }
          ],
          planRevenue: [
            { $match: { status: 'Success', paymentDate: rangeMatch(range) } },
            membershipLookup(tenantId),
            { $unwind: '$membership' },
            {
              $lookup: {
                from: 'membershipplans',
                let: { planId: '$membership.planId' },
                pipeline: [{
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$_id', '$$planId'] },
                        { $eq: ['$tenantId', tenantId] }
                      ]
                    }
                  }
                }],
                as: 'plan'
              }
            },
            { $unwind: { path: '$plan', preserveNullAndEmptyArrays: true } },
            {
              $group: {
                _id: { $ifNull: ['$plan._id', 'unknown'] },
                name: { $first: { $ifNull: ['$plan.planName', 'Unassigned plan'] } },
                amount: { $sum: '$amount' },
                count: { $sum: 1 }
              }
            },
            { $sort: { amount: -1 } }
          ],
          daily: [
            { $match: { status: 'Success', paymentDate: rangeMatch(range) } },
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$paymentDate', timezone: range.timeZone } },
                amount: { $sum: '$amount' },
                count: { $sum: 1 }
              }
            },
            { $sort: { _id: 1 } }
          ]
        }
      }
    ]),
    MemberMembership.aggregate([
      { $match: { ...membershipMatch, status: { $ne: 'Cancelled' } } },
      {
        $lookup: {
          from: 'members',
          let: { memberId: '$memberId' },
          pipeline: [{
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$_id', '$$memberId'] },
                  { $eq: ['$tenantId', tenantId] },
                  { $eq: ['$businessId', businessId] },
                  { $eq: ['$deletedAt', null] }
                ]
              }
            }
          }],
          as: 'member'
        }
      },
      { $match: { 'member.0': { $exists: true } } },
      {
        $lookup: {
          from: 'payments',
          let: { membershipId: '$_id' },
          pipeline: [{
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$membershipId', '$$membershipId'] },
                  { $eq: ['$tenantId', tenantId] },
                  { $eq: ['$businessId', businessId] },
                  { $eq: ['$status', 'Success'] }
                ]
              }
            }
          }],
          as: 'successfulPayments'
        }
      },
      {
        $addFields: {
          ledgerPaid: { $sum: '$successfulPayments.amount' },
          due: { $max: [0, { $subtract: ['$planPrice', { $sum: '$successfulPayments.amount' }] }] }
        }
      },
      { $group: { _id: null, due: { $sum: '$due' } } }
    ]),
    Member.aggregate([
      { $match: memberMatch },
      {
        $facet: {
          joined: [
            { $match: { joiningDate: rangeMatch(range) } },
            { $group: { _id: null, count: { $sum: 1 } } }
          ],
          status: [
            { $group: { _id: '$status', count: { $sum: 1 } } }
          ],
          total: [
            { $count: 'count' }
          ],
          monthly: [
            { $match: { joiningDate: rangeMatch(range) } },
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m', date: '$joiningDate', timezone: range.timeZone } },
                count: { $sum: 1 }
              }
            },
            { $sort: { _id: 1 } }
          ],
        }
      }
    ]),
    Attendance.aggregate([
      { $match: { tenantId, businessId, attendanceDate: rangeMatch(range) } },
      {
        $group: {
          _id: {
            day: { $dateToString: { format: '%Y-%m-%d', date: '$attendanceDate', timezone: range.timeZone } },
            memberId: '$memberId'
          },
          month: { $first: { $dateToString: { format: '%Y-%m', date: '$attendanceDate', timezone: range.timeZone } } }
        }
      },
      {
        $group: {
          _id: '$month',
          visits: { $sum: 1 },
          members: { $addToSet: '$_id.memberId' }
        }
      },
      { $project: { visits: 1, uniqueMembers: { $size: '$members' } } },
      { $sort: { _id: 1 } }
    ]),
    MemberMembership.aggregate([
      { $match: { ...membershipMatch, ...activeMembership } },
      {
        $lookup: {
          from: 'members',
          let: { memberId: '$memberId' },
          pipeline: [{
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$_id', '$$memberId'] },
                  { $eq: ['$tenantId', tenantId] },
                  { $eq: ['$businessId', businessId] },
                  { $eq: ['$deletedAt', null] }
                ]
              }
            }
          }],
          as: 'member'
        }
      },
      { $match: { 'member.0': { $exists: true } } },
      {
        $lookup: {
          from: 'membershipplans',
          let: { planId: '$planId' },
          pipeline: [{
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$_id', '$$planId'] },
                  { $eq: ['$tenantId', tenantId] }
                ]
              }
            }
          }],
          as: 'plan'
        }
      },
      { $unwind: { path: '$plan', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: { $ifNull: ['$plan._id', 'unknown'] },
          name: { $first: { $ifNull: ['$plan.planName', 'Unassigned plan'] } },
          count: { $sum: 1 },
          revenue: { $sum: '$planPrice' }
        }
      },
      { $sort: { count: -1 } }
    ]),
    MemberMembership.aggregate([
      { $match: membershipMatch },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]),
    Attendance.aggregate([
      { $match: { tenantId, businessId, attendanceDate: rangeMatch(range) } },
      {
        $group: {
          _id: {
            day: { $dateToString: { format: '%Y-%m-%d', date: '$attendanceDate', timezone: range.timeZone } },
            memberId: '$memberId'
          },
          memberId: { $first: '$memberId' },
          attendanceType: { $first: '$attendanceType' }
        }
      },
      {
        $group: {
          _id: null,
          visits: { $sum: 1 },
          uniqueMembers: { $addToSet: '$memberId' },
          sourceRows: { $push: '$attendanceType' }
        }
      },
      {
        $project: {
          visits: 1,
          uniqueMemberCount: { $size: '$uniqueMembers' },
          sources: '$sourceRows'
        }
      }
    ]),
    Attendance.aggregate([
      { $match: { tenantId, businessId, attendanceDate: rangeMatch(range) } },
      {
        $group: {
          _id: {
            day: { $dateToString: { format: '%Y-%m-%d', date: '$attendanceDate', timezone: range.timeZone } },
            memberId: '$memberId'
          },
          weekday: { $first: { $dayOfWeek: { date: '$attendanceDate', timezone: range.timeZone } } }
        }
      },
      {
        $group: {
          _id: '$weekday',
          visits: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]),
    Attendance.aggregate([
      { $match: { tenantId, businessId, checkIn: rangeMatch(range) } },
      {
        $group: {
          _id: {
            day: { $dateToString: { format: '%Y-%m-%d', date: '$checkIn', timezone: range.timeZone } },
            memberId: '$memberId',
            hour: { $hour: { date: '$checkIn', timezone: range.timeZone } }
          }
        }
      },
      {
        $group: {
          _id: '$_id.hour',
          visits: { $sum: 1 }
        }
      },
      { $sort: { visits: -1 } },
      { $limit: 5 }
    ]),
    TrainerStaff.aggregate([
      { $match: { tenantId, role: 'Trainer' } },
      {
        $lookup: {
          from: 'members',
          let: { trainerId: '$_id' },
          pipeline: [{
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$assignedTrainerId', '$$trainerId'] },
                  { $eq: ['$tenantId', tenantId] },
                  { $eq: ['$deletedAt', null] }
                ]
              }
            }
          }],
          as: 'assignedMembers'
        }
      },
      {
        $group: {
          _id: '$status',
          trainers: { $sum: 1 },
          assignedMembers: { $sum: { $size: '$assignedMembers' } }
        }
      }
    ]),
    TrainerStaff.aggregate([
      { $match: { tenantId, role: 'Staff' } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    Payment.aggregate([
      {
        $match: {
          ...paymentMatch,
          status: { $in: ['Success', 'Refunded'] },
          'receiptSnapshot.taxInvoice.issueDate': rangeMatch(range)
        }
      },
      { $match: { 'receiptSnapshot.taxInvoice': { $exists: true, $ne: null } } },
      {
        $group: {
          _id: '$receiptSnapshot.taxInvoice.invoiceNumber',
          taxableAmount: { $first: '$receiptSnapshot.taxInvoice.taxableAmount' },
          cgst: { $first: '$receiptSnapshot.taxInvoice.cgst' },
          sgst: { $first: '$receiptSnapshot.taxInvoice.sgst' },
          igst: { $first: '$receiptSnapshot.taxInvoice.igst' },
          tax: { $first: '$receiptSnapshot.taxInvoice.totalTax' },
          total: { $first: '$receiptSnapshot.taxInvoice.totalAmount' }
        }
      },
      {
        $group: {
          _id: null,
          invoices: { $sum: 1 },
          taxableAmount: { $sum: '$taxableAmount' },
          cgst: { $sum: '$cgst' },
          sgst: { $sum: '$sgst' },
          igst: { $sum: '$igst' },
          tax: { $sum: '$tax' },
          total: { $sum: '$total' }
        }
      }
    ]),
    MemberMembership.aggregate([
      { $match: {
        tenantId,
        businessId,
        status: { $ne: 'Cancelled' },
        endDate: { $gte: now, $lt: new Date(now.getTime() + 30 * 86400000) }
      } },
      {
        $lookup: {
          from: 'members',
          let: { memberId: '$memberId' },
          pipeline: [{
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$_id', '$$memberId'] },
                  { $eq: ['$tenantId', tenantId] },
                  { $eq: ['$businessId', businessId] },
                  { $eq: ['$deletedAt', null] }
                ]
              }
            }
          }],
          as: 'member'
        }
      },
      { $match: { 'member.0': { $exists: true } } },
      { $unwind: '$member' },
      {
        $facet: {
          count: [{ $count: 'total' }],
          records: [
            { $sort: { endDate: 1 } },
            { $limit: 5 },
            {
              $project: {
                _id: 1,
                endDate: 1,
                member: {
                  _id: '$member._id',
                  fullName: '$member.fullName',
                  phone: '$member.phone'
                }
              }
            }
          ]
        }
      }
    ]),
    Member.aggregate([
      { $match: { ...memberMatch, status: 'Active' } },
      {
        $lookup: {
          from: 'attendances',
          let: { memberId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$memberId', '$$memberId'] },
                    { $eq: ['$tenantId', tenantId] },
                    { $eq: ['$businessId', businessId] },
                    { $gte: ['$attendanceDate', range.from] },
                    { $lt: ['$attendanceDate', range.toExclusive] }
                  ]
                }
              }
            },
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$attendanceDate', timezone: range.timeZone } }
              }
            }
          ],
          as: 'attendanceDays'
        }
      },
      { $addFields: { visits: { $size: '$attendanceDays' } } },
      {
        $facet: {
          low: [
            { $sort: { visits: 1, fullName: 1 } },
            { $limit: 5 },
            { $project: { _id: 1, fullName: 1, phone: 1, visits: 1 } }
          ],
          high: [
            { $sort: { visits: -1, fullName: 1 } },
            { $limit: 5 },
            { $project: { _id: 1, fullName: 1, phone: 1, visits: 1 } }
          ]
        }
      }
    ])
  ]);

  const payment = payments[0] || {};
  const successful = payment.successful?.[0] || {};
  const pending = payment.pending?.[0] || {};
  const refunded = payment.refunded?.[0] || {};
  const failed = payment.failed?.[0] || {};
  const memberData = members[0] || {};
  const memberStatus = Object.fromEntries((memberData.status || []).map(row => [row._id, row.count]));
  const attendeeCount = attendanceSummary[0]?.uniqueMemberCount || 0;
  const activeMemberCount = memberStatus.Active || 0;
  const fromParts = range.fromDate.split('-').map(Number);
  const toParts = range.toDate.split('-').map(Number);
  const daysInRange = Math.max(
    1,
    Math.floor((
      Date.UTC(toParts[0], toParts[1] - 1, toParts[2]) -
      Date.UTC(fromParts[0], fromParts[1] - 1, fromParts[2])
    ) / 86400000) + 1
  );
  const averageDailyAttendance = total(attendanceByMonth, 'visits') / daysInRange;
  const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const weekdays = attendanceByWeekday.map(row => ({
    day: weekdayNames[(row._id - 1) % 7],
    visits: row.visits
  }));
  const sources = (attendanceSummary[0]?.sources || []).reduce((result, source) => {
    const key = ['Manual', 'QR', 'Biometric'].includes(source) ? source : 'Other';
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
  const trainers = Object.fromEntries(trainerSummary.map(row => [row._id, row]));
  const staff = Object.fromEntries(staffSummary.map(row => [row._id, row.count]));
  const retentionBase = await MemberMembership.aggregate([
    { $match: { ...membershipMatch, status: { $ne: 'Cancelled' }, startDate: { $lte: range.from }, endDate: { $gte: range.from } } },
    { $group: { _id: '$memberId' } },
    {
      $lookup: {
        from: 'members',
        let: { memberId: '$_id' },
        pipeline: [{
          $match: {
            $expr: {
              $and: [
                { $eq: ['$_id', '$$memberId'] },
                { $eq: ['$tenantId', tenantId] },
                { $eq: ['$businessId', businessId] },
                { $eq: ['$deletedAt', null] }
              ]
            }
          }
        }],
        as: 'member'
      }
    },
    { $match: { 'member.0': { $exists: true } } },
    {
      $lookup: {
        from: 'membermemberships',
        let: { memberId: '$_id' },
        pipeline: [{
          $match: {
            $expr: {
              $and: [
                { $eq: ['$memberId', '$$memberId'] },
                { $eq: ['$tenantId', tenantId] },
                { $eq: ['$businessId', businessId] },
                { $ne: ['$status', 'Cancelled'] },
                { $lte: ['$startDate', range.to] },
                { $gte: ['$endDate', range.to] }
              ]
            }
          }
        }],
        as: 'retained'
      }
    },
    {
      $group: {
        _id: null,
        cohort: { $sum: 1 },
        retained: { $sum: { $cond: [{ $gt: [{ $size: '$retained' }, 0] }, 1, 0] } }
      }
    }
  ]);
  const retention = retentionBase[0] || { cohort: 0, retained: 0 };
  const successfulAmount = successful.amount || 0;
  const refundAmount = refunded.amount || 0;
  const attendanceTrend = attendanceByMonth.map(row => ({
    month: row._id,
    visits: row.visits,
    uniqueMembers: row.uniqueMembers
  }));
  const revenueMap = new Map((payment.monthly || []).map(row => [row._id, row]));
  const growthMap = new Map((memberData.monthly || []).map(row => [row._id, row]));
  const monthKeys = new Set([
    ...revenueMap.keys(),
    ...growthMap.keys(),
    ...attendanceTrend.map(row => row.month)
  ]);
  const months = [...monthKeys].sort();
  const grossPrevious = await Payment.aggregate([
    {
      $match: {
        ...paymentMatch,
        status: 'Success',
        paymentDate: { $gte: range.previousFrom, $lt: range.previousToExclusive }
      }
    },
    { $group: { _id: null, amount: { $sum: '$amount' } } }
  ]);
  const previousRevenue = grossPrevious[0]?.amount || 0;
  const revenueChange = previousRevenue === 0
    ? null
    : ((successfulAmount - previousRevenue) / previousRevenue) * 100;
  const mostPopularPlan = planDistribution[0] || null;
  const highestRegistrationMonth = (memberData.monthly || [])
    .reduce((highest, month) => !highest || month.count > highest.count ? month : highest, null);

  return {
    period: {
      from: range.fromDate,
      to: range.toDate,
      timezone: range.timeZone
    },
    summary: {
      totalRevenue: successfulAmount,
      netCollection: successfulAmount - refundAmount,
      pendingCollection: pending.amount || 0,
      pendingFees: currentFees[0]?.due || 0,
      refunds: refundAmount,
      failedPayments: failed.amount || 0,
      successfulTransactions: successful.count || 0,
      pendingTransactions: pending.count || 0,
      failedTransactions: failed.count || 0,
      refundedTransactions: refunded.count || 0,
      averageTransactionAmount: successful.average || 0,
      totalActiveMembers: activeMemberCount,
      totalMembers: memberData.total?.[0]?.count || 0,
      newMembers: memberData.joined?.[0]?.count || 0,
      inactiveMembers: memberStatus.Inactive || 0,
      retentionRate: retention.cohort
        ? (retention.retained / retention.cohort) * 100
        : null,
      retentionCohort: retention.cohort,
      retainedMembers: retention.retained,
      averageDailyAttendance,
      averageAttendancePercentage: activeMemberCount
        ? (averageDailyAttendance / activeMemberCount) * 100
        : 0,
      distinctAttendingMembers: attendeeCount,
      totalAttendanceVisits: attendanceSummary[0]?.visits || 0,
      totalTrainers: (trainers.Active?.trainers || 0) + (trainers.Inactive?.trainers || 0),
      activeTrainers: trainers.Active?.trainers || 0,
      assignedTrainerMembers: (trainers.Active?.assignedMembers || 0) + (trainers.Inactive?.assignedMembers || 0),
      totalStaff: (staff.Active || 0) + (staff.Inactive || 0),
      activeStaff: staff.Active || 0,
      gst: gstSummary[0] || {
        invoices: 0, taxableAmount: 0, cgst: 0, sgst: 0, igst: 0, tax: 0, total: 0
      },
      comparison: {
        previousPeriodRevenue: previousRevenue,
        changePercentage: revenueChange
      }
    },
    charts: {
      monthlyRevenue: months.map(month => ({
        month,
        amount: revenueMap.get(month)?.amount || 0,
        transactions: revenueMap.get(month)?.count || 0
      })),
      memberGrowth: months.map(month => ({ month, members: growthMap.get(month)?.count || 0 })),
      attendanceTrend: months.map(month => ({
        month,
        visits: attendanceTrend.find(row => row.month === month)?.visits || 0,
        uniqueMembers: attendanceTrend.find(row => row.month === month)?.uniqueMembers || 0
      })),
      membershipPlanDistribution: planDistribution,
      paymentStatusDistribution: payment.paymentStatus || [],
      paymentMethodCollection: payment.methodCollection || [],
      planWiseRevenue: payment.planRevenue || [],
      dailyCollection: payment.daily || [],
      weekdayAttendance: weekdays,
      peakAttendanceHours: peakHours.map(row => ({ hour: row._id, visits: row.visits })),
      attendanceSources: sources
    },
    insights: {
      revenueChange,
      mostPopularPlan,
      upcomingRenewals: expiryRows[0]?.count?.[0]?.total || 0,
      upcomingRenewalRecords: expiryRows[0]?.records || [],
      expiredMemberships: membershipCounts.find(row => row._id === 'Expired')?.count || 0,
      highestRegistrationMonth,
      lowAttendanceMembers: attendanceLeaders[0]?.low || [],
      highestAttendanceMembers: attendanceLeaders[0]?.high || [],
      trainerWorkload: Object.entries(trainers).map(([status, value]) => ({
        status,
        trainers: value.trainers,
        assignedMembers: value.assignedMembers
      }))
    }
  };
};

const sortFields = new Set([
  'paymentDate', 'joiningDate', 'attendanceDate', 'checkIn',
  'startDate', 'endDate', 'issueDate', 'name', 'fullName', 'member.name', 'member.fullName',
  'amount', 'status', 'visits', 'lastVisit'
]);

const getDetails = async ({ type, tenantId, businessId, range, query }) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 25));
  const skip = (page - 1) * limit;
  const sortBy = sortFields.has(query.sortBy)
    ? query.sortBy
    : type === 'trainers' || type === 'staff'
      ? 'name'
      : ['memberships', 'expiring', 'expiredMemberships', 'renewedMemberships', 'nonRenewedMembers'].includes(type)
        ? 'endDate'
        : type === 'attendanceMembers'
          ? 'visits'
          : type === 'attendance'
            ? 'attendanceDate'
          : ['members', 'newMembers', 'activeMembers', 'inactiveMembers', 'unpaid', 'partial', 'fullyPaid'].includes(type)
            ? 'fullName'
            : 'paymentDate';
  const sortDirection = query.sortDirection === 'asc' ? 1 : -1;
  const search = String(query.search || '').trim();
  let pipeline = [];

  if (['revenue', 'refunds', 'failed', 'pending', 'gst'].includes(type)) {
    const timeField = type === 'refunds'
      ? 'refund.refundedAt'
      : type === 'gst'
        ? 'receiptSnapshot.taxInvoice.issueDate'
        : 'paymentDate';
    const match = {
      tenantId,
      businessId,
      [timeField]: rangeMatch(range)
    };
    if (type === 'refunds') match.status = 'Refunded';
    if (type === 'failed') match.status = { $in: ['Failed', 'Cancelled'] };
    if (type === 'pending') match.status = 'Pending';
    if (type === 'revenue') match.status = query.paymentStatus && ['Success', 'Pending', 'Failed', 'Refunded'].includes(query.paymentStatus)
      ? query.paymentStatus
      : 'Success';
    if (type === 'gst') {
      match.status = { $in: ['Success', 'Refunded'] };
      match['receiptSnapshot.taxInvoice'] = { $exists: true, $ne: null };
    }
    if (query.paymentStatus && type !== 'revenue') match.status = query.paymentStatus;
    if (query.paymentMethod) match.paymentMethod = query.paymentMethod;
    pipeline = [
      { $match: match },
      memberLookup(tenantId),
      { $unwind: { path: '$member', preserveNullAndEmptyArrays: true } },
      membershipLookup(tenantId),
      { $unwind: { path: '$membership', preserveNullAndEmptyArrays: true } },
      planLookup(tenantId),
      { $unwind: { path: '$plan', preserveNullAndEmptyArrays: true } }
    ];
    if (query.planId && mongooseObjectId(query.planId)) {
      pipeline.push({ $match: { 'membership.planId': new mongoose.Types.ObjectId(query.planId) } });
    }
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      pipeline.push({
        $match: {
          $or: [
            { 'member.fullName': regex },
            { 'member.phone': regex },
            { 'member._id': mongooseObjectId(search) ? new mongoose.Types.ObjectId(search) : null },
            { transactionId: regex },
            { receiptNumber: regex }
          ]
        }
      });
    }
    if (type === 'gst') {
      pipeline.push({
        $group: {
          _id: '$receiptSnapshot.taxInvoice.invoiceNumber',
          invoiceNumber: { $first: '$receiptSnapshot.taxInvoice.invoiceNumber' },
          issueDate: { $first: '$receiptSnapshot.taxInvoice.issueDate' },
          taxableAmount: { $first: '$receiptSnapshot.taxInvoice.taxableAmount' },
          cgst: { $first: '$receiptSnapshot.taxInvoice.cgst' },
          sgst: { $first: '$receiptSnapshot.taxInvoice.sgst' },
          igst: { $first: '$receiptSnapshot.taxInvoice.igst' },
          totalTax: { $first: '$receiptSnapshot.taxInvoice.totalTax' },
          totalAmount: { $first: '$receiptSnapshot.taxInvoice.totalAmount' },
          member: { $first: '$member' },
          membership: { $first: '$membership' },
          plan: { $first: '$plan' },
          transactionCount: { $sum: 1 },
          statuses: { $addToSet: '$status' }
        }
      });
    }
    if (type === 'gst') {
      pipeline.push({
        $project: {
          _id: 0,
          invoiceNumber: 1,
          issueDate: 1,
          taxableAmount: 1,
          cgst: 1,
          sgst: 1,
          igst: 1,
          totalTax: 1,
          totalAmount: 1,
          transactionCount: 1,
          statuses: 1,
          member: {
            _id: '$member._id',
            name: '$member.fullName',
            phone: '$member.phone'
          },
          membership: {
            _id: '$membership._id',
            planName: '$plan.planName',
            planPrice: '$membership.planPrice'
          }
        }
      });
    } else {
      pipeline.push({
        $project: {
          _id: 1,
          paymentDate: 1,
          amount: 1,
          status: 1,
          paymentMethod: 1,
          paymentType: 1,
          transactionId: 1,
          receiptNumber: 1,
          refund: 1,
          member: { _id: '$member._id', name: '$member.fullName', phone: '$member.phone' },
          membership: { _id: '$membership._id', planName: '$plan.planName', planPrice: '$membership.planPrice' }
        }
      });
    }
  } else if (['attendance', 'attendanceMembers'].includes(type)) {
    const match = {
      tenantId,
      businessId,
      attendanceDate: rangeMatch(range)
    };
    if (query.attendanceStatus && ['Present', 'Absent', 'Late'].includes(query.attendanceStatus)) {
      match.status = query.attendanceStatus;
    }
    if (query.attendanceSource && ['Manual', 'QR', 'Biometric'].includes(query.attendanceSource)) {
      match.attendanceType = query.attendanceSource;
    }
    pipeline = [
      { $match: match },
      memberLookup(tenantId),
      { $unwind: { path: '$member', preserveNullAndEmptyArrays: true } }
    ];
    if (query.trainerId && mongooseObjectId(query.trainerId)) {
      pipeline.push({
        $match: {
          'member.assignedTrainerId': new mongoose.Types.ObjectId(query.trainerId)
        }
      });
    }
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      pipeline.push({
        $match: {
          $or: [
            { 'member.fullName': regex },
            { 'member.phone': regex },
            ...(mongooseObjectId(search) ? [{ 'member._id': new mongoose.Types.ObjectId(search) }] : [])
          ]
        }
      });
    }
    if (type === 'attendanceMembers') {
      pipeline.push(
        {
          $group: {
            _id: {
              day: { $dateToString: { format: '%Y-%m-%d', date: '$attendanceDate', timezone: range.timeZone } },
              memberId: '$member._id'
            },
            name: { $first: '$member.fullName' },
            phone: { $first: '$member.phone' },
            visits: { $sum: 1 },
            lastVisit: { $max: '$checkIn' }
          }
        },
        {
          $group: {
            _id: '$_id.memberId',
            name: { $first: '$name' },
            phone: { $first: '$phone' },
            visits: { $sum: '$visits' },
            lastVisit: { $max: '$lastVisit' }
          }
        },
        { $project: { _id: 1, name: 1, phone: 1, visits: 1, lastVisit: 1 } }
      );
    } else {
      pipeline.push({
        $project: {
          _id: 1,
          attendanceDate: 1,
          checkIn: 1,
          checkOut: 1,
          status: 1,
          attendanceType: 1,
          durationMinutes: 1,
          member: { _id: '$member._id', name: '$member.fullName', phone: '$member.phone' }
        }
      });
    }
  } else if (['members', 'newMembers', 'activeMembers', 'inactiveMembers', 'unpaid', 'partial', 'fullyPaid'].includes(type)) {
    const match = { tenantId, businessId, deletedAt: null };
    if (type === 'newMembers') match.joiningDate = rangeMatch(range);
    if (type === 'activeMembers') match.status = 'Active';
    if (type === 'inactiveMembers') match.status = { $in: ['Inactive', 'On Hold'] };
    if (query.trainerId && mongooseObjectId(query.trainerId)) {
      match.assignedTrainerId = new mongoose.Types.ObjectId(query.trainerId);
    }
    pipeline = [
      { $match: match },
      {
        $lookup: {
          from: 'membermemberships',
          let: { memberId: '$_id' },
          pipeline: [{
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$memberId', '$$memberId'] },
                  { $eq: ['$tenantId', tenantId] },
                  { $eq: ['$businessId', businessId] },
                  { $ne: ['$status', 'Cancelled'] }
                ]
              }
            }
          }],
          as: 'memberships'
        }
      },
      {
        $lookup: {
          from: 'payments',
          let: { membershipIds: '$memberships._id' },
          pipeline: [{
            $match: {
              $expr: {
                $and: [
                  { $in: ['$membershipId', '$$membershipIds'] },
                  { $eq: ['$tenantId', tenantId] },
                  { $eq: ['$businessId', businessId] },
                  { $eq: ['$status', 'Success'] }
                ]
              }
            }
          }],
          as: 'successfulPayments'
        }
      },
      {
        $lookup: {
          from: 'membershipplans',
          let: { planIds: '$memberships.planId' },
          pipeline: [{
            $match: {
              $expr: {
                $and: [
                  { $in: ['$_id', '$$planIds'] },
                  { $eq: ['$tenantId', tenantId] },
                  { $eq: ['$businessId', businessId] }
                ]
              }
            }
          }],
          as: 'memberPlans'
        }
      },
      {
        $addFields: {
          totalFees: { $sum: '$memberships.planPrice' },
          totalPaid: { $sum: '$successfulPayments.amount' },
          membershipCount: { $size: '$memberships' },
          membershipPlans: {
            $map: { input: '$memberPlans', as: 'plan', in: '$$plan.planName' }
          },
          activeMemberships: {
            $filter: {
              input: '$memberships',
              as: 'membership',
              cond: {
                $and: [
                  { $lte: ['$$membership.startDate', new Date()] },
                  { $gte: ['$$membership.endDate', new Date()] }
                ]
              }
            }
          }
        }
      },
      { $addFields: { activeMembershipCount: { $size: '$activeMemberships' } } },
      {
        $addFields: {
          pendingAmount: { $max: [0, { $subtract: ['$totalFees', '$totalPaid'] }] },
          paymentStatus: {
            $switch: {
              branches: [
                { case: { $gte: ['$totalPaid', '$totalFees'] }, then: 'FULLY PAID' },
                { case: { $gt: ['$totalPaid', 0] }, then: 'PARTIALLY PAID' }
              ],
              default: 'UNPAID'
            }
          }
        }
      }
    ];
    if (['unpaid', 'partial', 'fullyPaid'].includes(type)) {
      const status = type === 'unpaid' ? 'UNPAID' : type === 'partial' ? 'PARTIALLY PAID' : 'FULLY PAID';
      pipeline.push({ $match: { paymentStatus: status } });
    }
    if (query.planId && mongooseObjectId(query.planId)) {
      pipeline.push({ $match: { 'memberships.planId': new mongoose.Types.ObjectId(query.planId) } });
    }
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      pipeline.push({
        $match: {
          $or: [
            { fullName: regex },
            { phone: regex },
            { email: regex },
            ...(mongooseObjectId(search) ? [{ _id: new mongoose.Types.ObjectId(search) }] : [])
          ]
        }
      });
    }
    pipeline.push({
      $project: {
        _id: 1,
        fullName: 1,
        phone: 1,
        email: 1,
        status: 1,
        joiningDate: 1,
        totalFees: 1,
        totalPaid: 1,
        pendingAmount: 1,
        paymentStatus: 1,
        assignedTrainerId: 1,
        activeMemberships: 1,
        membershipCount: 1,
        activeMembershipCount: 1,
        membershipPlans: 1
      }
    });
  } else if ([
    'memberships', 'expiring', 'expiredMemberships',
    'renewedMemberships', 'nonRenewedMembers'
  ].includes(type)) {
    const match = { tenantId, businessId, status: { $ne: 'Cancelled' } };
    if (type === 'renewedMemberships') match.startDate = rangeMatch(range);
    else if (type === 'nonRenewedMembers') {
      match.$and = [
        { endDate: rangeMatch(range) },
        { endDate: { $lt: new Date() } }
      ];
    } else if (type === 'expiredMemberships') {
      match.$and = [
        { endDate: rangeMatch(range) },
        { endDate: { $lt: new Date() } }
      ];
    } else match.endDate = rangeMatch(range);
    if (type === 'expiring') match.endDate = {
      $gte: new Date(),
      $lt: new Date(new Date().getTime() + 30 * 86400000)
    };
    pipeline = [
      { $match: match },
      {
        $lookup: {
          from: 'members',
          let: { memberId: '$memberId' },
          pipeline: [{
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$_id', '$$memberId'] },
                  { $eq: ['$tenantId', tenantId] },
                  { $eq: ['$businessId', businessId] },
                  { $eq: ['$deletedAt', null] }
                ]
              }
            }
          }],
          as: 'member'
        }
      },
      { $unwind: { path: '$member', preserveNullAndEmptyArrays: false } },
      {
        $lookup: {
          from: 'membershipplans',
          let: { planId: '$planId' },
          pipeline: [{
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$_id', '$$planId'] },
                  { $eq: ['$tenantId', tenantId] }
                ]
              }
            }
          }],
          as: 'plan'
        }
      },
      { $unwind: { path: '$plan', preserveNullAndEmptyArrays: true } }
    ];
    if (type === 'renewedMemberships' || type === 'nonRenewedMembers') {
      pipeline.push({
        $lookup: {
          from: 'membermemberships',
          let: {
            memberId: '$memberId',
            startDate: '$startDate',
            endDate: '$endDate'
          },
          pipeline: [{
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$memberId', '$$memberId'] },
                  { $eq: ['$tenantId', tenantId] },
                  { $eq: ['$businessId', businessId] },
                  { $ne: ['$status', 'Cancelled'] },
                  type === 'renewedMemberships'
                    ? {
                      $and: [
                        { $lt: ['$startDate', '$$startDate'] },
                        { $lt: ['$endDate', '$$startDate'] }
                      ]
                    }
                    : { $gt: ['$startDate', '$$endDate'] }
                ]
              }
            }
          }],
          as: 'relatedMemberships'
        }
      });
      pipeline.push(type === 'renewedMemberships'
        ? { $match: { 'relatedMemberships.0': { $exists: true } } }
        : { $match: { 'relatedMemberships.0': { $exists: false } } });
    }
    if (query.planId && mongooseObjectId(query.planId)) {
      pipeline.push({ $match: { planId: new mongoose.Types.ObjectId(query.planId) } });
    }
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      pipeline.push({
        $match: {
          $or: [
            { 'member.fullName': regex },
            { 'member.phone': regex },
            ...(mongooseObjectId(search) ? [{ 'member._id': new mongoose.Types.ObjectId(search) }] : [])
          ]
        }
      });
    }
    pipeline.push({
      $project: {
        _id: 1,
        startDate: 1,
        endDate: 1,
        status: 1,
        planPrice: 1,
        paymentStatus: 1,
        relatedMemberships: 1,
        member: { _id: '$member._id', name: '$member.fullName', phone: '$member.phone', email: '$member.email' },
        plan: { _id: '$plan._id', name: '$plan.planName' }
      }
    });
  } else if (['trainers', 'staff'].includes(type)) {
    pipeline = [{ $match: { tenantId, role: type === 'trainers' ? 'Trainer' : 'Staff' } }];
    if (query.teamStatus && ['Active', 'Inactive'].includes(query.teamStatus)) {
      pipeline[0].$match.status = query.teamStatus;
    }
    if (range) pipeline[0].$match.joiningDate = rangeMatch(range);
    if (type === 'trainers' && query.trainerId && mongooseObjectId(query.trainerId)) {
      pipeline[0].$match._id = new mongoose.Types.ObjectId(query.trainerId);
    }
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      pipeline.push({ $match: { $or: [{ name: regex }, { phone: regex }, { email: regex }, { designation: regex }] } });
    }
    if (type === 'trainers') {
      pipeline.push({
        $lookup: {
          from: 'members',
          let: { trainerId: '$_id' },
          pipeline: [{
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$assignedTrainerId', '$$trainerId'] },
                  { $eq: ['$tenantId', tenantId] },
                  { $eq: ['$businessId', businessId] },
                  { $eq: ['$deletedAt', null] }
                ]
              }
            }
          }],
          as: 'assignedMembers'
        }
      }, {
        $addFields: { assignedMemberCount: { $size: '$assignedMembers' } }
      });
    }
  } else {
    return { records: [], total: 0, page, limit, totalPages: 0 };
  }

  const Model = ['trainers', 'staff'].includes(type)
    ? TrainerStaff
    : ['attendance', 'attendanceMembers'].includes(type)
      ? Attendance
      : ['revenue', 'refunds', 'failed', 'pending', 'gst'].includes(type)
        ? Payment
        : ['memberships', 'expiring', 'expiredMemberships', 'renewedMemberships', 'nonRenewedMembers'].includes(type)
          ? MemberMembership
          : Member;
  const sortExpression = { [sortBy]: sortDirection, _id: 1 };
  const [countResult, records, summaryResult] = await Promise.all([
    Model.aggregate([...pipeline, { $count: 'total' }]),
    Model.aggregate([
      ...pipeline,
      { $sort: sortExpression },
      { $skip: skip },
      { $limit: limit }
    ]),
    Model.aggregate([
      ...pipeline,
      {
        $group: {
          _id: null,
          recordCount: { $sum: 1 },
          amount: { $sum: { $ifNull: ['$amount', { $ifNull: ['$planPrice', { $ifNull: ['$totalAmount', 0] }] }] } },
          totalFees: { $sum: { $ifNull: ['$totalFees', 0] } },
          totalPaid: { $sum: { $ifNull: ['$totalPaid', 0] } },
          pendingAmount: { $sum: { $ifNull: ['$pendingAmount', 0] } },
          taxableAmount: { $sum: { $ifNull: ['$taxableAmount', 0] } },
          cgst: { $sum: { $ifNull: ['$cgst', 0] } },
          sgst: { $sum: { $ifNull: ['$sgst', 0] } },
          igst: { $sum: { $ifNull: ['$igst', 0] } },
          totalTax: { $sum: { $ifNull: ['$totalTax', 0] } },
          totalAmount: { $sum: { $ifNull: ['$totalAmount', 0] } },
          visits: { $sum: { $ifNull: ['$visits', 0] } }
        }
      },
      { $project: { _id: 0 } }
    ])
  ]);
  const count = countResult[0]?.total || 0;
  return {
    records,
    total: count,
    page,
    limit,
    totalPages: Math.ceil(count / limit),
    summary: summaryResult[0] || {
      recordCount: 0, amount: 0, totalFees: 0, totalPaid: 0, pendingAmount: 0,
      taxableAmount: 0, cgst: 0, sgst: 0, igst: 0, visits: 0
    }
  };
};

const mongooseObjectId = value => /^[a-f\d]{24}$/i.test(String(value || ''));

exports.getOperationalReport = async (req, res) => {
  const range = resolveReportPeriod(req.query, new Date());
  if (!range) {
    return res.status(400).json({
      success: false,
      message: 'Choose a valid date range no longer than 366 days'
    });
  }
  const businessId = req.owner.businessId;
  if (String(req.tenantId) !== String(businessId)) {
    return res.status(403).json({ success: false, message: 'Business access is not available' });
  }

  try {
    if (req.query.detailsOnly === 'true') {
      const reportTypes = new Set([
        'revenue', 'refunds', 'failed', 'pending', 'gst', 'members', 'newMembers',
        'activeMembers', 'inactiveMembers', 'unpaid', 'partial', 'fullyPaid',
        'memberships', 'expiring', 'expiredMemberships', 'renewedMemberships',
        'nonRenewedMembers', 'attendance',
        'attendanceMembers', 'trainers', 'staff'
      ]);
      if (!reportTypes.has(String(req.query.type || ''))) {
        return res.status(400).json({ success: false, message: 'Select a supported report type' });
      }
      const details = await getDetails({
        type: String(req.query.type || ''),
        tenantId: req.tenantId,
        businessId,
        range,
        query: req.query
      });
      return res.json({
        success: true,
        period: { from: range.fromDate, to: range.toDate, timezone: range.timeZone },
        detail: details
      });
    }

    const business = await Business.findOne({
      _id: businessId,
      tenantId: req.tenantId
    }).select('businessName logoUrl').lean();
    const overview = await getOverview({
      tenantId: req.tenantId,
      businessId,
      range,
      now: new Date()
    });
    const details = req.query.type
      ? await getDetails({
        type: String(req.query.type),
        tenantId: req.tenantId,
        businessId,
        range,
        query: req.query
      })
      : { records: [], total: 0, page: 1, limit: 25, totalPages: 0 };

    return res.json({
      success: true,
      business: business || { businessName: 'Business' },
      ...overview,
      detail: details,
      capabilities: {
        trainerAttendance: false,
        staffAttendance: false,
        salaryTransactions: false,
        cancellationHistory: false,
        gstReports: true,
        storedTaxOnly: true
      }
    });
  } catch (error) {
    console.error('Operational report error:', error);
    return res.status(500).json({
      success: false,
      message: 'Unable to generate report'
    });
  }
};
