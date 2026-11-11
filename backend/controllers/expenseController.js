const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const ExcelJS = require('exceljs');
const config = require('../config/env');
const Business = require('../models/Business');
const Expense = require('../models/Expense');
const ExpenseAudit = require('../models/ExpenseAudit');
const ExpenseCategory = require('../models/ExpenseCategory');
const {
  DEFAULT_EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  deriveExpenseStatus,
  expenseSnapshot,
  parseExpenseDate,
  serializeExpense,
  toMinorUnits
} = require('../utils/expenses');
const {
  isValidTimeZone,
  resolveReportPeriod
} = require('../utils/reportPeriods');
const { DEFAULT_TIME_ZONE } = require('../utils/membershipExpiry');
const { getLocalDateParts, localDateTimeToUtc } = require('../utils/dashboardPeriods');

cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key: config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret,
  secure: true
});

const VALID_STATUSES = ['PAID', 'PENDING', 'PARTIAL', 'PARTIALLY_PAID'];
const SORT_FIELDS = {
  expenseDate: 'expenseDate',
  title: 'title',
  category: 'category',
  vendor: 'vendor',
  amount: 'amountMinor',
  status: 'status'
};
const validId = id => mongoose.Types.ObjectId.isValid(id);
const normalizedName = name => String(name || '').trim().toLocaleLowerCase('en');
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RECEIPT_FORMATS = new Set(['pdf', 'jpg', 'jpeg', 'png']);
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const cloudinaryConfigured = () => Boolean(
  config.cloudinary.cloudName && config.cloudinary.apiKey && config.cloudinary.apiSecret
);
const sanitizedFileName = value => String(value || '')
  .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
  .trim()
  .slice(0, 150);

const getBusiness = req => Business.findById(req.tenantId)
  .select('timeZone businessName logoUrl expenseRetentionMonths')
  .lean();

const getBusinessTimeZone = business =>
  isValidTimeZone(business?.timeZone) ? business.timeZone : DEFAULT_TIME_ZONE;

const resolveRange = (query, timeZone) => {
  if (!query.period && !query.from && !query.to) return null;
  if (query.period === 'all' && !query.from && !query.to) return null;
  const period = query.from || query.to ? 'custom' : query.period || 'custom';
  return resolveReportPeriod({
    period,
    from: query.from,
    to: query.to,
    timezone: timeZone
  });
};

const buildExpenseFilter = ({ tenantId, businessId, query, range }) => {
  const filter = { tenantId, businessId };
  if (query.archived === 'true') {
    const archivedFilter = { $or: [
      { archivedAt: { $ne: null } },
      { deletedAt: { $ne: null } }
    ] };
    filter.$and = [archivedFilter];
  } else if (query.archived !== 'all') {
    filter.archivedAt = null;
    filter.deletedAt = null;
  }
  if (range) filter.expenseDate = { $gte: range.from, $lt: range.toExclusive };

  if (query.category) filter.category = String(query.category).trim().slice(0, 80);
  if (query.status && VALID_STATUSES.includes(String(query.status))) {
    filter.status = String(query.status) === 'PARTIAL'
      ? { $in: ['PARTIAL', 'PARTIALLY_PAID'] }
      : String(query.status);
  }
  const search = String(query.search || '').trim().slice(0, 100);
  if (search) {
    const expression = new RegExp(escapeRegex(search), 'i');
    const searchFilter = { $or: [
      { title: expression },
      { category: expression },
      { vendor: expression },
      { invoiceNumber: expression },
      { transactionReference: expression }
    ] };
    if (filter.$and) {
      filter.$and.push(searchFilter);
    } else {
      filter.$or = searchFilter.$or;
    }
  }
  return filter;
};

const parseCreateData = (body, timeZone) => {
  const title = String(body.title || '').trim();
  const category = String(body.category || '').trim();
  const amountMinor = toMinorUnits(body.amount);
  const expenseDate = parseExpenseDate(body.expenseDate, timeZone);
  if (!title || title.length > 120) return { error: 'Expense title is required and must be at most 120 characters' };
  if (!category || category.length > 80) return { error: 'Select a valid expense category' };
  if (amountMinor === null) return { error: 'Enter an amount greater than zero with no more than two decimal places' };
  if (!expenseDate) return { error: 'Enter a valid expense date' };

  const dueDate = body.dueDate ? parseExpenseDate(body.dueDate, timeZone) : null;
  if (body.dueDate && !dueDate) return { error: 'Enter a valid due date' };

  return {
    data: {
      title,
      category,
      amountMinor,
      paidAmountMinor: 0,
      status: 'PENDING',
      paymentMethod: null,
      expenseDate,
      dueDate,
      vendor: String(body.vendor || '').trim().slice(0, 120),
      invoiceNumber: String(body.invoiceNumber || '').trim().slice(0, 80),
      transactionReference: String(body.transactionReference || '').trim().slice(0, 120),
      description: String(body.description || '').trim().slice(0, 2000),
      notes: String(body.notes || '').trim().slice(0, 2000),
      payments: []
    }
  };
};

