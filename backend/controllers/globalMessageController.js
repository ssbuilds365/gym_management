const mongoose = require('mongoose');
const Business = require('../models/Business');
const GlobalMessageCampaign = require('../models/GlobalMessageCampaign');
const Member = require('../models/Member');
const MemberMembership = require('../models/MemberMembership');
const MembershipPlan = require('../models/MembershipPlan');
const Payment = require('../models/Payment');
const { campaignSummary } = require('../utils/globalMessage');
const {
  DEFAULT_TIME_ZONE,
  getMembershipExpiryWindow,
  isValidTimeZone
} = require('../utils/membershipExpiry');

const validFilters = new Set([
  'all', 'active', 'expired', 'expiringSoon', 'pendingFees', 'custom'
]);
const responseError = (res, status, message) => res.status(status).json({
  success: false,
  message
});

const redactLogValue = (value, search) => {
  let safeValue = String(value || '');
  if (search) safeValue = safeValue.split(search).join('[redacted-search]');
  return safeValue
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'`]+/gi, '[redacted-mongodb-uri]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-token]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/(^|[^\d])((?:\+?91[\s-]?)?[6-9](?:[\s-]?\d){9})(?!\d)/gm, '$1[redacted-mobile]');
};

const logControllerError = (operation, error, context = {}) => {
  const search = typeof context.search === 'string' ? context.search : '';
  const safeError = error instanceof Error ? error : new Error(String(error));
  console.error(`[global-message] ${operation} failed`, {
    name: safeError.name,
    message: redactLogValue(safeError.message, search),
    stack: redactLogValue(safeError.stack || '', search),
    code: safeError.code || undefined,
    context: {
      filter: context.filter,
      page: context.page,
      limit: context.limit,
      searchProvided: Boolean(search),
      tenantIdValid: mongoose.isValidObjectId(context.tenantId),
      businessIdValid: mongoose.isValidObjectId(context.businessId),
      memberCollection: Member.collection.name,
      membershipCollection: MemberMembership.collection.name
    }
  });
};

const parsePage = (value, fallback, max) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

const getTenantExpiryWindow = async tenantId => {
  const business = await Business.findById(tenantId).select('timeZone').lean();
  const timeZone = business?.timeZone && isValidTimeZone(business.timeZone)
    ? business.timeZone
    : DEFAULT_TIME_ZONE;
  return getMembershipExpiryWindow(new Date(), timeZone);
};

