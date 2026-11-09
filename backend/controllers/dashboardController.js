const Member = require('../models/Member');
const Attendance = require('../models/Attendance');
const MemberMembership = require('../models/MemberMembership');
const Payment = require('../models/Payment');
const Business = require('../models/Business');
const { getDashboardPeriods, getLocalDateParts } = require('../utils/dashboardPeriods');
const {
  isValidTimeZone,
  DEFAULT_TIME_ZONE
} = require('../utils/membershipExpiry');

exports.getDashboardStats = async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const business = await Business.findOne({ _id: tenantId })
      .select('timeZone')
      .lean();
    if (!business) {
      return res.status(404).json({
        success: false,
        message: 'Business not found'
      });
    }
    const dashboardTimeZone = isValidTimeZone(business.timeZone)
      ? business.timeZone
      : DEFAULT_TIME_ZONE;
    const now = new Date();
    const periods = getDashboardPeriods(now, dashboardTimeZone);
    const [
      totalMembers,
      activeMembers,
      todayAttendance,
      paymentSummary,
      recentMembers,
      paymentCollections
    ] =
      await Promise.all([
        Member.countDocuments({ tenantId, deletedAt: null }),
        Member.countDocuments({ tenantId, deletedAt: null, status: 'Active' }),
        Attendance.countDocuments({
          tenantId,
          attendanceDate: {
            $gte: periods.todayStart,
            $lt: periods.tomorrowStart
          }
        }),
        Promise.all([
          MemberMembership.aggregate([
            { $match: { tenantId } },
            { $group: { _id: null, totalCollected: { $sum: '$paidAmount' } } }
          ]),
          MemberMembership.aggregate([
            {
              $match: {
                tenantId,
                status: { $ne: 'Cancelled' }
              }
            },
            {
              $lookup: {
                from: 'members',
                let: { memberId: '$memberId' },
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $and: [
                          { $eq: ['$_id', '$$memberId'] },
                          { $eq: ['$tenantId', tenantId] },
                          { $eq: ['$deletedAt', null] }
                        ]
                      }
                    }
                  }
                ],
                as: 'member'
              }
            },
            { $match: { 'member.0': { $exists: true } } },
            {
              $group: {
                _id: null,
                totalPending: {
                  $sum: {
                    $max: [
                      0,
                      {
                        $round: [
                          {
                            $subtract: [
                              '$planPrice',
                              { $ifNull: ['$paidAmount', 0] }
                            ]
                          },
                          2
                        ]
                      }
                    ]
                  }
                }
              }
            }
          ])
        ]),
        Member.find({ tenantId, deletedAt: null })
          .sort({ createdAt: -1 })
          .limit(5)
          .select('fullName phone status joiningDate createdAt')
          .lean(),
        Payment.aggregate([
          {
            $match: {
              tenantId,
              businessId: req.owner.businessId,
              status: 'Success',
              paymentDate: {
                $gte: periods.firstMonthStart,
                $lt: now
              }
            }
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: '%Y-%m',
                  date: '$paymentDate',
                  timezone: dashboardTimeZone
                }
              },
              revenue: { $sum: '$amount' },
              todayCollection: {
                $sum: {
                  $cond: [
                    { $gte: ['$paymentDate', periods.todayStart] },
                    '$amount',
                    0
                  ]
                }
              },
              weekCollection: {
                $sum: {
                  $cond: [
                    { $gte: ['$paymentDate', periods.weekStart] },
                    '$amount',
                    0
                  ]
                }
              },
              monthCollection: {
                $sum: {
                  $cond: [
                    { $gte: ['$paymentDate', periods.monthStart] },
                    '$amount',
                    0
                  ]
                }
              }
            }
          },
          { $sort: { _id: 1 } }
        ])
      ]);

    const [collectionResult, outstandingResult] = paymentSummary;
    const collectionByMonth = new Map(
      paymentCollections.map((item) => [item._id, item])
    );
    const monthlyRevenue = periods.months.map(({ key, start }) => {
      const month = collectionByMonth.get(key);
      return {
        key,
        month: new Date(`${key}-01T00:00:00.000Z`).toLocaleDateString('en-IN', {
          timeZone: 'UTC',
          month: 'short',
          year: 'numeric'
        }),
        revenue: month?.revenue || 0
      };

    });
    const currentPeriodCollection =
      paymentCollections.find((item) => item._id === monthlyRevenue.at(-1)?.key);

    res.status(200).json({
      success: true,
      timeZone: dashboardTimeZone,
      stats: {
        totalMembers,
        activeMembers,
        todayAttendance,
        totalCollected: collectionResult[0]?.totalCollected || 0,
        totalPending: outstandingResult[0]?.totalPending || 0
      },
      collections: {
        today: currentPeriodCollection?.todayCollection || 0,
        week: currentPeriodCollection?.weekCollection || 0,
        month: currentPeriodCollection?.monthCollection || 0,
        monthlyRevenue
      },
      recentMembers
    });

  } catch (error) {
    console.error('Dashboard Stats Error:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard statistics'
    });
  }
};

exports.getTodaysBirthdays = async (req, res) => {
  try {
    const business = await Business.findOne({ _id: req.tenantId })
      .select('timeZone')
      .lean();
    if (!business) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }

    const timeZone = isValidTimeZone(business.timeZone)
      ? business.timeZone
      : DEFAULT_TIME_ZONE;
    const today = getLocalDateParts(new Date(), timeZone);
    const members = await Member.aggregate([
      {
        $match: {
          tenantId: req.tenantId,
          businessId: req.owner.businessId,
          deletedAt: null,
          dateOfBirth: { $type: 'date' }
        }
      },
      {
        $addFields: {
          birthdayParts: {
            $dateToParts: { date: '$dateOfBirth', timezone: 'UTC' }
          }
        }
      },
      {
        $match: {
          'birthdayParts.month': today.month,
          'birthdayParts.day': today.day
        }
      },
      { $sort: { fullName: 1, _id: 1 } },
      {
        $project: {
          fullName: 1,
          phone: 1,
          dateOfBirth: 1
        }
      }
    ]);

    return res.json({
      success: true,
      date: `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`,
      timeZone,
      count: members.length,
      members: members.map(member => ({
        _id: member._id,
        fullName: member.fullName,
        phone: member.phone,
        age: today.year - new Date(member.dateOfBirth).getUTCFullYear()
      }))
    });
  } catch (error) {
    console.error('Dashboard birthdays error:', error);
    return res.status(500).json({
      success: false,
      message: 'Unable to load today’s birthdays'
    });
  }
};