const categoryExists = async (tenantId, name) => {
  if (DEFAULT_EXPENSE_CATEGORIES.some(item => normalizedName(item) === normalizedName(name))) {
    return true;
  }
  return Boolean(await ExpenseCategory.exists({
    tenantId,
    normalizedName: normalizedName(name),
    isActive: true
  }));
};

const resolveSummary = async ({ tenantId, businessId, query, selectedRange, timeZone, now }) => {
  const selectedFilter = buildExpenseFilter({
    tenantId, businessId, query: { ...query, archived: 'all' }, range: selectedRange
  });
  const monthRange = resolveReportPeriod({ period: 'month', timezone: timeZone }, now);
  const todayRange = resolveReportPeriod({ period: 'today', timezone: timeZone }, now);
  const base = { tenantId, businessId };
  const group = {
    _id: null,
    totalMinor: { $sum: '$amountMinor' },
    paidMinor: { $sum: '$paidAmountMinor' }
  };
  const summarize = filter => Expense.aggregate([
    { $match: filter },
    { $group: group }
  ]);
  const currentLocal = getLocalDateParts(now, timeZone);
  const trendStart = new Date(Date.UTC(currentLocal.year, currentLocal.month - 12, 1));
  const trendEnd = localDateTimeToUtc({
    year: currentLocal.year,
    month: currentLocal.month + 1,
    day: 1
  }, timeZone);
  const trendFrom = localDateTimeToUtc({
    year: trendStart.getUTCFullYear(),
    month: trendStart.getUTCMonth() + 1,
    day: 1
  }, timeZone);
  const trendFilter = buildExpenseFilter({
    tenantId,
    businessId,
    query: { ...query, period: undefined, from: undefined, to: undefined, archived: 'all' },
    range: { from: trendFrom, toExclusive: trendEnd }
  });
  const [selected, month, today, categoryRows, totalRecords, monthlyRows] = await Promise.all([
    summarize(selectedFilter),
    summarize({ ...base, expenseDate: { $gte: monthRange.from, $lt: monthRange.toExclusive } }),
    summarize({ ...base, expenseDate: { $gte: todayRange.from, $lt: todayRange.toExclusive } }),
    Expense.aggregate([
      { $match: selectedFilter },
      { $group: { _id: '$category', totalMinor: { $sum: '$amountMinor' } } },
      { $sort: { totalMinor: -1, _id: 1 } }
    ]),
    Expense.countDocuments(selectedFilter),
    Expense.aggregate([
      { $match: trendFilter },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$expenseDate', timezone: timeZone } },
          totalMinor: { $sum: '$amountMinor' }
        }
      },
      { $sort: { _id: 1 } }
    ])
  ]);
  const selectedTotals = selected[0] || { totalMinor: 0, paidMinor: 0 };
  const monthTotals = month[0] || { totalMinor: 0 };
  const todayTotals = today[0] || { totalMinor: 0 };
  const monthlyTotals = new Map(monthlyRows.map(row => [row._id, row.totalMinor]));
  const monthlyTrend = [];
  for (let offset = 11; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(currentLocal.year, currentLocal.month - 1 - offset, 1));
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    monthlyTrend.push({
      month: key,
      total: (monthlyTotals.get(key) || 0) / 100
    });
  }
  return {
    totalRecords,
    totalExpenses: selectedTotals.totalMinor / 100,
    paidExpenses: selectedTotals.paidMinor / 100,
    pendingExpenses: Math.max(0, selectedTotals.totalMinor - selectedTotals.paidMinor) / 100,
    outstandingAmount: Math.max(0, selectedTotals.totalMinor - selectedTotals.paidMinor) / 100,
    thisMonthExpenses: monthTotals.totalMinor / 100,
    todayExpenses: todayTotals.totalMinor / 100,
    highestExpenseCategory: categoryRows[0]
      ? { name: categoryRows[0]._id, amount: categoryRows[0].totalMinor / 100 }
      : null,
    categories: categoryRows.map(row => ({
      name: row._id,
      amount: row.totalMinor / 100
    })),
    monthlyTrend
  };
};

const getListParameters = query => {
  const pageValue = Number.parseInt(query.page, 10);
  const limitValue = Number.parseInt(query.limit, 10);
  const sortBy = SORT_FIELDS[String(query.sortBy || 'expenseDate')] || 'expenseDate';
  const direction = query.sortDirection === 'asc' ? 1 : -1;
  return {
    page: Number.isInteger(pageValue) && pageValue > 0 ? pageValue : 1,
    limit: Number.isInteger(limitValue) && limitValue > 0 ? Math.min(100, limitValue) : 25,
    sort: { [sortBy]: direction, _id: direction }
  };
};