const memberPipeline = ({ tenantId, businessId, search, filter, memberIds, window }) => {
  const baseMatch = {
    tenantId,
    businessId,
    deletedAt: null
  };
  if (memberIds) baseMatch._id = { $in: memberIds };

  const pipeline = [
    { $match: baseMatch },
    {
      $set: {
        phoneDigits: {
          $regexReplace: { input: { $ifNull: ['$phone', ''] }, regex: '[^0-9]', replacement: '' }
        }
      }
    },
    {
      $set: {
        normalizedMobile: {
          $switch: {
            branches: [
              {
                case: { $regexMatch: { input: '$phoneDigits', regex: '^[6-9][0-9]{9}$' } },
                then: { $concat: ['91', '$phoneDigits'] }
              },
              {
                case: { $regexMatch: { input: '$phoneDigits', regex: '^0[6-9][0-9]{9}$' } },
                then: { $concat: ['91', { $substrCP: ['$phoneDigits', 1, 10] }] }
              },
              {
                case: { $regexMatch: { input: '$phoneDigits', regex: '^91[6-9][0-9]{9}$' } },
                then: '$phoneDigits'
              }
            ],
            default: ''
          }
        }
      }
    },
    {
      $lookup: {
        from: MemberMembership.collection.name,
        let: { memberId: '$_id' },
        pipeline: [
          {
            $match: {
              status: { $in: ['Active', 'Expired'] },
              $expr: {
                $and: [
                  { $eq: ['$memberId', '$$memberId'] },
                  { $eq: ['$tenantId', tenantId] },
                  { $eq: ['$businessId', businessId] }
                ]
              }
            }
          },
          { $sort: { startDate: -1, createdAt: -1 } },
          { $limit: 1 },
          { $project: { _id: 1, planId: 1, startDate: 1, endDate: 1, planPrice: 1, status: 1 } }
        ],
        as: 'membershipResults'
      }
    },
    { $set: { membership: { $arrayElemAt: ['$membershipResults', 0] } } },
    {
      $lookup: {
        from: MembershipPlan.collection.name,
        let: { planId: '$membership.planId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$_id', '$$planId'] },
                  { $eq: ['$tenantId', tenantId] },
                  { $eq: ['$businessId', businessId] }
                ]
              }
            }
          },
          { $project: { planName: 1 } }
        ],
        as: 'planResults'
      }
    },
    { $set: { plan: { $arrayElemAt: ['$planResults', 0] } } },
    {
      $lookup: {
        from: Payment.collection.name,
        let: { membershipId: '$membership._id' },
        pipeline: [
          {
            $match: {
              tenantId,
              businessId,
              status: 'Success',
              $expr: { $eq: ['$membershipId', '$$membershipId'] }
            }
          },
          { $group: { _id: null, paidAmount: { $sum: '$amount' } } }
        ],
        as: 'paymentTotals'
      }
    },
    {
      $set: {
        pendingAmount: {
          $max: [
            0,
            {
              $subtract: [
                { $ifNull: ['$membership.planPrice', 0] },
                { $ifNull: [{ $arrayElemAt: ['$paymentTotals.paidAmount', 0] }, 0] }
              ]
            }
          ]
        }
      }
    },
    {
      $set: {
        expiryCategory: {
          $switch: {
            branches: [
              {
                case: { $lt: ['$membership.endDate', window.todayStart] },
                then: 'expired'
              },
              {
                case: {
                  $and: [
                    { $gte: ['$membership.endDate', window.todayStart] },
                    { $lt: ['$membership.endDate', window.tomorrowStart] },
                    { $lt: ['$membership.startDate', window.tomorrowStart] }
                  ]
                },
                then: 'today'
              },
              {
                case: {
                  $and: [
                    { $gte: ['$membership.endDate', window.tomorrowStart] },
                    { $lt: ['$membership.endDate', window.next8DayStart] },
                    { $lt: ['$membership.startDate', window.tomorrowStart] }
                  ]
                },
                then: 'expiringSoon'
              }
            ],
            default: 'active'
          }
        }
      }
    }
  ];

  if (search) {
    const safeSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const digitsSearch = search.replace(/\D/g, '');
    pipeline.push({
      $match: {
        $or: [
          { fullName: { $regex: safeSearch, $options: 'i' } },
          { phone: { $regex: safeSearch, $options: 'i' } },
          ...(digitsSearch ? [{ normalizedMobile: { $regex: digitsSearch } }] : [])
        ]
      }
    });
  }

  const filterMatch = {
    ...(filter === 'active' ? {
      status: 'Active',
      'membership._id': { $exists: true },
      expiryCategory: { $ne: 'expired' }
    } : {}),
    ...(filter === 'expired' ? {
      'membership._id': { $exists: true },
      expiryCategory: 'expired'
    } : {}),
    ...(filter === 'expiringSoon' ? {
      status: 'Active',
      'membership._id': { $exists: true },
      expiryCategory: { $in: ['today', 'expiringSoon'] }
    } : {}),
    ...(filter === 'pendingFees' ? { pendingAmount: { $gt: 0 } } : {})
  };

  return { pipeline, filterMatch };
};

