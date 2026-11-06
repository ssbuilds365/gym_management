const mongoose = require('mongoose');
const ExcelJS = require('exceljs');
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

const VALID_STATUSES = ['PAID', 'PENDING', 'PARTIALLY_PAID'];
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

const getBusiness = req => Business.findById(req.tenantId)
  .select('timeZone businessName logoUrl')
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
  const filter = { tenantId, businessId, deletedAt: null };
  if (range) filter.expenseDate = { $gte: range.from, $lt: range.toExclusive };

  if (query.category) filter.category = String(query.category).trim().slice(0, 80);
  if (query.status && VALID_STATUSES.includes(String(query.status))) {
    filter.status = String(query.status);
  }
  const search = String(query.search || '').trim().slice(0, 100);
  if (search) {
    const expression = new RegExp(escapeRegex(search), 'i');
    filter.$or = [
      { title: expression },
      { category: expression },
      { vendor: expression },
      { invoiceNumber: expression },
      { transactionReference: expression }
    ];
  }
  return filter;
};

const parseCreateData = (body, timeZone, actorId) => {
  const title = String(body.title || '').trim();
  const category = String(body.category || '').trim();
  const amountMinor = toMinorUnits(body.amount);
  const expenseDate = parseExpenseDate(body.expenseDate, timeZone);
  if (!title || title.length > 120) return { error: 'Expense title is required and must be at most 120 characters' };
  if (!category || category.length > 80) return { error: 'Select a valid expense category' };
  if (amountMinor === null) return { error: 'Enter an amount greater than zero with no more than two decimal places' };
  if (!expenseDate) return { error: 'Enter a valid expense date' };

  const status = String(body.status || 'PENDING');
  if (!VALID_STATUSES.includes(status)) return { error: 'Select a valid payment status' };
  const paidAmountMinor = status === 'PAID'
    ? amountMinor
    : status === 'PENDING'
      ? 0
      : toMinorUnits(body.paidAmount);
  if (paidAmountMinor === null || paidAmountMinor < 0 || paidAmountMinor > amountMinor) {
    return { error: 'Paid amount must be greater than zero and cannot exceed the expense amount' };
  }
  if (deriveExpenseStatus(amountMinor, paidAmountMinor) !== status) {
    return { error: 'Paid amount does not match the selected payment status' };
  }
  const paymentMethod = String(body.paymentMethod || '');
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    return { error: 'Select a valid payment method' };
  }

  return {
    data: {
      title,
      category,
      amountMinor,
      paidAmountMinor,
      status,
      paymentMethod,
      expenseDate,
      vendor: String(body.vendor || '').trim().slice(0, 120),
      invoiceNumber: String(body.invoiceNumber || '').trim().slice(0, 80),
      transactionReference: String(body.transactionReference || '').trim().slice(0, 120),
      description: String(body.description || '').trim().slice(0, 2000),
      payments: paidAmountMinor > 0
        ? [{
            amountMinor: paidAmountMinor,
            paymentMethod,
            paidAt: new Date(),
            reference: String(body.transactionReference || '').trim().slice(0, 120),
            notes: '',
            recordedBy: actorId
          }]
        : []
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
    tenantId, businessId, query, range: selectedRange
  });
  const monthRange = resolveReportPeriod({ period: 'month', timezone: timeZone }, now);
  const todayRange = resolveReportPeriod({ period: 'today', timezone: timeZone }, now);
  const base = { tenantId, businessId, deletedAt: null };
  const group = {
    _id: null,
    totalMinor: { $sum: '$amountMinor' },
    paidMinor: { $sum: '$paidAmountMinor' }
  };
  const summarize = filter => Expense.aggregate([
    { $match: filter },
    { $group: group }
  ]);
  const [selected, month, today, categories] = await Promise.all([
    summarize(selectedFilter),
    summarize({ ...base, expenseDate: { $gte: monthRange.from, $lt: monthRange.toExclusive } }),
    summarize({ ...base, expenseDate: { $gte: todayRange.from, $lt: todayRange.toExclusive } }),
    Expense.aggregate([
      { $match: selectedFilter },
      { $group: { _id: '$category', totalMinor: { $sum: '$amountMinor' } } },
      { $sort: { totalMinor: -1, _id: 1 } },
      { $limit: 1 }
    ])
  ]);
  const selectedTotals = selected[0] || { totalMinor: 0, paidMinor: 0 };
  const monthTotals = month[0] || { totalMinor: 0 };
  const todayTotals = today[0] || { totalMinor: 0 };
  return {
    totalExpenses: selectedTotals.totalMinor / 100,
    paidExpenses: selectedTotals.paidMinor / 100,
    pendingExpenses: Math.max(0, selectedTotals.totalMinor - selectedTotals.paidMinor) / 100,
    thisMonthExpenses: monthTotals.totalMinor / 100,
    todayExpenses: todayTotals.totalMinor / 100,
    highestExpenseCategory: categories[0]
      ? { name: categories[0]._id, amount: categories[0].totalMinor / 100 }
      : null
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
      businessId: req.owner.businessId,
      deletedAt: null
    }).lean();
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
    const { data, error } = parseCreateData(req.body, getBusinessTimeZone(business), req.owner._id);
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
      deletedAt: null
    };
    let updated;
    let action = 'UPDATED';
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
      for (const [field, maxLength] of [
        ['vendor', 120],
        ['invoiceNumber', 80],
        ['transactionReference', 120],
        ['description', 2000]
      ]) {
        if (body[field] !== undefined) expense[field] = String(body[field] || '').trim().slice(0, maxLength);
      }
      if (body.paymentAmount !== undefined && Number(body.paymentAmount) !== 0) {
        const paymentAmountMinor = toMinorUnits(body.paymentAmount);
        const paymentMethod = String(body.paymentMethod || '');
        if (
          paymentAmountMinor === null ||
          paymentAmountMinor > expense.amountMinor - expense.paidAmountMinor
        ) {
          throw Object.assign(new Error('Additional payment must be positive and cannot exceed the outstanding amount'), { status: 400 });
        }
        if (!PAYMENT_METHODS.includes(paymentMethod)) {
          throw Object.assign(new Error('Select a valid payment method'), { status: 400 });
        }
        expense.paidAmountMinor += paymentAmountMinor;
        expense.paymentMethod = paymentMethod;
        expense.payments.push({
          amountMinor: paymentAmountMinor,
          paymentMethod,
          paidAt: new Date(),
          reference: String(body.paymentReference || '').trim().slice(0, 120),
          notes: String(body.paymentNotes || '').trim().slice(0, 500),
          recordedBy: req.owner._id
        });
        action = 'PAYMENT_RECORDED';
      } else if (body.paymentMethod !== undefined) {
        const paymentMethod = String(body.paymentMethod || '');
        if (!PAYMENT_METHODS.includes(paymentMethod)) {
          throw Object.assign(new Error('Select a valid payment method'), { status: 400 });
        }
        expense.paymentMethod = paymentMethod;
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

exports.deleteExpense = async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid expense ID' });
  const session = await mongoose.startSession();
  try {
    let deleted;
    await session.withTransaction(async () => {
      const expense = await Expense.findOne({
        _id: req.params.id,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        deletedAt: null
      }).session(session);
      if (!expense) return;
      const before = expenseSnapshot(expense);
      expense.deletedAt = new Date();
      expense.deletedBy = req.owner._id;
      expense.updatedBy = req.owner._id;
      await expense.save({ session });
      await ExpenseAudit.create([{
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        expenseId: expense._id,
        action: 'DELETED',
        actorId: req.owner._id,
        before,
        after: null
      }], { session });
      deleted = true;
    });
    if (!deleted) return res.status(404).json({ success: false, message: 'Expense not found' });
    return res.json({ success: true, message: 'Expense archived and removed from active totals' });
  } catch (error) {
    console.error('Delete expense error:', error);
    return res.status(500).json({ success: false, message: 'Unable to delete expense' });
  } finally {
    await session.endSession();
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
      query: req.query,
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
      query: req.query,
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