exports.listExpenses = async (req, res) => {
  try {
    const business = await getBusiness(req);
    if (!business) return res.status(404).json({ success: false, message: 'Business not found' });
    const timeZone = getBusinessTimeZone(business);
    const range = resolveRange(req.query, timeZone);
    if (
      (req.query.period && req.query.period !== 'all' || req.query.from || req.query.to) &&
      !range
    ) {
      return res.status(400).json({ success: false, message: 'Select a valid expense date range' });
    }

    const filter = buildExpenseFilter({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      query: req.query,
      range
    });
    const { page, limit, sort } = getListParameters(req.query);
    const [rows, total, summary] = await Promise.all([
      Expense.find(filter)
        .populate('payments.recordedBy', 'name')
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Expense.countDocuments(filter),
      resolveSummary({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        query: req.query,
        selectedRange: range,
        timeZone,
        now: new Date()
      })
    ]);

    return res.json({
      success: true,
      expenses: rows.map(serializeExpense),
      summary,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      timeZone
    });
  } catch (error) {
    console.error('List expenses error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load expenses' });
  }
};

exports.getExpense = async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid expense ID' });
    const expense = await Expense.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
      businessId: req.owner.businessId
    }).populate('payments.recordedBy', 'name').lean();
    if (!expense) return res.status(404).json({ success: false, message: 'Expense not found' });
    return res.json({ success: true, expense: serializeExpense(expense) });
  } catch (error) {
    console.error('Get expense error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load expense details' });
  }
};

exports.createExpense = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const business = await getBusiness(req);
    if (!business) return res.status(404).json({ success: false, message: 'Business not found' });
    const { data, error } = parseCreateData(req.body, getBusinessTimeZone(business));
    if (error) return res.status(400).json({ success: false, message: error });
    if (!await categoryExists(req.tenantId, data.category)) {
      return res.status(400).json({ success: false, message: 'Select an active expense category' });
    }

    let created;
    await session.withTransaction(async () => {
      const [expense] = await Expense.create([{
        ...data,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        createdBy: req.owner._id,
        updatedBy: req.owner._id
      }], { session });
      await ExpenseAudit.create([{
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        expenseId: expense._id,
        action: 'CREATED',
        actorId: req.owner._id,
        after: expenseSnapshot(expense)
      }], { session });
      created = expense;
    });
    return res.status(201).json({ success: true, expense: serializeExpense(created) });
  } catch (error) {
    console.error('Create expense error:', error);
    return res.status(500).json({ success: false, message: 'Unable to create expense' });
  } finally {
    await session.endSession();
  }
};

exports.updateExpense = async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid expense ID' });
  const session = await mongoose.startSession();
  try {
    const business = await getBusiness(req);
    if (!business) return res.status(404).json({ success: false, message: 'Business not found' });
    const filter = {
      _id: req.params.id,
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      archivedAt: null,
      deletedAt: null
    };
    let updated;
    const action = 'UPDATED';
    await session.withTransaction(async () => {
      const expense = await Expense.findOne(filter).session(session);
      if (!expense) return;
      const before = expenseSnapshot(expense);
      const body = req.body || {};
      if (body.title !== undefined) {
        const title = String(body.title || '').trim();
        if (!title || title.length > 120) throw Object.assign(new Error('Enter a valid expense title'), { status: 400 });
        expense.title = title;
      }
      if (body.category !== undefined) {
        const category = String(body.category || '').trim();
        if (!category || category.length > 80 || !await categoryExists(req.tenantId, category)) {
          throw Object.assign(new Error('Select an active expense category'), { status: 400 });
        }
        expense.category = category;
      }
      if (body.amount !== undefined) {
        const amountMinor = toMinorUnits(body.amount);
        if (amountMinor === null || amountMinor < expense.paidAmountMinor) {
          throw Object.assign(new Error('Expense amount cannot be less than the amount already paid'), { status: 400 });
        }
        expense.amountMinor = amountMinor;
      }
      if (body.expenseDate !== undefined) {
        const expenseDate = parseExpenseDate(body.expenseDate, getBusinessTimeZone(business));
        if (!expenseDate) throw Object.assign(new Error('Enter a valid expense date'), { status: 400 });
        expense.expenseDate = expenseDate;
      }
      if (body.dueDate !== undefined) {
        const dueDate = body.dueDate
          ? parseExpenseDate(body.dueDate, getBusinessTimeZone(business))
          : null;
        if (body.dueDate && !dueDate) throw Object.assign(new Error('Enter a valid due date'), { status: 400 });
        expense.dueDate = dueDate;
      }
      for (const [field, maxLength] of [
        ['vendor', 120],
        ['invoiceNumber', 80],
        ['transactionReference', 120],
        ['description', 2000],
        ['notes', 2000]
      ]) {
        if (body[field] !== undefined) expense[field] = String(body[field] || '').trim().slice(0, maxLength);
      }
      if (body.paymentAmount !== undefined && Number(body.paymentAmount) !== 0) {
        throw Object.assign(new Error('Record payments through the dedicated payment endpoint'), { status: 400 });
      }
      expense.status = deriveExpenseStatus(expense.amountMinor, expense.paidAmountMinor);
      if (body.status && body.status !== expense.status) {
        throw Object.assign(new Error('Payment status is calculated from recorded payments and cannot be changed directly'), { status: 400 });
      }
      expense.updatedBy = req.owner._id;
      await expense.save({ session });
      await ExpenseAudit.create([{
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        expenseId: expense._id,
        action,
        actorId: req.owner._id,
        before,
        after: expenseSnapshot(expense)
      }], { session });
      updated = expense;
    });
    if (!updated) return res.status(404).json({ success: false, message: 'Expense not found' });
    return res.json({ success: true, expense: serializeExpense(updated) });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ success: false, message: error.message });
    console.error('Update expense error:', error);
    return res.status(500).json({ success: false, message: 'Unable to update expense' });
  } finally {
    await session.endSession();
  }
};