const getEligible = async (req, res) => {
  try {
    const filter = String(req.query.filter || 'all');
    const search = String(req.query.search || '').trim().slice(0, 100);
    if (!validFilters.has(filter)) return responseError(res, 400, 'Invalid member filter.');

    const page = parsePage(req.query.page, 1, Number.MAX_SAFE_INTEGER);
    const limit = parsePage(req.query.limit, 50, 100);
    const window = await getTenantExpiryWindow(req.tenantId);
    const { pipeline, filterMatch } = memberPipeline({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      search,
      filter,
      window
    });
    const aggregate = await Member.aggregate([
      ...pipeline,
      {
        $facet: {
          members: [
            { $match: { normalizedMobile: { $ne: '' }, ...filterMatch } },
            { $sort: { fullName: 1, _id: 1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                _id: 1,
                fullName: 1,
                phone: 1,
                normalizedMobile: 1,
                membership: 1,
                planName: { $ifNull: ['$plan.planName', ''] },
                pendingAmount: 1
              }
            }
          ],
          total: [
            { $match: { normalizedMobile: { $ne: '' }, ...filterMatch } },
            { $count: 'value' }
          ],
          invalid: [
            { $match: { normalizedMobile: '', ...filterMatch } },
            { $count: 'value' }
          ]
        }
      }
    ]);
    const result = aggregate[0] || {};
    return res.json({
      success: true,
      members: result.members || [],
      pagination: {
        page,
        limit,
        total: result.total?.[0]?.value || 0,
        totalPages: Math.ceil((result.total?.[0]?.value || 0) / limit)
      },
      invalidNumberCount: result.invalid?.[0]?.value || 0
    });
  } catch (error) {
    logControllerError('member lookup', error, {
      filter: typeof req.query.filter === 'string' ? req.query.filter : undefined,
      page: typeof req.query.page === 'string' ? req.query.page : undefined,
      limit: typeof req.query.limit === 'string' ? req.query.limit : undefined,
      search: typeof req.query.search === 'string' ? req.query.search : '',
      tenantId: req.tenantId,
      businessId: req.owner?.businessId
    });
    return responseError(res, 500, 'Unable to load eligible members.');
  }
};

const getSummary = async (req, res) => {
  try {
    const [totalMembers, latestCampaign] = await Promise.all([
      Member.countDocuments({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        deletedAt: null
      }),
      GlobalMessageCampaign.findOne({
        tenantId: req.tenantId,
        businessId: req.owner.businessId
      }).sort({ updatedAt: -1 }).select('_id').lean()
    ]);
    let activeCampaign = null;
    if (latestCampaign) {
      activeCampaign = await GlobalMessageCampaign.findOne({
        _id: latestCampaign._id,
        tenantId: req.tenantId,
        businessId: req.owner.businessId
      }).select('_id status').lean();
    }
    return res.json({
      success: true,
      totalMembers,
      activeCampaign
    });
  } catch (error) {
    logControllerError('summary lookup', error);
    return responseError(res, 500, 'Unable to load campaign summary.');
  }
};

