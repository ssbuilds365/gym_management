const mongoose = require('mongoose');

const Business = require('../models/Business');
const MembershipPlan = require('../models/MembershipPlan');
const MemberMembership = require('../models/MemberMembership');
const {
  createMembershipExpiryPipeline,
  getMembershipExpiryWindow,
  getLocalDateKey,
  isValidTimeZone,
  DEFAULT_TIME_ZONE,
  getCalendarDayDifference
} = require('../utils/membershipExpiry');

const getMembershipExpiry = async (req, res) => {
  try {
    const business = await Business.findOne({ _id: req.tenantId })
      .select('timeZone')
      .lean();
    if (!business) {
      return res.status(404).json({
        success: false,
        message: 'Business not found'
      });
    }

    const timeZone = isValidTimeZone(business.timeZone)
      ? business.timeZone
      : DEFAULT_TIME_ZONE;
    const now = new Date();
    const window = getMembershipExpiryWindow(now, timeZone);
    const category = String(req.query.status || 'upcoming');
    const validCategories = [
      'all',
      'upcoming',
      'expiringSoon',
      'today',
      'expired'
    ];
    if (!validCategories.includes(category)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid membership expiry filter'
      });
    }

    const search = String(req.query.search || '').trim().slice(0, 100);
    const requestedPage = Number.parseInt(req.query.page, 10);
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const page = Number.isFinite(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 5;
    const sort = String(req.query.sort || 'asc');
    if (!['asc', 'desc'].includes(sort)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid membership expiry sort order'
      });
    }

    let planId;
    if (req.query.planId) {
      if (!mongoose.Types.ObjectId.isValid(req.query.planId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid membership plan'
        });
      }
      planId = new mongoose.Types.ObjectId(req.query.planId);
    }

    const [result, plans] = await Promise.all([
      MemberMembership.aggregate(createMembershipExpiryPipeline({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        window,
        category,
        search,
        planId,
        page,
        limit,
        sort
      })).allowDiskUse(true),
      MembershipPlan.find({
        tenantId: req.tenantId,
        businessId: req.owner.businessId
      })
        .select('planName')
        .sort({ planName: 1 })
        .lean()
    ]);

    const facet = result[0] || {};
    const counts = facet.counts?.[0] || {};
    const members = facet.records || [];
    const total = facet.filteredCount?.[0]?.total || 0;
    const expiringCounts = {
      expiringNext7DaysCount: counts.expiringNext7DaysCount || 0,
      expiringTodayCount: counts.expiringTodayCount || 0,
      expiredCount: counts.expiredCount || 0
    };
    const upcomingMembers = members.map(member => ({
      ...member,
      endDateLocal: getLocalDateKey(member.endDate, timeZone),
      remainingDays: getCalendarDayDifference(
        window.todayDate,
        getLocalDateKey(member.endDate, timeZone)
      )
    }));

    return res.status(200).json({
      success: true,
      timeZone,
      todayDate: window.todayDate,
      ...expiringCounts,
      upcomingMembers,
      members: upcomingMembers,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      },
      plans: plans.map(plan => ({
        _id: plan._id,
        planName: plan.planName
      }))
    });
  } catch (error) {
    console.error('Membership expiry loading error:', error);
    return res.status(500).json({
      success: false,
      message: 'Unable to load membership expiry information'
    });
  }
};

module.exports = { getMembershipExpiry };