exports.archiveExpense = async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid expense ID' });
  const session = await mongoose.startSession();
  try {
    let archived;
    await session.withTransaction(async () => {
      const expense = await Expense.findOne({
        _id: req.params.id,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        archivedAt: null,
        deletedAt: null
      }).session(session);
      if (!expense) return;
      const before = expenseSnapshot(expense);
      expense.archivedAt = new Date();
      expense.archivedBy = req.owner._id;
      expense.updatedBy = req.owner._id;
      await expense.save({ session });
      await ExpenseAudit.create([{
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        expenseId: expense._id,
        action: 'ARCHIVED',
        actorId: req.owner._id,
        before,
        after: expenseSnapshot(expense)
      }], { session });
      archived = expense;
    });
    if (!archived) return res.status(404).json({ success: false, message: 'Active expense not found' });
    return res.json({
      success: true,
      message: 'Expense archived. Its history and payment records are retained.',
      expense: serializeExpense(archived)
    });
  } catch (error) {
    console.error('Archive expense error:', error);
    return res.status(500).json({ success: false, message: 'Unable to archive expense' });
  } finally {
    await session.endSession();
  }
};

exports.deleteExpense = exports.archiveExpense;

exports.restoreExpense = async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid expense ID' });
  const session = await mongoose.startSession();
  try {
    let restored;
    await session.withTransaction(async () => {
      const expense = await Expense.findOne({
        _id: req.params.id,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        $or: [
          { archivedAt: { $ne: null } },
          { deletedAt: { $ne: null } }
        ]
      }).session(session);
      if (!expense) return;
      const before = expenseSnapshot(expense);
      expense.archivedAt = null;
      expense.archivedBy = null;
      expense.deletedAt = null;
      expense.deletedBy = null;
      expense.updatedBy = req.owner._id;
      await expense.save({ session });
      await ExpenseAudit.create([{
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        expenseId: expense._id,
        action: 'RESTORED',
        actorId: req.owner._id,
        before,
        after: expenseSnapshot(expense)
      }], { session });
      restored = expense;
    });
    if (!restored) return res.status(404).json({ success: false, message: 'Archived expense not found' });
    return res.json({ success: true, expense: serializeExpense(restored) });
  } catch (error) {
    console.error('Restore expense error:', error);
    return res.status(500).json({ success: false, message: 'Unable to restore expense' });
  } finally {
    await session.endSession();
  }
};