const createCampaign = async (req, res) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    const memberIds = req.body.memberIds;
    if (!message || message.length > 4000) {
      return responseError(res, 400, 'Message is required and must be 4000 characters or fewer.');
    }
    if (name.length > 120) return responseError(res, 400, 'Campaign name must be 120 characters or fewer.');
    if (!Array.isArray(memberIds) || memberIds.length === 0 || memberIds.length > 3000) {
      return responseError(res, 400, 'Select between 1 and 3000 members.');
    }
    if (memberIds.some(id => !mongoose.isValidObjectId(id))) {
      return responseError(res, 400, 'The selected member list contains an invalid member.');
    }
    const uniqueIds = [...new Set(memberIds.map(String))];
    if (uniqueIds.length !== memberIds.length) {
      return responseError(res, 400, 'Duplicate recipients are not allowed.');
    }
    const window = await getTenantExpiryWindow(req.tenantId);
    const { pipeline } = memberPipeline({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      search: '',
      filter: 'all',
      memberIds: uniqueIds.map(id => new mongoose.Types.ObjectId(id)),
      window
    });
    const members = await Member.aggregate([
      ...pipeline,
      { $match: { normalizedMobile: { $ne: '' } } },
      {
        $project: {
          _id: 1,
          fullName: 1,
          normalizedMobile: 1,
          'membership.endDate': 1,
          pendingAmount: 1,
          planName: { $ifNull: ['$plan.planName', ''] }
        }
      }
    ]);
    if (members.length !== uniqueIds.length) {
      return responseError(res, 400, 'Some selected members are no longer available or do not have a valid mobile number. Refresh the list and try again.');
    }
    const recipientMobiles = new Set();
    for (const member of members) {
      if (recipientMobiles.has(member.normalizedMobile)) {
        return responseError(res, 400, 'Multiple selected members share the same normalized mobile number. Remove duplicate recipients and try again.');
      }
      recipientMobiles.add(member.normalizedMobile);
    }

    const business = await Business.findById(req.tenantId).select('businessName').lean();
    const memberById = new Map(members.map(member => [String(member._id), member]));
    const recipients = uniqueIds.map(id => memberById.get(id)).map(member => ({
      memberId: member._id,
      memberName: member.fullName,
      mobile: member.normalizedMobile,
      expiryDate: member.membership?.endDate || null,
      pendingAmount: member.pendingAmount || 0,
      planName: member.planName || '',
      status: 'PENDING'
    }));
    const campaign = await GlobalMessageCampaign.create({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      createdBy: req.owner._id,
      name,
      message,
      status: 'DRAFT',
      currentRecipientId: recipients[0].memberId,
      recipients
    });
    return res.status(201).json({
      success: true,
      campaign: {
        _id: campaign._id,
        name: campaign.name,
        message: campaign.message,
        status: campaign.status,
        createdAt: campaign.createdAt,
        currentRecipientId: campaign.currentRecipientId,
        businessName: business?.businessName || ''
      },
      summary: campaignSummary(campaign.recipients)
    });
  } catch (error) {
    logControllerError('campaign creation', error);
    return responseError(res, 500, 'Unable to create campaign.');
  }
};

