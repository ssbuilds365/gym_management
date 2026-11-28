const mongoose = require('mongoose');
const Business = require('../models/Business');
const Member = require('../models/Member');
const Payment = require('../models/Payment');
const Expense = require('../models/Expense');
const TrainerPTPackage = require('../models/TrainerPTPackage');
const TrainerSession = require('../models/TrainerSession');
const PersonalNote = require('../models/PersonalNote');
const { isValidTimeZone, DEFAULT_TIME_ZONE } = require('../utils/membershipExpiry');
const { localDateTimeToUtc, getLocalDateParts } = require('../utils/dashboardPeriods');
const { resolveReportPeriod } = require('../utils/reportPeriods');
const { getExpiringPTWindow, getRemainingDays } = require('../utils/expiringPTClients');

const validId = id => mongoose.Types.ObjectId.isValid(String(id));

const ensurePersonalTrainer = async (req, res) => {
  const business = await Business.findById(req.tenantId).select('businessType timeZone').lean();
  if (!business) {
    res.status(404).json({ success: false, message: 'Business not found' });
    return null;
  }
  if (business.businessType !== 'Personal Trainer') {
    res.status(403).json({ success: false, message: 'This feature is available only for Personal Trainer accounts' });
    return null;
  }
  return business;
};

const parseTime = value => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || '').trim());
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
};

const parseLocalDateTime = (date, time, timeZone) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const parsed = parseTime(time);
  if (!parsed) return null;
  const dateParts = date.split('-').map(Number);
  const check = new Date(Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2]));
  if (
    check.getUTCFullYear() !== dateParts[0] ||
    check.getUTCMonth() + 1 !== dateParts[1] ||
    check.getUTCDate() !== dateParts[2]
  ) return null;
  return localDateTimeToUtc({
    year: dateParts[0],
    month: dateParts[1],
    day: dateParts[2],
    ...parsed
  }, timeZone);
};

const serializeSession = session => {
  const member = session.memberId && typeof session.memberId === 'object' ? session.memberId : null;
  return {
    ...session,
    client: member ? {
      _id: member._id,
      fullName: member.fullName,
      phone: member.phone,
      memberId: member.memberId
    } : null
  };
};

exports.getDashboardSummary = async (req, res) => {
    try {
      const business = await ensurePersonalTrainer(req, res);
      if (!business) return;
      const memberCounts = await Member.aggregate([
        { $match: { tenantId: req.tenantId, businessId: req.owner.businessId, deletedAt: null } },
        { $group: { _id: null, total: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ['$status', 'Active'] }, 1, 0] } } } }
      ]);
      const result = memberCounts[0] || { total: 0, active: 0 };
      return res.json({
        success: true,
        summary: {
          totalMembers: result.total,
          activeMembers: result.active,
          inactiveMembers: Math.max(0, result.total - result.active)
        }
      });
    } catch (error) {
      console.error('Personal trainer summary error:', error);
      return res.status(500).json({ success: false, message: 'Unable to load member summary' });
    }
  };

exports.getDashboardFinancials = async (req, res) => {
    try {
      const business = await ensurePersonalTrainer(req, res);
      if (!business) return;
      const timeZone = isValidTimeZone(business.timeZone) ? business.timeZone : DEFAULT_TIME_ZONE;
      const period = resolveReportPeriod({
        period: req.query.period || 'month',
        from: req.query.from,
        to: req.query.to,
        timezone: timeZone
      });
      if (!period) return res.status(400).json({ success: false, message: 'Invalid revenue date range' });

      const [paymentTotals, expenseTotals] = await Promise.all([
        Payment.aggregate([
          { $match: {
            tenantId: req.tenantId,
            businessId: req.owner.businessId,
            paymentDate: { $gte: period.from, $lt: period.toExclusive }
          } },
          { $group: {
            _id: null,
            revenue: { $sum: { $cond: [{ $eq: ['$status', 'Success'] }, '$amount', 0] } },
            pending: { $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, '$amount', 0] } },
            refunded: { $sum: { $cond: [{ $eq: ['$status', 'Refunded'] }, '$amount', 0] } },
            successfulCount: { $sum: { $cond: [{ $eq: ['$status', 'Success'] }, 1, 0] } }
          } }
        ]),
        Expense.aggregate([
          { $match: {
            tenantId: req.tenantId,
            businessId: req.owner.businessId,
            deletedAt: null,
            archivedAt: null,
            expenseDate: { $gte: period.from, $lt: period.toExclusive }
          } },
          { $group: { _id: null, totalMinor: { $sum: '$amountMinor' } } }
        ])
      ]);
      const totals = paymentTotals[0] || { revenue: 0, pending: 0, refunded: 0, successfulCount: 0 };
      const expenses = (expenseTotals[0]?.totalMinor || 0) / 100;
      return res.json({
        success: true,
        timeZone,
        period: { from: period.from, to: period.to, period: period.period },
        financials: {
          monthlyRevenue: totals.revenue,
          monthlyExpenses: expenses,
          monthlyProfit: totals.revenue - expenses,
          pendingPayments: totals.pending,
          refundedPayments: totals.refunded,
          successfulTransactionCount: totals.successfulCount
        }
      });
    } catch (error) {
      console.error('Personal trainer financials error:', error);
      return res.status(500).json({ success: false, message: 'Unable to load financial metrics' });
    }
  };