exports.recordExpensePayment = async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid expense ID' });
  const amountMinor = toMinorUnits(req.body?.amount);
  const paymentMethod = String(req.body?.paymentMethod || '');
  const requestId = String(req.body?.requestId || '');
  if (amountMinor === null) {
    return res.status(400).json({ success: false, message: 'Enter a payment amount greater than zero.' });
  }
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    return res.status(400).json({ success: false, message: 'Select a valid payment method.' });
  }
  if (!/^[\w-]{16,80}$/.test(requestId)) {
    return res.status(400).json({ success: false, message: 'A valid payment request ID is required.' });
  }

  let session;
  try {
    session = await mongoose.startSession();
    const business = await getBusiness(req);
    if (!business) return res.status(404).json({ success: false, message: 'Business not found' });
    const timeZone = getBusinessTimeZone(business);
    const selectedRange = resolveRange(req.query, timeZone);
    if (
      (req.query.period && req.query.period !== 'all' || req.query.from || req.query.to) &&
      !selectedRange
    ) {
      return res.status(400).json({ success: false, message: 'Select a valid expense date range' });
    }
    const paidAt = req.body.paymentDate
      ? parseExpenseDate(req.body.paymentDate, timeZone)
      : new Date();
    if (!paidAt) return res.status(400).json({ success: false, message: 'Enter a valid payment date.' });

    let updated;
    let duplicate = false;
    await session.withTransaction(async () => {
      const expense = await Expense.findOne({
        _id: req.params.id,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        archivedAt: null,
        deletedAt: null
      }).session(session);
      if (!expense) return;
      const existingPayment = expense.payments.find(payment => payment.requestId === requestId);
      if (existingPayment) {
        const reference = String(req.body.reference || '').trim().slice(0, 120);
        const notes = String(req.body.notes || '').trim().slice(0, 500);
        if (
          existingPayment.amountMinor !== amountMinor ||
          existingPayment.paymentMethod !== paymentMethod ||
          existingPayment.reference !== reference ||
          existingPayment.notes !== notes ||
          new Date(existingPayment.paidAt).getTime() !== paidAt.getTime()
        ) {
          throw Object.assign(new Error('This payment request ID was already used for a different payment.'), { status: 409 });
        }
        updated = expense;
        duplicate = true;
        return;
      }

      const outstandingMinor = expense.amountMinor - expense.paidAmountMinor;
      if (amountMinor > outstandingMinor) {
        throw Object.assign(new Error('Payment cannot exceed the outstanding amount.'), { status: 400 });
      }
      const before = expenseSnapshot(expense);
      expense.paidAmountMinor += amountMinor;
      expense.status = deriveExpenseStatus(expense.amountMinor, expense.paidAmountMinor);
      expense.paymentMethod = paymentMethod;
      expense.payments.push({
        amountMinor,
        paymentMethod,
        paidAt,
        reference: String(req.body.reference || '').trim().slice(0, 120),
        notes: String(req.body.notes || '').trim().slice(0, 500),
        recordedBy: req.owner._id,
        requestId
      });
      expense.updatedBy = req.owner._id;
      await expense.save({ session });
      await ExpenseAudit.create([{
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        expenseId: expense._id,
        action: 'PAYMENT_RECORDED',
        actorId: req.owner._id,
        before,
        after: expenseSnapshot(expense)
      }], { session });
      updated = expense;
    });
    if (!updated) return res.status(404).json({ success: false, message: 'Active expense not found' });
    await updated.populate('payments.recordedBy', 'name');
    const summary = await resolveSummary({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      query: req.query,
      selectedRange,
      timeZone,
      now: new Date()
    });
    return res.json({
      success: true,
      duplicate,
      expense: serializeExpense(updated),
      summary
    });
  } catch (error) {
    if (error.status === 400 || error.status === 409) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    console.error('Record expense payment error:', error);
    return res.status(500).json({ success: false, message: 'Unable to record expense payment' });
  } finally {
    if (session) await session.endSession();
  }
};

exports.getExpenseRetention = async (req, res) => {
  try {
    const business = await getBusiness(req);
    if (!business) return res.status(404).json({ success: false, message: 'Business not found' });
    return res.json({
      success: true,
      retentionMonths: business.expenseRetentionMonths || 12,
      automaticDeletion: false
    });
  } catch (error) {
    console.error('Get expense retention settings error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load retention settings' });
  }
};

exports.updateExpenseRetention = async (req, res) => {
  const retentionMonths = Number(req.body?.retentionMonths);
  if (!Number.isInteger(retentionMonths) || retentionMonths < 1 || retentionMonths > 120) {
    return res.status(400).json({ success: false, message: 'Retention period must be between 1 and 120 months.' });
  }
  try {
    const business = await Business.findOneAndUpdate(
      { _id: req.tenantId },
      { $set: { expenseRetentionMonths: retentionMonths } },
      { returnDocument: 'after', runValidators: true }
    ).select('expenseRetentionMonths').lean();
    if (!business) return res.status(404).json({ success: false, message: 'Business not found' });
    return res.json({
      success: true,
      retentionMonths: business.expenseRetentionMonths,
      automaticDeletion: false
    });
  } catch (error) {
    console.error('Update expense retention settings error:', error);
    return res.status(500).json({ success: false, message: 'Unable to save retention settings' });
  }
};

exports.createExpenseReceiptUpload = async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid expense ID' });
  if (!cloudinaryConfigured()) {
    return res.status(503).json({ success: false, message: 'Receipt storage is not configured.' });
  }
  const originalName = sanitizedFileName(req.body?.originalName);
  const extension = originalName.split('.').pop()?.toLowerCase();
  if (!originalName || !RECEIPT_FORMATS.has(extension)) {
    return res.status(400).json({ success: false, message: 'Upload a PDF, JPG, JPEG, or PNG receipt.' });
  }
  try {
    const expense = await Expense.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      archivedAt: null,
      deletedAt: null
    }).select('_id receipt').lean();
    if (!expense) return res.status(404).json({ success: false, message: 'Active expense not found' });
    if (expense.receipt?.publicId) {
      return res.status(409).json({ success: false, message: 'A receipt is already attached to this expense.' });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const publicId = `expense-receipts/${req.tenantId}/${expense._id}/${require('node:crypto').randomUUID()}`;
    const parameters = {
      allowed_formats: 'pdf,jpg,jpeg,png',
      public_id: publicId,
      timestamp,
      type: 'authenticated'
    };
    return res.json({
      success: true,
      uploadUrl: `https://api.cloudinary.com/v1_1/${config.cloudinary.cloudName}/auto/upload`,
      apiKey: config.cloudinary.apiKey,
      cloudName: config.cloudinary.cloudName,
      signature: cloudinary.utils.api_sign_request(parameters, config.cloudinary.apiSecret),
      parameters,
      maxBytes: MAX_RECEIPT_BYTES
    });
  } catch (error) {
    console.error('Create expense receipt upload signature error:', error);
    return res.status(500).json({ success: false, message: 'Unable to authorize receipt upload' });
  }
};

