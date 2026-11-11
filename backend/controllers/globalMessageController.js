const mongoose = require('mongoose');
const Business = require('../models/Business');
const GlobalMessageCampaign = require('../models/GlobalMessageCampaign');
const Member = require('../models/Member');
const MemberMembership = require('../models/MemberMembership');
const MembershipPlan = require('../models/MembershipPlan');
const Payment = require('../models/Payment');
const { campaignSummary, normalizeIndianMobile } = require('../utils/globalMessage');
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

const buildMemberFilter = ({ tenantId, businessId, search = '', memberIds }) => {
  const memberFilter = { tenantId, businessId, deletedAt: null };
  if (memberIds) memberFilter._id = { $in: memberIds };
  if (search) {
    const safeSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    memberFilter.$or = [
      { fullName: { $regex: safeSearch, $options: 'i' } },
      { phone: { $regex: safeSearch, $options: 'i' } }
    ];
  }
  return memberFilter;
};

const addMembershipDetails = async (members, { tenantId, businessId }) => {
  if (!members.length) return [];

  const memberships = await MemberMembership.find({
    tenantId,
    businessId,
    memberId: { $in: members.map(member => member._id) },
    status: { $in: ['Active', 'Expired'] }
  })
    .populate({
      path: 'planId',
      select: 'planName',
      match: { tenantId, businessId }
    })
    .sort({ startDate: -1, createdAt: -1 })
    .lean();

  const latestMemberships = new Map();
  for (const membership of memberships) {
    const memberId = String(membership.memberId);
    if (!latestMemberships.has(memberId)) latestMemberships.set(memberId, membership);
  }

  const membershipIds = memberships.map(membership => membership._id);
  const paymentTotals = membershipIds.length
    ? await Payment.aggregate([
        {
          $match: {
            tenantId,
            businessId,
            membershipId: { $in: membershipIds },
            status: 'Success'
          }
        },
        { $group: { _id: '$membershipId', paidAmount: { $sum: '$amount' } } }
      ])
    : [];
  const paidByMembership = new Map(
    paymentTotals.map(payment => [String(payment._id), Number(payment.paidAmount) || 0])
  );

  return members.map(member => {
    const membership = latestMemberships.get(String(member._id)) || null;
    const paidAmount = membership
      ? paidByMembership.get(String(membership._id)) || 0
      : 0;
    const planPrice = Number(membership?.planPrice) || 0;
    return {
      _id: member._id,
      fullName: member.fullName,
      phone: member.phone,
      status: member.status,
      normalizedMobile: normalizeIndianMobile(member.phone),
      membership,
      planName: membership?.planId?.planName || '',
      pendingAmount: Math.max(0, planPrice - paidAmount)
    };
  });
};

const loadMembersWithMembership = async ({ tenantId, businessId, search = '', memberIds }) => {
  const memberFilter = buildMemberFilter({ tenantId, businessId, search, memberIds });
  const members = await Member.find(memberFilter).sort({ createdAt: -1 }).lean();
  return addMembershipDetails(members, { tenantId, businessId });
};

const getExpiryCategory = (membership, window) => {
  if (!membership?.endDate) return 'active';
  const endDate = new Date(membership.endDate);
  const startDate = membership.startDate ? new Date(membership.startDate) : null;
  if (endDate < window.todayStart) return 'expired';
  if (
    endDate < window.tomorrowStart &&
    (!startDate || startDate < window.tomorrowStart)
  ) return 'today';
  if (
    endDate >= window.tomorrowStart &&
    endDate < window.next8DayStart &&
    (!startDate || startDate < window.tomorrowStart)
  ) return 'expiringSoon';
  return 'active';
};

const matchesFilter = (member, filter, window) => {
  const expiryCategory = getExpiryCategory(member.membership, window);
  if (filter === 'active') {
    return member.status === 'Active' && Boolean(member.membership) && expiryCategory !== 'expired';
  }
  if (filter === 'expired') {
    return Boolean(member.membership) && expiryCategory === 'expired';
  }
  if (filter === 'expiringSoon') {
    return member.status === 'Active' &&
      Boolean(member.membership) &&
      ['today', 'expiringSoon'].includes(expiryCategory);
  }
  if (filter === 'pendingFees') return member.pendingAmount > 0;
  return true;
};

const getEligible = async (req, res) => {
  try {
    const filter = String(req.query.filter || 'all');
    const search = String(req.query.search || '').trim().slice(0, 100);
    if (!validFilters.has(filter)) return responseError(res, 400, 'Invalid member filter.');

    const page = parsePage(req.query.page, 1, Number.MAX_SAFE_INTEGER);
    const limit = parsePage(req.query.limit, 50, 100);
    const window = await getTenantExpiryWindow(req.tenantId);
    const memberFilter = buildMemberFilter({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      search
    });
    const cursor = Member.find(memberFilter).sort({ createdAt: -1 }).lean().cursor();
    const pageMembers = [];
    let total = 0;
    let invalidNumberCount = 0;
    let batch = [];
    const processBatch = async () => {
      const enrichedMembers = await addMembershipDetails(batch, {
        tenantId: req.tenantId,
        businessId: req.owner.businessId
      });
      for (const member of enrichedMembers) {
        if (!matchesFilter(member, filter, window)) continue;
        if (!member.normalizedMobile) {
          invalidNumberCount += 1;
          continue;
        }
        if (total >= (page - 1) * limit && pageMembers.length < limit) {
          pageMembers.push(member);
        }
        total += 1;
      }
      batch = [];
    };
    for await (const member of cursor) {
      batch.push(member);
      if (batch.length === 500) await processBatch();
    }
    if (batch.length) await processBatch();
    return res.json({
      success: true,
      members: pageMembers,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      },
      invalidNumberCount
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
    const members = await loadMembersWithMembership({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      memberIds: uniqueIds.map(id => new mongoose.Types.ObjectId(id))
    });
    const eligibleMembers = members.filter(member => member.normalizedMobile);
    if (eligibleMembers.length !== uniqueIds.length) {
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
