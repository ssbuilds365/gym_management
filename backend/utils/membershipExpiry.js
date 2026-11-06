const {
  localDateTimeToUtc,
  getLocalDateParts
} = require('./dashboardPeriods');

const DAY_MS = 86400000;

const isValidTimeZone = (timeZone) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const DEFAULT_TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Asia/Kolkata';
if (!isValidTimeZone(DEFAULT_TIME_ZONE)) {
  throw new Error(`Invalid DASHBOARD_TIME_ZONE: ${DEFAULT_TIME_ZONE}`);
}

const getDatePartsAfterDays = (parts, days) => {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
};

const getMembershipExpiryWindow = (now, timeZone) => {
  const localNow = getLocalDateParts(now, timeZone);
  const today = {
    year: localNow.year,
    month: localNow.month,
    day: localNow.day
  };
  const startOfDay = parts => localDateTimeToUtc(parts, timeZone);

  return {
    todayDate: `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`,
    todayStart: startOfDay(today),
    tomorrowStart: startOfDay(getDatePartsAfterDays(today, 1)),
    next8DayStart: startOfDay(getDatePartsAfterDays(today, 8))
  };
};

const parseMembershipStartDate = (value, timeZone) => {
  let parts;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() + 1 !== month ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    parts = { year, month, day };
  } else {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    const local = getLocalDateParts(date, timeZone);
    parts = { year: local.year, month: local.month, day: local.day };
  }
  return localDateTimeToUtc(parts, timeZone);
};

const addMembershipDuration = (startDate, duration, durationType, timeZone) => {
  const localStart = getLocalDateParts(startDate, timeZone);
  let endDate;
  if (durationType === 'Days') {
    endDate = new Date(Date.UTC(
      localStart.year,
      localStart.month - 1,
      localStart.day + duration
    ));
  } else if (durationType === 'Months') {
    endDate = new Date(Date.UTC(
      localStart.year,
      localStart.month - 1 + duration,
      localStart.day
    ));
  } else if (durationType === 'Years') {
    endDate = new Date(Date.UTC(
      localStart.year + duration,
      localStart.month - 1,
      localStart.day
    ));
  } else {
    throw new Error('Unsupported membership duration type');
  }

  return localDateTimeToUtc({
    year: endDate.getUTCFullYear(),
    month: endDate.getUTCMonth() + 1,
    day: endDate.getUTCDate()
  }, timeZone);
};

const getLocalDateKey = (date, timeZone) => {
  const parts = getLocalDateParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
};

const getCalendarDayDifference = (fromDate, toDate) => {
  const [fromYear, fromMonth, fromDay] = fromDate.split('-').map(Number);
  const [toYear, toMonth, toDay] = toDate.split('-').map(Number);
  return (
    Date.UTC(toYear, toMonth - 1, toDay) -
    Date.UTC(fromYear, fromMonth - 1, fromDay)
  ) / DAY_MS;
};