exports.getDashboardSessions = async (req, res) => {
    try {
      const business = await ensurePersonalTrainer(req, res);
      if (!business) return;
      const sessions = await TrainerSession.find({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        ownerId: req.owner._id,
        status: { $ne: 'Cancelled' },
        endAt: { $gte: new Date() }
      })
        .select('memberId startAt endAt title status')
        .populate('memberId', 'fullName phone memberId')
        .sort({ startAt: 1 })
        .limit(5)
        .lean();
      return res.json({ success: true, upcomingSessions: sessions.map(serializeSession) });
    } catch (error) {
      console.error('Personal trainer dashboard sessions error:', error);
      return res.status(500).json({ success: false, message: 'Unable to load upcoming sessions' });
    }
  };

exports.getDashboardExpiringPlans = async (req, res) => {
    try {
      const business = await ensurePersonalTrainer(req, res);
      if (!business) return;
      const timeZone = isValidTimeZone(business.timeZone) ? business.timeZone : DEFAULT_TIME_ZONE;
      const ptWindow = getExpiringPTWindow(new Date(), timeZone);
      const packages = await TrainerPTPackage.find({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        status: 'Active',
        endDate: { $gte: ptWindow.start, $lt: ptWindow.endExclusive }
      })
        .select('memberId packageName endDate')
        .populate('memberId', 'fullName phone memberId')
        .sort({ endDate: 1 })
        .limit(100)
        .lean();
      const byMember = new Map();
      for (const pkg of packages) {
        if (!pkg.memberId) continue;
        const key = String(pkg.memberId._id);
        if (!byMember.has(key)) {
          byMember.set(key, {
            member: pkg.memberId,
            packageName: pkg.packageName,
            expiryDate: pkg.endDate,
            remainingDays: getRemainingDays(pkg.endDate, new Date(), timeZone),
            status: 'Active'
          });
        }
      }
      const expiringPlans = Array.from(byMember.values()).sort((a, b) => a.remainingDays - b.remainingDays);
      return res.json({ success: true, expiringPlans });
    } catch (error) {
      console.error('Personal trainer expiring plans error:', error);
      return res.status(500).json({ success: false, message: 'Unable to load expiring training plans' });
    }
};