exports.attachExpenseReceipt = async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid expense ID' });
  if (!cloudinaryConfigured()) {
    return res.status(503).json({ success: false, message: 'Receipt storage is not configured.' });
  }
  const { publicId, format, resourceType } = req.body || {};
  const originalName = sanitizedFileName(req.body?.originalName);
  const allowedResourceTypes = new Set(['image', 'raw']);
  const publicIdPrefix = `expense-receipts/${req.tenantId}/${req.params.id}/`;
  if (
    typeof publicId !== 'string' ||
    !publicId.startsWith(publicIdPrefix) ||
    !RECEIPT_FORMATS.has(String(format || '').toLowerCase()) ||
    !allowedResourceTypes.has(resourceType) ||
    !originalName
  ) {
    return res.status(400).json({ success: false, message: 'Invalid uploaded receipt details.' });
  }

  const session = await mongoose.startSession();
  try {
    let attached;
    await session.withTransaction(async () => {
      const expense = await Expense.findOne({
        _id: req.params.id,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        archivedAt: null,
        deletedAt: null
      }).session(session);
      if (!expense) return;
      if (expense.receipt?.publicId) {
        throw Object.assign(new Error('A receipt is already attached to this expense.'), { status: 409 });
      }

      const verifiedAsset = await cloudinary.api.resource(publicId, undefined, {
        resource_type: resourceType,
        type: 'authenticated'
      });
      if (
        verifiedAsset.public_id !== publicId ||
        verifiedAsset.bytes > MAX_RECEIPT_BYTES ||
        !RECEIPT_FORMATS.has(String(verifiedAsset.format || '').toLowerCase())
      ) {
        throw Object.assign(new Error('The uploaded file is not an allowed receipt.'), { status: 400 });
      }

      const before = expenseSnapshot(expense);
      expense.receipt = {
        publicId,
        format: verifiedAsset.format,
        resourceType,
        originalName,
        uploadedAt: new Date(),
        uploadedBy: req.owner._id
      };
      expense.updatedBy = req.owner._id;
      await expense.save({ session });
      await ExpenseAudit.create([{
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        expenseId: expense._id,
        action: 'UPDATED',
        actorId: req.owner._id,
        before,
        after: expenseSnapshot(expense)
      }], { session });
      attached = expense;
    });
    if (!attached) return res.status(404).json({ success: false, message: 'Active expense not found' });
    return res.json({ success: true, expense: serializeExpense(attached) });
  } catch (error) {
    if (error.status === 400 || error.status === 409) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    if (error.http_code === 404 || error.statusCode === 404) {
      return res.status(400).json({ success: false, message: 'Uploaded receipt could not be verified.' });
    }
    console.error('Attach expense receipt error:', error);
    return res.status(500).json({ success: false, message: 'Unable to attach receipt' });
  } finally {
    await session.endSession();
  }
};

exports.getExpenseReceipt = async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid expense ID' });
  if (!cloudinaryConfigured()) {
    return res.status(503).json({ success: false, message: 'Receipt storage is not configured.' });
  }
  try {
    const expense = await Expense.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      'receipt.publicId': { $ne: '' }
    }).select('receipt').lean();
    if (!expense?.receipt?.publicId) {
      return res.status(404).json({ success: false, message: 'Expense receipt not found' });
    }
    const url = cloudinary.utils.private_download_url(
      expense.receipt.publicId,
      expense.receipt.format,
      {
        attachment: true,
        expires_at: Math.floor(Date.now() / 1000) + 300,
        resource_type: expense.receipt.resourceType || 'image',
        type: 'authenticated'
      }
    );
    return res.json({ success: true, url, expiresInSeconds: 300 });
  } catch (error) {
    console.error('Get expense receipt error:', error);
    return res.status(500).json({ success: false, message: 'Unable to create secure receipt link' });
  }
};

exports.listExpenseCategories = async (req, res) => {
  try {
    const custom = await ExpenseCategory.find({ tenantId: req.tenantId })
      .select('name isActive')
      .sort({ name: 1 })
      .lean();
    return res.json({
      success: true,
      categories: [
        ...DEFAULT_EXPENSE_CATEGORIES.map(name => ({ name, isActive: true, isDefault: true })),
        ...custom.map(category => ({
          _id: category._id,
          name: category.name,
          isActive: category.isActive,
          isDefault: false
        }))
      ]
    });
  } catch (error) {
    console.error('List expense categories error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load expense categories' });
  }
};