const listCampaigns = async (req, res) => {
  try {
    const page = parsePage(req.query.page, 1, Number.MAX_SAFE_INTEGER);
    const limit = parsePage(req.query.limit, 20, 100);
    const match = { tenantId: req.tenantId, businessId: req.owner.businessId };
    const [campaigns, totals] = await Promise.all([
      GlobalMessageCampaign.aggregate([
        { $match: match },
        { $sort: { createdAt: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $project: {
            name: 1,
            message: 1,
            status: 1,
            createdAt: 1,
            updatedAt: 1,
            totalRecipients: { $size: { $ifNull: ['$recipients', []] } },
            whatsappOpened: { $size: { $filter: { input: '$recipients', as: 'r', cond: { $ne: [{ $ifNull: ['$$r.whatsappOpenedAt', null] }, null] } } } },
            manuallyMarkedSent: { $size: { $filter: { input: '$recipients', as: 'r', cond: { $eq: ['$$r.status', 'MANUALLY_MARKED_SENT'] } } } },
            skipped: { $size: { $filter: { input: '$recipients', as: 'r', cond: { $eq: ['$$r.status', 'SKIPPED'] } } } },
            invalidNumber: { $size: { $filter: { input: '$recipients', as: 'r', cond: { $eq: ['$$r.status', 'INVALID_NUMBER'] } } } },
            pending: { $size: { $filter: { input: '$recipients', as: 'r', cond: { $in: ['$$r.status', ['PENDING', 'WHATSAPP_OPENED']] } } } }
          }
        }
      ]),
      GlobalMessageCampaign.countDocuments(match)
    ]);
    return res.json({
      success: true,
      campaigns,
      pagination: { page, limit, total: totals, totalPages: Math.ceil(totals / limit) }
    });
  } catch (error) {
    logControllerError('campaign history', error);
    return responseError(res, 500, 'Unable to load campaign history.');
  }
};

const getCampaign = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.campaignId)) return responseError(res, 400, 'Invalid campaign id.');
    const page = parsePage(req.query.page, 1, Number.MAX_SAFE_INTEGER);
    const limit = parsePage(req.query.limit, 50, 100);
    const match = {
      _id: new mongoose.Types.ObjectId(req.params.campaignId),
      tenantId: req.tenantId,
      businessId: req.owner.businessId
    };
    const [campaign, result] = await Promise.all([
      GlobalMessageCampaign.findOne(match)
        .select('name message status createdAt updatedAt currentRecipientId')
        .lean(),
      GlobalMessageCampaign.aggregate([
        { $match: match },
        {
          $project: {
            recipients: { $slice: ['$recipients', (page - 1) * limit, limit] },
            totalRecipients: { $size: '$recipients' },
            whatsappOpened: { $size: { $filter: { input: '$recipients', as: 'r', cond: { $ne: [{ $ifNull: ['$$r.whatsappOpenedAt', null] }, null] } } } },
            manuallyMarkedSent: { $size: { $filter: { input: '$recipients', as: 'r', cond: { $eq: ['$$r.status', 'MANUALLY_MARKED_SENT'] } } } },
            skipped: { $size: { $filter: { input: '$recipients', as: 'r', cond: { $eq: ['$$r.status', 'SKIPPED'] } } } },
            invalidNumber: { $size: { $filter: { input: '$recipients', as: 'r', cond: { $eq: ['$$r.status', 'INVALID_NUMBER'] } } } },
            pending: { $size: { $filter: { input: '$recipients', as: 'r', cond: { $in: ['$$r.status', ['PENDING', 'WHATSAPP_OPENED']] } } } },
            currentRecipient: {
              $arrayElemAt: [
                {
                  $filter: {
                    input: '$recipients',
                    as: 'r',
                    cond: { $eq: ['$$r.memberId', '$currentRecipientId'] }
                  }
                },
                0
              ]
            }
          }
        }
      ])
    ]);
    if (!campaign || !result[0]) return responseError(res, 404, 'Campaign not found.');
    const summary = {
      totalRecipients: result[0].totalRecipients,
      whatsappOpened: result[0].whatsappOpened,
      manuallyMarkedSent: result[0].manuallyMarkedSent,
      skipped: result[0].skipped,
      invalidNumber: result[0].invalidNumber,
      pending: result[0].pending
    };
    return res.json({
      success: true,
      campaign,
      recipients: result[0].recipients,
      currentRecipient: result[0].currentRecipient || null,
      summary,
      pagination: { page, limit, total: summary.totalRecipients, totalPages: Math.ceil(summary.totalRecipients / limit) }
    });
  } catch (error) {
    logControllerError('campaign details', error);
    return responseError(res, 500, 'Unable to load campaign details.');
  }
};

const updateRecipient = async (req, res) => {
  try {
    const { campaignId, memberId } = req.params;
    const { status } = req.body;
    if (!mongoose.isValidObjectId(campaignId) || !mongoose.isValidObjectId(memberId)) {
      return responseError(res, 400, 'Invalid campaign or member id.');
    }
    if (!['WHATSAPP_OPENED', 'MANUALLY_MARKED_SENT', 'SKIPPED'].includes(status)) {
      return responseError(res, 400, 'Invalid recipient status.');
    }
    const allowedPrevious = status === 'WHATSAPP_OPENED'
      ? ['PENDING']
      : status === 'MANUALLY_MARKED_SENT'
        ? ['WHATSAPP_OPENED']
        : ['PENDING', 'WHATSAPP_OPENED'];
    const timestampField = status === 'WHATSAPP_OPENED'
      ? 'whatsappOpenedAt'
      : status === 'MANUALLY_MARKED_SENT'
        ? 'manuallyMarkedSentAt'
        : 'skippedAt';
    const recipientObjectId = new mongoose.Types.ObjectId(memberId);
    const updated = await GlobalMessageCampaign.updateOne({
      _id: campaignId,
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      status: 'IN_PROGRESS',
      currentRecipientId: recipientObjectId,
      recipients: { $elemMatch: { memberId: recipientObjectId, status: { $in: allowedPrevious } } }
    }, {
      $set: {
        'recipients.$[recipient].status': status,
        [`recipients.$[recipient].${timestampField}`]: new Date()
      }
    }, {
      arrayFilters: [{ 'recipient.memberId': recipientObjectId, 'recipient.status': { $in: allowedPrevious } }]
    });
    if (!updated.modifiedCount) {
      return responseError(res, 409, 'This recipient cannot be updated in the current campaign state or has already been processed.');
    }
    const campaign = await GlobalMessageCampaign.findOne({
      _id: campaignId,
      tenantId: req.tenantId,
      businessId: req.owner.businessId
    });
    const summary = campaignSummary(campaign.recipients);
    if (summary.pending === 0) {
      campaign.status = 'COMPLETED';
      campaign.currentRecipientId = null;
      await campaign.save();
    }
    return res.json({
      success: true,
      campaign: {
        _id: campaign._id,
        status: campaign.status,
        currentRecipientId: campaign.currentRecipientId
      },
      summary
    });
  } catch (error) {
    logControllerError('recipient update', error);
    return responseError(res, 500, 'Unable to update recipient status.');
  }
};

