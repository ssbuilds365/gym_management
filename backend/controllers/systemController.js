const mongoose = require('mongoose');

const Attendance = require('../models/Attendance');
const BiometricEnrollment = require('../models/BiometricEnrollment');
const Business = require('../models/Business');
const DatabaseManagementAudit = require('../models/DatabaseManagementAudit');
const Expense = require('../models/Expense');
const ExpenseAudit = require('../models/ExpenseAudit');
const ExpenseCategory = require('../models/ExpenseCategory');
const Member = require('../models/Member');
const MemberDeletionAudit = require('../models/MemberDeletionAudit');
const MemberMembership = require('../models/MemberMembership');
const MembershipPlan = require('../models/MembershipPlan');
const Payment = require('../models/Payment');
const TrainerStaff = require('../models/TrainerStaff');
const config = require('../config/env');
const { getAtlasStorage } = require('../services/atlasStorage');
const { localDateTimeToUtc } = require('../utils/dashboardPeriods');
const { isValidTimeZone } = require('../utils/reportPeriods');
const { deleteMember } = require('./memberController');
const { deleteTrainerStaff } = require('./trainerStaffController');
const { deleteExpense } = require('./expenseController');

const CACHE_TTL_MS = 30_000;
const QUERY_TIMEOUT_MS = 5_000;
const tenantSnapshotCache = new Map();
const tenantSnapshotRequests = new Map();
let lastSuccessfulConnectionCheck = null;

const collectionDefinitions = [
  {
    model: Member,
    managementMenu: 'Members',
    managementCategory: 'members',
    protected: false,
    protectionReason: ''
  },
  {
    model: MembershipPlan,
    managementMenu: 'Membership Plans',
    managementCategory: null,
    protected: true,
    protectionReason: 'Membership history can reference plans; deletion is not available in Database Storage.'
  },
  {
    model: MemberMembership,
    managementMenu: 'Members',
    managementCategory: null,
    protected: true,
    protectionReason: 'Membership and payment history is managed through member workflows.'
  },
  {
    model: Attendance,
    managementMenu: 'Attendance',
    managementCategory: null,
    protected: true,
    protectionReason: 'Attendance history cannot be deleted from Database Storage.'
  },
  {
    model: Payment,
    managementMenu: 'Payments & Fees',
    managementCategory: null,
    protected: true,
    protectionReason: 'Financial records are protected; use supported payment or refund workflows.'
  },
  {
    model: Expense,
    managementMenu: 'Expense Tracker',
    managementCategory: 'expenses',
    protected: false,
    protectionReason: ''
  },
  {
    model: ExpenseCategory,
    managementMenu: 'Expense Tracker',
    managementCategory: null,
    protected: false,
    protectionReason: ''
  },
  {
    model: TrainerStaff,
    managementMenu: 'Trainers & Staff',
    managementCategory: 'trainersStaff',
    protected: false,
    protectionReason: ''
  },
  {
    model: BiometricEnrollment,
    managementMenu: null,
    managementCategory: null,
    protected: true,
    protectionReason: 'Biometric records are sensitive and are not manageable from this page.'
  },
  {
    model: ExpenseAudit,
    managementMenu: null,
    managementCategory: null,
    protected: true,
    protectionReason: 'Financial audit history is retained and cannot be deleted here.'
  },
  {
    model: MemberDeletionAudit,
    managementMenu: null,
    managementCategory: null,
    protected: true,
    protectionReason: 'Deletion audit history is retained and cannot be deleted here.'
  },
  {
    model: DatabaseManagementAudit,
    managementMenu: null,
    managementCategory: null,
    protected: true,
    protectionReason: 'Database management audit history is retained and cannot be deleted here.'
  }
];

const manageableCategories = Object.freeze({
  members: {
    model: Member,
    dateField: 'joiningDate',
    deleteHandler: deleteMember,
    projection: '_id fullName status joiningDate createdAt'
  },
  trainersStaff: {
    model: TrainerStaff,
    dateField: 'joiningDate',
    deleteHandler: deleteTrainerStaff,
    projection: '_id name role status joiningDate createdAt'
  },
  expenses: {
    model: Expense,
    dateField: 'expenseDate',
    deleteHandler: deleteExpense,
    projection: '_id title category amountMinor paidAmountMinor status expenseDate createdAt'
  }
});