exports.createExpenseCategory = async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const normalized = normalizedName(name);
    if (!name || name.length > 80) {
      return res.status(400).json({ success: false, message: 'Category name is required and must be at most 80 characters' });
    }
    if (DEFAULT_EXPENSE_CATEGORIES.some(item => normalizedName(item) === normalized)) {
      return res.status(409).json({ success: false, message: 'This category already exists as a default category' });
    }
    const category = await ExpenseCategory.create({
      tenantId: req.tenantId,
      name,
      normalizedName: normalized,
      createdBy: req.owner._id,
      updatedBy: req.owner._id
    });
    return res.status(201).json({ success: true, category });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'This category already exists' });
    }
    console.error('Create expense category error:', error);
    return res.status(500).json({ success: false, message: 'Unable to create expense category' });
  }
};

exports.updateExpenseCategory = async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid expense category ID' });
  try {
    const category = await ExpenseCategory.findOne({
      _id: req.params.id,
      tenantId: req.tenantId
    });
    if (!category) return res.status(404).json({ success: false, message: 'Expense category not found' });
    if (req.body.name !== undefined) {
      const name = String(req.body.name || '').trim();
      const normalized = normalizedName(name);
      if (!name || name.length > 80) {
        return res.status(400).json({ success: false, message: 'Category name is required and must be at most 80 characters' });
      }
      if (DEFAULT_EXPENSE_CATEGORIES.some(item => normalizedName(item) === normalized)) {
        return res.status(409).json({ success: false, message: 'This category already exists as a default category' });
      }
      category.name = name;
      category.normalizedName = normalized;
    }
    if (req.body.isActive !== undefined) {
      if (typeof req.body.isActive !== 'boolean') {
        return res.status(400).json({ success: false, message: 'Category active state must be true or false' });
      }
      category.isActive = req.body.isActive;
    }
    category.updatedBy = req.owner._id;
    await category.save();
    return res.json({ success: true, category });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'This category already exists' });
    }
    console.error('Update expense category error:', error);
    return res.status(500).json({ success: false, message: 'Unable to update expense category' });
  }
};

const csvCell = value => {
  const text = String(value ?? '');
  const safe = /^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};

exports.exportExpenses = async (req, res) => {
  try {
    const business = await getBusiness(req);
    if (!business) return res.status(404).json({ success: false, message: 'Business not found' });
    const timeZone = getBusinessTimeZone(business);
    const range = resolveRange(req.query, timeZone);
    if (
      (req.query.period && req.query.period !== 'all' || req.query.from || req.query.to) &&
      !range
    ) {
      return res.status(400).json({ success: false, message: 'Select a valid expense date range' });
    }
    const filter = buildExpenseFilter({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      query: { ...req.query, archived: req.query.archived === 'true' ? 'true' : 'all' },
      range
    });
    const { sort } = getListParameters(req.query);
    const format = String(req.query.format || '').toLowerCase();
    const fileDate = new Date().toISOString().slice(0, 10);
    const dateOnly = value => new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(value);
    const headers = [
      'Expense ID', 'Date', 'Title', 'Category', 'Vendor', 'Invoice Number',
      'Total Amount (INR)', 'Paid Amount (INR)', 'Outstanding (INR)',
      'Status', 'Payment Method', 'Transaction Reference', 'Description'
    ];
    const values = expense => [
      String(expense._id),
      dateOnly(expense.expenseDate),
      expense.title,
      expense.category,
      expense.vendor,
      expense.invoiceNumber,
      expense.amountMinor / 100,
      expense.paidAmountMinor / 100,
      (expense.amountMinor - expense.paidAmountMinor) / 100,
      expense.status,
      expense.paymentMethod || '',
      expense.transactionReference,
      expense.description
    ];

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ssfm-expenses-${fileDate}.csv"`);
      res.write(`${headers.map(csvCell).join(',')}\r\n`);
      const cursor = Expense.find(filter).sort(sort).lean().cursor();
      for await (const expense of cursor) {
        res.write(`${values(expense).map(csvCell).join(',')}\r\n`);
      }
      return res.end();
    }

    if (format !== 'xlsx') {
      return res.status(400).json({ success: false, message: 'Choose CSV or XLSX export format' });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ssfm-expenses-${fileDate}.xlsx"`);
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true
    });
    const summarySheet = workbook.addWorksheet('Summary');
    summarySheet.addRow(['Expense Report', business.businessName || 'SS Fitness Manager']).commit();
    summarySheet.addRow(['Date range', range ? `${range.fromDate} to ${range.toDate}` : 'All dates']).commit();
    summarySheet.addRow(['Generated at', new Date()]).commit();
    const sheet = workbook.addWorksheet('Expenses');
    sheet.columns = headers.map((header, index) => ({
      header,
      key: `column${index}`,
      width: index === 12 ? 36 : 20
    }));
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB51F2B' } };
    let totalMinor = 0;
    let paidMinor = 0;
    const categoryTotals = new Map();
    const cursor = Expense.find(filter).sort(sort).lean().cursor();
    for await (const expense of cursor) {
      const rowValues = values(expense);
      rowValues[1] = new Date(`${rowValues[1]}T00:00:00.000Z`);
      const row = sheet.addRow(rowValues);
      row.getCell(2).numFmt = 'dd mmm yyyy';
      for (const column of [7, 8, 9]) row.getCell(column).numFmt = '₹#,##0.00';
      row.commit();
      totalMinor += expense.amountMinor;
      paidMinor += expense.paidAmountMinor;
      const previous = categoryTotals.get(expense.category) || { totalMinor: 0, paidMinor: 0 };
      previous.totalMinor += expense.amountMinor;
      previous.paidMinor += expense.paidAmountMinor;
      categoryTotals.set(expense.category, previous);
    }
    summarySheet.addRow(['Total expenses (INR)', totalMinor / 100]).commit();
    summarySheet.addRow(['Paid amount (INR)', paidMinor / 100]).commit();
    summarySheet.addRow(['Outstanding amount (INR)', (totalMinor - paidMinor) / 100]).commit();
    summarySheet.addRow([]).commit();
    summarySheet.addRow(['Category', 'Total (INR)', 'Paid (INR)', 'Outstanding (INR)']).commit();
    for (const [category, totals] of categoryTotals) {
      summarySheet.addRow([
        category,
        totals.totalMinor / 100,
        totals.paidMinor / 100,
        (totals.totalMinor - totals.paidMinor) / 100
      ]).commit();
    }
    summarySheet.columns = [{ width: 32 }, { width: 24 }, { width: 24 }, { width: 24 }];
    sheet.commit();
    summarySheet.commit();
    await workbook.commit();
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    console.error('Export expenses error:', error);
    return res.status(500).json({ success: false, message: 'Unable to export expenses' });
  }
};