const classifyMembershipExpiry = (endDate, now, timeZone) => {
  const window = getMembershipExpiryWindow(now, timeZone);
  const endDateKey = getLocalDateKey(new Date(endDate), timeZone);
  const remainingDays = getCalendarDayDifference(window.todayDate, endDateKey);

  if (remainingDays < 0) {
    return { status: 'expired', remainingDays, todayDate: window.todayDate };
  }
  if (remainingDays === 0) {
    return { status: 'today', remainingDays, todayDate: window.todayDate };
  }
  if (remainingDays <= 7) {
    return { status: 'expiringSoon', remainingDays, todayDate: window.todayDate };
  }
  return { status: 'active', remainingDays, todayDate: window.todayDate };
};

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const createMembershipExpiryPipeline = ({
  tenantId,
  businessId,
  window,
  category = 'upcoming',
  search = '',
  planId,
  page = 1,
  limit = 5,
  sort = 'asc'
}) => {
  const categoryFilter = category === 'all'
    ? ['expiringSoon', 'today', 'expired']
    : category === 'upcoming'
      ? ['expiringSoon', 'today']
      : [category];
  const recordMatch = {
    expiryCategory: { $in: categoryFilter }
  };

  if (search) {
    const expression = new RegExp(escapeRegex(search), 'i');
    recordMatch.$or = [
      { 'member.fullName': expression },
      { 'member.phone': expression }
    ];
  }
  if (planId) recordMatch.planId = planId;

  return [
    {
      $match: {
        tenantId,
        businessId,
        status: { $in: ['Active', 'Expired'] }
      }
    },
    {
      $project: {
        _id: 1,
        memberId: 1,
        tenantId: 1,
        businessId: 1,
        planId: 1,
        startDate: 1,
        endDate: 1,
        createdAt: 1,
        status: 1
      }
    },
    {
      $sort: {
        memberId: 1,
        startDate: -1,
        createdAt: -1
      }
    },
    {
      $group: {
        _id: '$memberId',
        membership: { $first: '$$ROOT' }
      }
    },
    { $replaceRoot: { newRoot: '$membership' } },
    {
      $lookup: {
        from: 'members',
        let: { membershipMemberId: '$memberId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$_id', '$$membershipMemberId'] },
                  { $eq: ['$tenantId', tenantId] },
                  { $eq: ['$businessId', businessId] },
                  { $eq: ['$deletedAt', null] }
                ]
              }
            }
          },
          { $project: { fullName: 1, phone: 1 } }
        ],
        as: 'member'
      }
    },
    { $unwind: '$member' },
    {
      $addFields: {
        expiryCategory: {
          $switch: {
            branches: [
              {
                case: { $lt: ['$endDate', window.todayStart] },
                then: 'expired'
              },
              {
                case: {
                  $and: [
                    { $gte: ['$endDate', window.todayStart] },
                    { $lt: ['$endDate', window.tomorrowStart] },
                    { $lt: ['$startDate', window.tomorrowStart] }
                  ]
                },
                then: 'today'
              },
              {
                case: {
                  $and: [
                    { $gte: ['$endDate', window.tomorrowStart] },
                    { $lt: ['$endDate', window.next8DayStart] },
                    { $lt: ['$startDate', window.tomorrowStart] }
                  ]
                },
                then: 'expiringSoon'
              }
            ],
            default: 'active'
          }
        }
      }
    },
    {
      $facet: {
        counts: [
          {
            $group: {
              _id: null,
              expiringNext7DaysCount: {
                $sum: { $cond: [{ $eq: ['$expiryCategory', 'expiringSoon'] }, 1, 0] }
              },
              expiringTodayCount: {
                $sum: { $cond: [{ $eq: ['$expiryCategory', 'today'] }, 1, 0] }
              },
              expiredCount: {
                $sum: { $cond: [{ $eq: ['$expiryCategory', 'expired'] }, 1, 0] }
              }
            }
          }
        ],
        records: [
          { $match: recordMatch },
          { $sort: { endDate: sort === 'desc' ? -1 : 1, 'member.fullName': 1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $lookup: {
              from: 'membershipplans',
              let: { membershipPlanId: '$planId' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$_id', '$$membershipPlanId'] },
                        { $eq: ['$tenantId', tenantId] },
                        { $eq: ['$businessId', businessId] }
                      ]
                    }
                  }
                },
                { $project: { planName: 1 } }
              ],
              as: 'plan'
            }
          },
          {
            $unwind: {
              path: '$plan',
              preserveNullAndEmptyArrays: true
            }
          },
          {
            $project: {
              _id: 0,
              memberId: '$member._id',
              membershipId: '$_id',
              fullName: '$member.fullName',
              phone: '$member.phone',
              planName: { $ifNull: ['$plan.planName', 'Membership Plan'] },
              planId: 1,
              startDate: 1,
              endDate: 1,
              endDateLocal: 1,
              status: '$expiryCategory'
            }
          }
        ],
        filteredCount: [
          { $match: recordMatch },
          { $count: 'total' }
        ]
      }
    }
  ];
};

module.exports = {
  classifyMembershipExpiry,
  createMembershipExpiryPipeline,
  getMembershipExpiryWindow,
  getLocalDateKey,
  isValidTimeZone,
  parseMembershipStartDate,
  addMembershipDuration,
  DEFAULT_TIME_ZONE,
  getCalendarDayDifference
};