const advanceCampaign = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.campaignId)) return responseError(res, 400, 'Invalid campaign id.');
    const campaign = await GlobalMessageCampaign.findOne({
      _id: req.params.campaignId,
      tenantId: req.tenantId,
      businessId: req.owner.businessId
    });
    if (!campaign) return responseError(res, 404, 'Campaign not found.');
    if (campaign.status !== 'IN_PROGRESS') return responseError(res, 409, 'Only an in-progress campaign can advance.');
    const current = campaign.recipients.find(recipient =>
      String(recipient.memberId) === String(campaign.currentRecipientId)
    );
    if (current && !['MANUALLY_MARKED_SENT', 'SKIPPED', 'INVALID_NUMBER'].includes(current.status)) {
      return responseError(res, 409, 'Mark this recipient as sent or skip them before moving on.');
    }
    const next = campaign.recipients.find(recipient => recipient.status === 'PENDING');
    if (!next) {
      campaign.status = 'COMPLETED';
      campaign.currentRecipientId = null;
    } else {
      campaign.currentRecipientId = next.memberId;
    }
    await campaign.save();
    return res.json({
      success: true,
      campaign: {
        _id: campaign._id,
        status: campaign.status,
        currentRecipientId: campaign.currentRecipientId
      },
      summary: campaignSummary(campaign.recipients)
    });
  } catch (error) {
    logControllerError('campaign advance', error);
    return responseError(res, 500, 'Unable to move to the next recipient.');
  }
};

const updateCampaignStatus = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.campaignId)) return responseError(res, 400, 'Invalid campaign id.');
    const status = req.body.status;
    const campaign = await GlobalMessageCampaign.findOne({
      _id: req.params.campaignId,
      tenantId: req.tenantId,
      businessId: req.owner.businessId
    });
    if (!campaign) return responseError(res, 404, 'Campaign not found.');
    const allowed = {
      IN_PROGRESS: ['DRAFT', 'PAUSED'],
      PAUSED: ['IN_PROGRESS'],
      STOPPED: ['DRAFT', 'IN_PROGRESS', 'PAUSED']
    };
    if (!allowed[status]?.includes(campaign.status)) {
      return responseError(res, 409, 'Campaign status cannot be changed in its current state.');
    }
    campaign.status = status;
    if (status === 'IN_PROGRESS' && !campaign.currentRecipientId) {
      campaign.currentRecipientId = campaign.recipients.find(recipient => recipient.status === 'PENDING')?.memberId || null;
      if (!campaign.currentRecipientId) campaign.status = 'COMPLETED';
    }
    await campaign.save();
    return res.json({
      success: true,
      campaign: {
        _id: campaign._id,
        status: campaign.status,
        currentRecipientId: campaign.currentRecipientId
      },
      summary: campaignSummary(campaign.recipients)
    });
  } catch (error) {
    logControllerError('campaign status update', error);
    return responseError(res, 500, 'Unable to update campaign status.');
  }
};

module.exports = {
  getEligible,
  getSummary,
  createCampaign,
  listCampaigns,
  getCampaign,
  updateRecipient,
  advanceCampaign,
  updateCampaignStatus
};