exports.getExpenseReport = async (req, res) => {
  try {
    const business = await getBusiness(req);
    if (!business) return res.status(404).json({ success: false, message: 'Business not found' });
    const timeZone = getBusinessTimeZone(business);
    const range = resolveRange(req.query, timeZone);
    const allDates = req.query.period === 'all' && !req.query.from && !req.query.to;
    if (!range && !allDates) {
      return res.status(400).json({ success: false, message: 'Select a valid report period' });
    }
    const filter = buildExpenseFilter({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      query: { ...req.query, archived: req.query.archived === 'true' ? 'true' : 'all' },
      range
    });
    const [summary, categories, vendors, statuses] = await Promise.all([
      Expense.aggregate([
        { $match: filter },
        { $group: {
          _id: null,
          totalMinor: { $sum: '$amountMinor' },
          paidMinor: { $sum: '$paidAmountMinor' }
        } }
      ]),
      Expense.aggregate([
        { $match: filter },
        { $group: {
          _id: '$category',
          totalMinor: { $sum: '$amountMinor' },
          paidMinor: { $sum: '$paidAmountMinor' },
          count: { $sum: 1 }
        } },
        { $sort: { totalMinor: -1, _id: 1 } }
      ]),
      Expense.aggregate([
        { $match: filter },
        { $group: {
          _id: { $cond: [{ $eq: ['$vendor', ''] }, 'Unspecified', '$vendor'] },
          totalMinor: { $sum: '$amountMinor' },
          paidMinor: { $sum: '$paidAmountMinor' },
          count: { $sum: 1 }
        } },
        { $sort: { totalMinor: -1, _id: 1 } },
        { $limit: 100 }
      ]),
      Expense.aggregate([
        { $match: filter },
        { $group: { _id: '$status', count: { $sum: 1 }, totalMinor: { $sum: '$amountMinor' }, paidMinor: { $sum: '$paidAmountMinor' } } },
        { $sort: { _id: 1 } }
      ])
    ]);
    const totals = summary[0] || { totalMinor: 0, paidMinor: 0 };
    return res.json({
      success: true,
      businessName: business.businessName,
      logoUrl: business.logoUrl || '',
      range: {
        from: range?.fromDate || 'All dates',
        to: range?.toDate || new Intl.DateTimeFormat('en-CA', {
          timeZone
        }).format(new Date()),
        timeZone: range?.timeZone || timeZone
      },
      summary: {
        totalExpenses: totals.totalMinor / 100,
        paidAmount: totals.paidMinor / 100,
        outstandingAmount: (totals.totalMinor - totals.paidMinor) / 100
      },
      categories: categories.map(row => ({
        name: row._id,
        total: row.totalMinor / 100,
        paid: row.paidMinor / 100,
        outstanding: (row.totalMinor - row.paidMinor) / 100,
        count: row.count
      })),
      vendors: vendors.map(row => ({
        name: row._id,
        total: row.totalMinor / 100,
        paid: row.paidMinor / 100,
        count: row.count
      })),
      statuses: statuses.map(row => ({
        status: row._id,
        count: row.count,
        total: row.totalMinor / 100,
        paid: row.paidMinor / 100,
        outstanding: (row.totalMinor - row.paidMinor) / 100
      }))
    });
  } catch (error) {
    console.error('Expense report error:', error);
    return res.status(500).json({ success: false, message: 'Unable to generate expense report' });
  }
};

exports.validateCreateExpense = parseCreateData;
exports.buildExpenseFilter = buildExpenseFilter;
exports.csvCell = csvCell;