const getTenantCollectionDefinitions = () => collectionDefinitions.filter(
  ({ model }) => Boolean(model.schema.path('tenantId'))
);

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseDateRange = (from, to, timeZone = 'UTC') => {
  if (!from && !to) return { range: null };
  if (typeof from !== 'string' || typeof to !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(from)
      || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { error: 'Provide a valid start and end date.' };
  }

  const startDate = new Date(`${from}T00:00:00.000Z`);
  const endDate = new Date(`${to}T00:00:00.000Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())
      || startDate.toISOString().slice(0, 10) !== from
      || endDate.toISOString().slice(0, 10) !== to
      || startDate > endDate
      || endDate.getTime() - startDate.getTime() > 5 * 366 * 24 * 60 * 60 * 1000
      || !isValidTimeZone(timeZone)) {
    return { error: 'Choose a valid date range no longer than five years.' };
  }
  const toExclusiveDate = new Date(endDate);
  toExclusiveDate.setUTCDate(toExclusiveDate.getUTCDate() + 1);
  const toParts = {
    year: toExclusiveDate.getUTCFullYear(),
    month: toExclusiveDate.getUTCMonth() + 1,
    day: toExclusiveDate.getUTCDate()
  };
  return {
    range: {
      $gte: localDateTimeToUtc({
        year: startDate.getUTCFullYear(),
        month: startDate.getUTCMonth() + 1,
        day: startDate.getUTCDate()
      }, timeZone),
      $lt: localDateTimeToUtc(toParts, timeZone)
    }
  };
};

const getBusinessTimeZone = async (tenantId, businessId) => {
  const business = await Business.findOne({ _id: businessId, tenantId })
    .select('timeZone')
    .lean()
    .maxTimeMS(QUERY_TIMEOUT_MS)
    .exec();
  const timeZone = business?.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Asia/Kolkata';
  if (!isValidTimeZone(timeZone)) {
    throw new Error('Configured business time zone is invalid.');
  }
  return timeZone;
};

const buildManagementFilter = (category, tenantId, businessId, input, timeZone = 'UTC') => {
  const definition = manageableCategories[category];
  if (!definition) return { error: 'This data category is not available for management.' };

  const filter = { tenantId };
  if (category !== 'trainersStaff') filter.businessId = businessId;
  if (category === 'members') filter.deletedAt = null;
  if (category === 'expenses') filter.deletedAt = null;

  const dateResult = parseDateRange(input.from, input.to, timeZone);
  if (dateResult.error) return dateResult;
  if (dateResult.range) filter[definition.dateField] = dateResult.range;

  const status = String(input.status || '').trim();
  const validStatuses = category === 'members'
    ? ['Active', 'Inactive', 'On Hold']
    : category === 'trainersStaff'
      ? ['Active', 'Inactive']
      : ['PAID', 'PENDING', 'PARTIALLY_PAID'];
  if (status) {
    if (!validStatuses.includes(status)) return { error: 'Invalid status filter.' };
    filter.status = status;
  }

  const search = String(input.search || '').trim().slice(0, 80);
  if (search) {
    const expression = new RegExp(escapeRegex(search), 'i');
    const fields = category === 'members'
      ? ['fullName', 'phone']
      : category === 'trainersStaff'
        ? ['name', 'role', 'specialization', 'designation']
        : ['title', 'category', 'vendor', 'invoiceNumber'];
    filter.$or = fields.map(field => ({ [field]: expression }));
  }

  if (Array.isArray(input.ids) && input.ids.length > 0) {
    if (input.ids.length > 20 || input.ids.some(id => !mongoose.Types.ObjectId.isValid(id))) {
      return { error: 'Select between 1 and 20 valid records.' };
    }
    filter._id = { $in: input.ids.map(id => new mongoose.Types.ObjectId(id)) };
  }

  return { filter, definition, status, dateRange: dateResult.range, search };
};

const matchingRecords = async (category, tenantId, businessId, input = {}, timeZone = 'UTC') => {
  const result = buildManagementFilter(category, tenantId, businessId, input, timeZone);
  if (result.error) return result;
  const { filter, definition } = result;
  const [total, records] = await Promise.all([
    definition.model.countDocuments(filter).maxTimeMS(QUERY_TIMEOUT_MS).exec(),
    definition.model.find(filter)
      .select(definition.projection)
      .sort({ [definition.dateField]: -1, _id: -1 })
      .limit(input.limit || 20)
      .skip(input.skip || 0)
      .maxTimeMS(QUERY_TIMEOUT_MS)
      .lean()
      .exec()
  ]);
  return { ...result, total, records };
};

const getManagementRecords = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const category = String(req.query.category || '');
  const page = Number.parseInt(req.query.page, 10) || 1;
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  if (page < 1 || page > 100_000) {
    return res.status(400).json({ success: false, message: 'Invalid page number.' });
  }

  try {
    const timeZone = req.query.from || req.query.to
      ? await getBusinessTimeZone(req.tenantId, req.owner.businessId)
      : 'UTC';
    const result = await matchingRecords(category, req.tenantId, req.owner.businessId, {
      from: req.query.from,
      to: req.query.to,
      status: req.query.status,
      search: req.query.search,
      limit,
      skip: (page - 1) * limit
    }, timeZone);
    if (result.error) {
      return res.status(400).json({ success: false, message: result.error });
    }
    return res.json({
      success: true,
      category,
      page,
      limit,
      total: result.total,
      records: result.records
    });
  } catch (error) {
    return sendDatabaseUnavailable(
      res,
      error,
      'Tenant data management records query',
      'Tenant records are temporarily unavailable.'
    );
  }
};

const getDeletePreview = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const category = String(req.body?.category || '');
  const ids = req.body?.ids;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length === 0 || ids.length > 20)) {
    return res.status(400).json({ success: false, message: 'Select between 1 and 20 records.' });
  }
  if ((!ids || ids.length === 0)
      && !req.body?.from && !req.body?.to && !req.body?.status && !req.body?.search) {
    return res.status(400).json({
      success: false,
      message: 'Use a date, status, or search filter before previewing a bulk operation.'
    });
  }

  try {
    const timeZone = req.body?.from || req.body?.to
      ? await getBusinessTimeZone(req.tenantId, req.owner.businessId)
      : 'UTC';
    const result = await matchingRecords(category, req.tenantId, req.owner.businessId, {
      ...req.body,
      ids,
      limit: 20,
      skip: 0
    }, timeZone);
    if (result.error) {
      return res.status(400).json({ success: false, message: result.error });
    }

    const recordIds = result.records.map(record => record._id);
    let impact = {};
    if (category === 'members' && recordIds.length) {
      const [payments, memberships, attendance, biometrics] = await Promise.all([
        Payment.countDocuments({ tenantId: req.tenantId, memberId: { $in: recordIds } }),
        MemberMembership.countDocuments({ tenantId: req.tenantId, memberId: { $in: recordIds } }),
        Attendance.countDocuments({ tenantId: req.tenantId, memberId: { $in: recordIds } }),
        BiometricEnrollment.countDocuments({ tenantId: req.tenantId, memberId: { $in: recordIds } })
      ]);
      impact = {
        retainedPayments: payments,
        retainedMemberships: memberships,
        removedAttendance: attendance,
        removedBiometricEnrollments: biometrics
      };
    } else if (category === 'trainersStaff' && recordIds.length) {
      impact = {
        assignedMembers: await Member.countDocuments({
          tenantId: req.tenantId,
          deletedAt: null,
          assignedTrainerId: { $in: recordIds }
        })
      };
    } else if (category === 'expenses' && recordIds.length) {
      impact = {
        retainedFinancialAuditEntries: await ExpenseAudit.countDocuments({
          tenantId: req.tenantId,
          expenseId: { $in: recordIds }
        }),
        deletionType: 'soft_delete'
      };
    }

    return res.json({
      success: true,
      category,
      matchingCount: result.total,
      selectedCount: result.records.length,
      filters: {
        from: req.body.from || null,
        to: req.body.to || null,
        status: result.status || null,
        search: result.search || null,
        ids: ids || null
      },
      records: result.records,
      impact
    });
  } catch (error) {
    return sendDatabaseUnavailable(
      res,
      error,
      'Tenant data management preview',
      'Unable to calculate the deletion preview.'
    );
  }
};

const captureControllerResponse = async (handler, req) => {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  await handler(req, response);
  return response;
};

const deleteSelectedRecords = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const category = String(req.body?.category || '');
  const ids = req.body?.ids;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  const requestId = typeof req.body?.requestId === 'string' ? req.body.requestId : '';
  const expectedCount = Number(req.body?.expectedCount);

  if (!manageableCategories[category]) {
    return res.status(400).json({ success: false, message: 'This data category cannot be deleted here.' });
  }
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20
      || ids.some(id => !mongoose.Types.ObjectId.isValid(id))
      || new Set(ids.map(String)).size !== ids.length) {
    return res.status(400).json({ success: false, message: 'Select between 1 and 20 unique records.' });
  }
  if (req.body?.confirmationText !== 'DELETE') {
    return res.status(400).json({ success: false, message: 'Type DELETE to confirm this operation.' });
  }
  if (reason.length < 8 || reason.length > 500) {
    return res.status(400).json({ success: false, message: 'Provide a reason between 8 and 500 characters.' });
  }
  if (!/^[\w-]{16,80}$/.test(requestId)) {
    return res.status(400).json({ success: false, message: 'A valid idempotency request ID is required.' });
  }
  if (!Number.isInteger(expectedCount) || expectedCount !== ids.length) {
    return res.status(400).json({ success: false, message: 'The preview count does not match the selected records.' });
  }

  let audit = null;
  let deletedCount = 0;
  let failedRecordId = null;
  let failureMessage = '';
  try {
    await DatabaseManagementAudit.init();
    const existing = await DatabaseManagementAudit.findOne({
      tenantId: req.tenantId,
      requestId
    }).lean();
    if (existing) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_REQUEST',
        message: 'This delete request was already processed.',
        deletedCount: existing.affectedRecordCount,
        status: existing.status
      });
    }

    const timeZone = req.body.from || req.body.to
      ? await getBusinessTimeZone(req.tenantId, req.owner.businessId)
      : 'UTC';
    const verification = await matchingRecords(category, req.tenantId, req.owner.businessId, {
      ...req.body,
      ids,
      limit: 20,
      skip: 0
    }, timeZone);
    if (verification.error) {
      return res.status(400).json({ success: false, message: verification.error });
    }
    const matchedIds = new Set(verification.records.map(record => String(record._id)));
    if (verification.total !== expectedCount || ids.some(id => !matchedIds.has(String(id)))) {
      return res.status(409).json({
        success: false,
        code: 'PREVIEW_STALE',
        message: 'The selected records changed after preview. Refresh and review the preview again.'
      });
    }

    audit = await DatabaseManagementAudit.create({
      tenantId: req.tenantId,
      actorId: req.owner._id,
      actorRole: req.owner.role,
      category,
      operation: 'DELETE_SELECTED',
      affectedRecordCount: 0,
      filters: {
        ids,
        from: req.body.from || null,
        to: req.body.to || null,
        status: req.body.status || null,
        search: req.body.search || null
      },
      reason,
      status: 'PENDING',
      requestId
    });

    const handler = manageableCategories[category].deleteHandler;
    for (const id of ids) {
      const recordRequest = Object.create(req);
      recordRequest.params = { ...req.params, id };
      recordRequest.body = {};
      recordRequest.query = {};
      const result = await captureControllerResponse(handler, recordRequest);
      if (result.statusCode >= 400 || result.body?.success !== true) {
        failedRecordId = id;
        failureMessage = result.body?.message || 'The business workflow rejected this deletion.';
        break;
      }
      deletedCount += 1;
    }

    const status = deletedCount === ids.length
      ? 'SUCCEEDED'
      : deletedCount > 0
        ? 'PARTIAL'
        : 'FAILED';
    audit.affectedRecordCount = deletedCount;
    audit.status = status;
    await audit.save();

    tenantSnapshotCache.delete(String(req.tenantId));
    return res.status(status === 'SUCCEEDED' ? 200 : status === 'PARTIAL' ? 207 : 409).json({
      success: status === 'SUCCEEDED',
      status,
      deletedCount,
      failedRecordId,
      message: status === 'SUCCEEDED'
        ? `${deletedCount} record${deletedCount === 1 ? '' : 's'} processed.`
        : failureMessage || 'No records were deleted.'
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_REQUEST',
        message: 'This delete request was already submitted.'
      });
    }
    let status = deletedCount === ids.length && deletedCount > 0
      ? 'SUCCEEDED'
      : deletedCount > 0
        ? 'PARTIAL'
        : 'FAILED';
    if (audit) {
      audit.affectedRecordCount = deletedCount;
      audit.status = status;
      try {
        await audit.save();
      } catch (auditError) {
        console.error('Database management audit finalization failed:', auditError.name || 'DatabaseError');
        status = 'AUDIT_FINALIZATION_FAILED';
      }
    }
    if (deletedCount > 0) tenantSnapshotCache.delete(String(req.tenantId));
    console.error('Tenant data management delete failed:', error.name || 'DatabaseError');
    const responseStatus = status === 'PARTIAL' ? 207 : status === 'AUDIT_FINALIZATION_FAILED' ? 500 : 503;
    return res.status(responseStatus).json({
      success: false,
      status,
      deletedCount,
      failedRecordId,
      message: status === 'AUDIT_FINALIZATION_FAILED'
        ? `Deletion handlers confirmed ${deletedCount} record(s), but the audit status could not be finalized. Check audit history before retrying.`
        : deletedCount > 0
          ? `Only ${deletedCount} record(s) were deleted before the operation stopped. Check audit history.`
          : failureMessage || 'No records were deleted because the operation could not be completed.'
    });
  }
};

const getDataManagementHistory = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  try {
    const [total, history] = await Promise.all([
      DatabaseManagementAudit.countDocuments({ tenantId: req.tenantId }),
      DatabaseManagementAudit.find({ tenantId: req.tenantId })
        .select('actorId actorRole category operation affectedRecordCount filters reason status createdAt')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
    ]);
    return res.json({ success: true, page, limit, total, history });
  } catch (error) {
    return sendDatabaseUnavailable(
      res,
      error,
      'Tenant database management audit history',
      'Database management audit history is temporarily unavailable.'
    );
  }
};

const assertDatabaseConnected = () => {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    const error = new Error('Database is not connected');
    error.code = 'DATABASE_UNAVAILABLE';
    throw error;
  }
};

const createTenantSnapshot = async (tenantId) => {
  assertDatabaseConnected();

  const actualCollections = await mongoose.connection.db
    .listCollections({}, { nameOnly: true })
    .toArray();
  const actualCollectionByName = new Map(
    actualCollections.map((collection) => [collection.name, collection])
  );
  const definitions = getTenantCollectionDefinitions().filter(
    ({ model }) => actualCollectionByName.has(model.collection.name)
  );

  const collections = await Promise.all(definitions.map(async (definition) => {
    const { model } = definition;
    const collection = actualCollectionByName.get(model.collection.name);
    const [documentCount, indexes] = await Promise.all([
      model.countDocuments({ tenantId }).maxTimeMS(QUERY_TIMEOUT_MS).exec(),
      model.collection.indexes()
    ]);

    return {
      name: model.collection.name,
      modelName: model.modelName,
      documentCount,
      estimatedSizeBytes: null,
      sharedDocumentCount: null,
      sizeUnavailableReason: 'Shared collection size is only available to platform administrators.',
      indexCount: indexes.length,
      collectionType: collection.type || 'collection',
      tenantScoped: true,
      protected: definition.protected,
      protectionReason: definition.protectionReason,
      managementMenu: definition.managementMenu,
      managementCategory: definition.managementCategory
    };
  }));

  const refreshedAt = new Date().toISOString();
  const summary = collections.reduce((result, collection) => ({
    tenantDocumentCount: result.tenantDocumentCount + collection.documentCount,
    tenantCollectionCount: result.tenantCollectionCount + 1,
    sharedCollectionIndexCount: result.sharedCollectionIndexCount + collection.indexCount
  }), {
    tenantDocumentCount: 0,
    tenantCollectionCount: 0,
    sharedCollectionIndexCount: 0
  });

  return {
    scope: 'authenticated_tenant',
    refreshedAt,
    summary: {
      ...summary,
      dataSizeBytes: null,
      storageSizeBytes: null,
      indexSizeBytes: null,
      averageDocumentSizeBytes: null,
      atlasCapacityMonitoringConfigured: false
    },
    collections
  };
};

const getTenantSnapshot = async (tenantId, forceRefresh = false) => {
  const cacheKey = String(tenantId);
  const now = Date.now();
  for (const [cachedTenantId, cachedSnapshot] of tenantSnapshotCache) {
    if (now - cachedSnapshot.createdAt >= CACHE_TTL_MS) {
      tenantSnapshotCache.delete(cachedTenantId);
    }
  }

  if (tenantSnapshotRequests.has(cacheKey)) {
    return tenantSnapshotRequests.get(cacheKey);
  }

  const cached = tenantSnapshotCache.get(cacheKey);
  if (!forceRefresh && cached) {
    return cached.snapshot;
  }

  const request = createTenantSnapshot(tenantId)
    .then((snapshot) => {
      tenantSnapshotCache.set(cacheKey, { snapshot, createdAt: Date.now() });
      return snapshot;
    })
    .finally(() => tenantSnapshotRequests.delete(cacheKey));

  tenantSnapshotRequests.set(cacheKey, request);
  return request;
};

const sendDatabaseUnavailable = (
  res,
  error,
  operation,
  message = 'Database statistics are temporarily unavailable.'
) => {
  console.error(`${operation} failed:`, error.name || 'DatabaseError');
  return res.status(503).json({
    success: false,
    message
  });
};

const getDatabaseStatus = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const checkedAt = new Date();

  try {
    assertDatabaseConnected();
    await mongoose.connection.db.admin().ping();
    lastSuccessfulConnectionCheck = checkedAt;

    return res.status(200).json({
      success: true,
      connected: true,
      checkedAt: checkedAt.toISOString(),
      lastSuccessfulConnectionCheck: lastSuccessfulConnectionCheck.toISOString(),
      databaseErrorStatus: 'none',
      scope: 'shared_database_connection'
    });
  } catch (error) {
    return res.status(503).json({
      success: false,
      connected: false,
      checkedAt: checkedAt.toISOString(),
      lastSuccessfulConnectionCheck: lastSuccessfulConnectionCheck
        ? lastSuccessfulConnectionCheck.toISOString()
        : null,
      databaseErrorStatus: 'unavailable',
      message: 'Database connection is unavailable.'
    });
  }
};

const getDatabaseStorage = async (req, res) => {
  res.set('Cache-Control', 'no-store');

  try {
    const snapshot = await getTenantSnapshot(req.tenantId);
    let platformStorage = null;
    if (req.isPlatformAdmin) {
      const [databaseStats, atlasStorage] = await Promise.all([
        mongoose.connection.db.stats(),
        getAtlasStorage()
      ]);
      platformStorage = {
        databaseName: mongoose.connection.name || null,
        databaseStats: {
          dataSizeBytes: databaseStats.dataSize ?? null,
          storageSizeBytes: databaseStats.storageSize ?? null,
          indexSizeBytes: databaseStats.indexSize ?? null,
          documentCount: databaseStats.objects ?? null,
          collectionCount: databaseStats.collections ?? null,
          indexCount: databaseStats.indexes ?? null,
          averageDocumentSizeBytes: databaseStats.avgObjSize ?? null
        },
        atlasStorage
      };
    }

    return res.status(200).json({
      success: true,
      scope: snapshot.scope,
      refreshedAt: req.isPlatformAdmin ? new Date().toISOString() : snapshot.refreshedAt,
      platformAdmin: Boolean(req.isPlatformAdmin),
      platformStorage,
      ...snapshot.summary,
      atlasCapacityMonitoringConfigured: Boolean(platformStorage?.atlasStorage.configured)
    });
  } catch (error) {
    return sendDatabaseUnavailable(res, error, 'Tenant database statistics query');
  }
};

const getCollections = async (req, res) => {
  res.set('Cache-Control', 'no-store');

  try {
    const snapshot = await getTenantSnapshot(req.tenantId);
    const collections = req.isPlatformAdmin
      ? await Promise.all(snapshot.collections.map(async (collection) => {
        try {
          const stats = await mongoose.connection.db.command({
            collStats: collection.name,
            scale: 1
          });
          return {
            ...collection,
            estimatedSizeBytes: Number.isFinite(stats.size) ? stats.size : null,
            sharedDocumentCount: Number.isFinite(stats.count) ? stats.count : null,
            sizeUnavailableReason: null
          };
        } catch (error) {
          console.error(`Collection statistics query failed for ${collection.name}:`, error.name || 'DatabaseError');
          return {
            ...collection,
            sizeUnavailableReason: 'MongoDB collection statistics are unavailable.'
          };
        }
      }))
      : snapshot.collections;
    return res.status(200).json({
      success: true,
      scope: snapshot.scope,
      refreshedAt: snapshot.refreshedAt,
      collections
    });
  } catch (error) {
    return sendDatabaseUnavailable(res, error, 'Tenant collection statistics query');
  }
};

const getCollectionStats = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const definition = getTenantCollectionDefinitions().find(
    ({ model }) => model.collection.name === req.params.collectionName
  );
  if (!definition) {
    return res.status(404).json({ success: false, message: 'Collection is not available.' });
  }

  try {
    assertDatabaseConnected();
    const collectionInfo = await mongoose.connection.db
      .listCollections({ name: definition.model.collection.name }, { nameOnly: true })
      .next();
    if (!collectionInfo) {
      return res.status(404).json({ success: false, message: 'Collection was not found.' });
    }

    const [documentCount, rawIndexes] = await Promise.all([
      definition.model.countDocuments({ tenantId: req.tenantId })
        .maxTimeMS(QUERY_TIMEOUT_MS)
        .exec(),
      definition.model.collection.indexes()
    ]);
    let sharedStats = null;
    if (req.isPlatformAdmin) {
      try {
        sharedStats = await mongoose.connection.db.command({
          collStats: definition.model.collection.name,
          scale: 1
        });
      } catch (error) {
        console.error(`Collection details statistics query failed for ${definition.model.collection.name}:`, error.name || 'DatabaseError');
      }
    }

    return res.json({
      success: true,
      collection: {
        name: definition.model.collection.name,
        modelName: definition.model.modelName,
        documentCount,
        estimatedSizeBytes: Number.isFinite(sharedStats?.size) ? sharedStats.size : null,
        sharedDocumentCount: Number.isFinite(sharedStats?.count) ? sharedStats.count : null,
        collectionType: collectionInfo.type || 'collection',
        tenantScoped: true,
        indexes: rawIndexes.map(index => ({
          name: index.name,
          keys: Object.keys(index.key || {}),
          unique: Boolean(index.unique),
          sparse: Boolean(index.sparse),
          expiresAfterSeconds: Number.isFinite(index.expireAfterSeconds)
            ? index.expireAfterSeconds
            : null
        }))
      }
    });
  } catch (error) {
    return sendDatabaseUnavailable(
      res,
      error,
      'Tenant collection details query',
      'Collection details are temporarily unavailable.'
    );
  }
};

const refreshDatabaseStorage = async (req, res) => {
  res.set('Cache-Control', 'no-store');

  try {
    const snapshot = await getTenantSnapshot(req.tenantId, true);
    return res.status(200).json({
      success: true,
      scope: snapshot.scope,
      refreshedAt: snapshot.refreshedAt,
      summary: snapshot.summary,
      collections: snapshot.collections
    });
  } catch (error) {
    return sendDatabaseUnavailable(res, error, 'Tenant database statistics refresh');
  }
};

module.exports = {
  getDatabaseStatus,
  getDatabaseStorage,
  getCollections,
  getCollectionStats,
  refreshDatabaseStorage,
  getTenantCollectionDefinitions,
  getManagementRecords,
  getDeletePreview,
  deleteSelectedRecords,
  getDataManagementHistory,
  buildManagementFilter
};