exports.getDashboard = async (req, res) => {
  try {
    const business = await ensurePersonalTrainer(req, res);
    if (!business) return;
    const timeZone = isValidTimeZone(business.timeZone) ? business.timeZone : DEFAULT_TIME_ZONE;
    const period = resolveReportPeriod({
      period: req.query.period || 'month',
      from: req.query.from,
      to: req.query.to,
      timezone: timeZone
    });
    if (!period) return res.status(400).json({ success: false, message: 'Invalid revenue date range' });
    const ptWindow = getExpiringPTWindow(new Date(), timeZone);

    const [
      totalMembers,
      activeMembers,
      successfulRevenue,
      pendingPayments,
      refundedPayments,
      transactionCount,
      expenses,
      upcomingSessions,
      expiringPackages
    ] = await Promise.all([
      Member.countDocuments({ tenantId: req.tenantId, businessId: req.owner.businessId, deletedAt: null }),
      Member.countDocuments({ tenantId: req.tenantId, businessId: req.owner.businessId, deletedAt: null, status: 'Active' }),
      Payment.aggregate([
        { $match: { tenantId: req.tenantId, businessId: req.owner.businessId, status: 'Success', paymentDate: { $gte: period.from, $lt: period.toExclusive } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]),
      Payment.aggregate([
        { $match: { tenantId: req.tenantId, businessId: req.owner.businessId, status: 'Pending', paymentDate: { $gte: period.from, $lt: period.toExclusive } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Payment.aggregate([
        { $match: { tenantId: req.tenantId, businessId: req.owner.businessId, status: 'Refunded', paymentDate: { $gte: period.from, $lt: period.toExclusive } } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Payment.countDocuments({ tenantId: req.tenantId, businessId: req.owner.businessId, status: 'Success', paymentDate: { $gte: period.from, $lt: period.toExclusive } }),
      Expense.aggregate([
        { $match: { tenantId: req.tenantId, businessId: req.owner.businessId, deletedAt: null, archivedAt: null, expenseDate: { $gte: period.from, $lt: period.toExclusive } } },
        { $group: { _id: null, totalMinor: { $sum: '$amountMinor' } } }
      ]),
      TrainerSession.find({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        ownerId: req.owner._id,
        status: { $ne: 'Cancelled' },
        endAt: { $gte: new Date() }
      }).populate('memberId', 'fullName phone memberId').sort({ startAt: 1 }).limit(5).lean(),
      TrainerPTPackage.find({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        status: 'Active',
        endDate: { $gte: ptWindow.start, $lt: ptWindow.endExclusive }
      }).populate('memberId', 'fullName phone memberId').sort({ endDate: 1 }).lean()
    ]);

    const revenue = successfulRevenue[0]?.total || 0;
    const expenseTotal = (expenses[0]?.totalMinor || 0) / 100;
    const expiringByMember = new Map();
    for (const pkg of expiringPackages) {
      if (!pkg.memberId) continue;
      const memberKey = String(pkg.memberId._id);
      if (!expiringByMember.has(memberKey)) {
        expiringByMember.set(memberKey, {
          member: pkg.memberId,
          packageName: pkg.packageName,
          expiryDate: pkg.endDate,
          remainingDays: getRemainingDays(pkg.endDate, new Date(), timeZone),
          status: 'Active'
        });
      }
    }
    const expiringPlans = Array.from(expiringByMember.values())
      .sort((a, b) => a.remainingDays - b.remainingDays);

    return res.json({
      success: true,
      timeZone,
      period: { from: period.from, to: period.to, period: period.period },
      summary: {
        totalMembers,
        activeMembers,
        inactiveMembers: Math.max(0, totalMembers - activeMembers),
        monthlyRevenue: revenue,
        monthlyExpenses: expenseTotal,
        monthlyProfit: revenue - expenseTotal,
        pendingPayments: pendingPayments[0]?.total || 0,
        refundedPayments: refundedPayments[0]?.total || 0,
        successfulTransactionCount: transactionCount
      },
      upcomingSessions: upcomingSessions.map(serializeSession),
      expiringPlans
    });
  } catch (error) {
    console.error('Personal trainer dashboard error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load Personal Trainer dashboard' });
  }
};

exports.listSessions = async (req, res) => {
  try {
    const business = await ensurePersonalTrainer(req, res);
    if (!business) return;
    const timeZone = isValidTimeZone(business.timeZone) ? business.timeZone : DEFAULT_TIME_ZONE;
    const filter = { tenantId: req.tenantId, businessId: req.owner.businessId, ownerId: req.owner._id };
    if (['Scheduled', 'Completed', 'Cancelled'].includes(req.query.status)) filter.status = req.query.status;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))) {
      const date = parseLocalDateTime(req.query.date, '00:00', timeZone);
      if (!date) return res.status(400).json({ success: false, message: 'Invalid date filter' });
      const parts = getLocalDateParts(date, timeZone);
      const next = localDateTimeToUtc({ year: parts.year, month: parts.month, day: parts.day + 1 }, timeZone);
      filter.startAt = { $gte: date, $lt: next };
    }
    const sessions = await TrainerSession.find(filter)
      .populate('memberId', 'fullName phone memberId')
      .sort({ startAt: 1 }).lean();
    return res.json({ success: true, timeZone, sessions: sessions.map(serializeSession) });
  } catch (error) {
    console.error('List trainer sessions error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load sessions' });
  }
};

exports.createSession = async (req, res) => {
  try {
    const business = await ensurePersonalTrainer(req, res);
    if (!business) return;
    const timeZone = isValidTimeZone(business.timeZone) ? business.timeZone : DEFAULT_TIME_ZONE;
    const { memberId, title, date, startTime, endTime, notes = '' } = req.body || {};
    if (!validId(memberId)) return res.status(400).json({ success: false, message: 'Select a valid client' });
    if (!String(title || '').trim()) return res.status(400).json({ success: false, message: 'Session title is required' });
    const startAt = parseLocalDateTime(date, startTime, timeZone);
    const endAt = parseLocalDateTime(date, endTime, timeZone);
    if (!startAt || !endAt) return res.status(400).json({ success: false, message: 'Enter a valid date and time' });
    if (endAt <= startAt) return res.status(400).json({ success: false, message: 'End time must be later than start time' });
    const member = await Member.findOne({
      _id: memberId,
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      deletedAt: null
    }).select('_id').lean();
    if (!member) return res.status(404).json({ success: false, message: 'Client not found in this business' });
    const overlap = await TrainerSession.findOne({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      ownerId: req.owner._id,
      status: { $ne: 'Cancelled' },
      startAt: { $lt: endAt },
      endAt: { $gt: startAt }
    }).lean();
    if (overlap) return res.status(409).json({ success: false, code: 'SESSION_OVERLAP', message: 'This time overlaps another scheduled session' });
    const session = await TrainerSession.create({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      ownerId: req.owner._id,
      memberId: member._id,
      title: String(title).trim(),
      startAt,
      endAt,
      notes: String(notes).trim().slice(0, 2000),
      status: 'Scheduled'
    });
    return res.status(201).json({ success: true, session: await TrainerSession.findById(session._id).populate('memberId', 'fullName phone memberId').lean() });
  } catch (error) {
    console.error('Create trainer session error:', error);
    return res.status(500).json({ success: false, message: 'Unable to create session' });
  }
};

exports.updateSession = async (req, res) => {
  try {
    const business = await ensurePersonalTrainer(req, res);
    if (!business) return;
    if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid session ID' });
    const session = await TrainerSession.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      ownerId: req.owner._id
    });
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const timeZone = isValidTimeZone(business.timeZone) ? business.timeZone : DEFAULT_TIME_ZONE;
    const next = { ...req.body };
    if (next.memberId !== undefined) {
      if (!validId(next.memberId)) return res.status(400).json({ success: false, message: 'Select a valid client' });
      const member = await Member.findOne({ _id: next.memberId, tenantId: req.tenantId, businessId: req.owner.businessId, deletedAt: null }).select('_id').lean();
      if (!member) return res.status(404).json({ success: false, message: 'Client not found in this business' });
      session.memberId = member._id;
    }
    if (next.title !== undefined) {
      if (!String(next.title).trim()) return res.status(400).json({ success: false, message: 'Session title is required' });
      session.title = String(next.title).trim();
    }
    if (next.notes !== undefined) session.notes = String(next.notes).trim().slice(0, 2000);
    if (['Scheduled', 'Completed', 'Cancelled'].includes(next.status)) {
      if (next.status === 'Completed' && session.startAt && session.endAt && session.endAt > new Date()) {
        return res.status(400).json({ success: false, message: 'A session cannot be completed before it ends' });
      }
      session.status = next.status;
    }
    if (next.date !== undefined || next.startTime !== undefined || next.endTime !== undefined) {
      const date = next.date || getLocalDateParts(session.startAt, timeZone);
      const dateString = typeof date === 'string'
        ? date
        : `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
      const startParts = getLocalDateParts(session.startAt, timeZone);
      const endParts = getLocalDateParts(session.endAt, timeZone);
      const startTime = next.startTime || `${String(startParts.hour).padStart(2, '0')}:${String(startParts.minute).padStart(2, '0')}`;
      const endTime = next.endTime || `${String(endParts.hour).padStart(2, '0')}:${String(endParts.minute).padStart(2, '0')}`;
      const startAt = parseLocalDateTime(dateString, startTime, timeZone);
      const endAt = parseLocalDateTime(dateString, endTime, timeZone);
      if (!startAt || !endAt || endAt <= startAt) return res.status(400).json({ success: false, message: 'End time must be later than start time' });
      const overlap = await TrainerSession.findOne({
        _id: { $ne: session._id },
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        ownerId: req.owner._id,
        status: { $ne: 'Cancelled' },
        startAt: { $lt: endAt },
        endAt: { $gt: startAt }
      }).lean();
      if (overlap) return res.status(409).json({ success: false, code: 'SESSION_OVERLAP', message: 'This time overlaps another scheduled session' });
      session.startAt = startAt;
      session.endAt = endAt;
    }
    await session.save();
    const result = await TrainerSession.findById(session._id).populate('memberId', 'fullName phone memberId').lean();
    return res.json({ success: true, session: serializeSession(result) });
  } catch (error) {
    console.error('Update trainer session error:', error);
    return res.status(500).json({ success: false, message: 'Unable to update session' });
  }
};

exports.deleteSession = async (req, res) => {
  try {
    const business = await ensurePersonalTrainer(req, res);
    if (!business) return;
    if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid session ID' });
    const deleted = await TrainerSession.findOneAndDelete({
      _id: req.params.id,
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      ownerId: req.owner._id
    });
    if (!deleted) return res.status(404).json({ success: false, message: 'Session not found' });
    return res.json({ success: true, message: 'Session deleted' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Unable to delete session' });
  }
};

exports.listNotes = async (req, res) => {
  const business = await ensurePersonalTrainer(req, res);
  if (!business) return;
  const search = String(req.query.search || '').trim().slice(0, 100);
  const filter = { tenantId: req.tenantId, businessId: req.owner.businessId, ownerId: req.owner._id };
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = new RegExp(escaped, 'i');
    filter.$or = [{ title: expression }, { content: expression }];
  }
  const notes = await PersonalNote.find(filter).sort({ updatedAt: -1 }).lean();
  return res.json({ success: true, notes });
};

exports.createNote = async (req, res) => {
  const business = await ensurePersonalTrainer(req, res);
  if (!business) return;
  const title = String(req.body?.title || '').trim();
  const content = String(req.body?.content || '').trim();
  if (!title || title.length > 160) return res.status(400).json({ success: false, message: 'Title is required and must be 160 characters or fewer' });
  if (!content || content.length > 10000) return res.status(400).json({ success: false, message: 'Note content is required and must be 10,000 characters or fewer' });
  const note = await PersonalNote.create({
    tenantId: req.tenantId,
    businessId: req.owner.businessId,
    ownerId: req.owner._id,
    title,
    content
  });
  return res.status(201).json({ success: true, note });
};

exports.updateNote = async (req, res) => {
  const business = await ensurePersonalTrainer(req, res);
  if (!business) return;
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid note ID' });
  const note = await PersonalNote.findOne({
    _id: req.params.id,
    tenantId: req.tenantId,
    businessId: req.owner.businessId,
    ownerId: req.owner._id
  });
  if (!note) return res.status(404).json({ success: false, message: 'Note not found' });
  if (req.body?.title !== undefined) {
    note.title = String(req.body.title).trim();
    if (!note.title || note.title.length > 160) return res.status(400).json({ success: false, message: 'Title is required and must be 160 characters or fewer' });
  }
  if (req.body?.content !== undefined) {
    note.content = String(req.body.content).trim();
    if (!note.content || note.content.length > 10000) return res.status(400).json({ success: false, message: 'Note content is required and must be 10,000 characters or fewer' });
  }
  await note.save();
  return res.json({ success: true, note });
};

exports.deleteNote = async (req, res) => {
  const business = await ensurePersonalTrainer(req, res);
  if (!business) return;
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid note ID' });
  const deleted = await PersonalNote.findOneAndDelete({
    _id: req.params.id,
    tenantId: req.tenantId,
    businessId: req.owner.businessId,
    ownerId: req.owner._id
  });
  if (!deleted) return res.status(404).json({ success: false, message: 'Note not found' });
  return res.json({ success: true, message: 'Note deleted' });
};
