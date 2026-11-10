const test = require('node:test');
const assert = require('node:assert/strict');
const Enquiry = require('../models/Enquiry');
const {
  ENQUIRY_STATUSES,
  TRIAL_STATUSES,
  ENQUIRY_SOURCES,
  INTEREST_OPTIONS,
  normalizePhone,
  normalizeTrialStatus,
  parseEnquiryDate,
  pagination
} = require('../utils/enquiries');
const { _enquiryFilter } = require('../controllers/enquiryController');
const enquiryController = require('../controllers/enquiryController');
const Member = require('../models/Member');
const Business = require('../models/Business');

test('enquiry phone validation canonicalizes formatting and rejects malformed values', () => {
  assert.deepEqual(normalizePhone('+1 (415) 555-2671'), {
    phone: '+1 (415) 555-2671',
    normalizedPhone: '14155552671'
  });
  assert.equal(normalizePhone('123-abc-7890'), null);
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('---1234567'), null);
  assert.equal(normalizePhone('9876543210').normalizedPhone, '9876543210');
  assert.equal(normalizePhone('+91 98765-43210').normalizedPhone, '9876543210');
  assert.equal(normalizePhone('0091 (098765) 43210').normalizedPhone, '9876543210');
  assert.equal(normalizeTrialStatus('Scheduled'), 'SCHEDULED');
  assert.equal(normalizeTrialStatus('Attended'), 'COMPLETED');
  assert.equal(normalizeTrialStatus('No Show'), 'NO_SHOW');
});

test('enquiry date parsing rejects invalid dates and permits explicit nullable dates', () => {
  assert.equal(parseEnquiryDate('not-a-date').error, 'Invalid date');
  assert.equal(parseEnquiryDate('2026-02-30').error, 'Invalid date');
  assert.equal(parseEnquiryDate('2026-02-30T09:00:00Z').error, 'Invalid date');
  assert.equal(parseEnquiryDate(null, { nullable: true }).value, null);
  assert.equal(
    parseEnquiryDate('2026-11-10T09:00:00.000Z').value.toISOString(),
    '2026-11-10T09:00:00.000Z'
  );
});

test('enquiry pagination has safe defaults and a bounded maximum', () => {
  assert.deepEqual(pagination({ page: '-2', limit: '1000' }), {
    page: 1,
    limit: 100,
    skip: 0
  });
  assert.deepEqual(pagination({ page: '3', limit: '20' }), {
    page: 3,
    limit: 20,
    skip: 40
  });
});

test('enquiry schema enforces tenant scope, valid histories and a tenant-scoped unique mobile index', () => {
  assert.equal(Enquiry.schema.path('tenantId').isRequired, true);
  assert.equal(Enquiry.schema.path('businessId').isRequired, true);
  assert.equal(Enquiry.schema.path('createdBy').isRequired, true);
  assert.deepEqual(Enquiry.schema.path('status').enumValues, ENQUIRY_STATUSES);
  assert.deepEqual(Enquiry.schema.path('trials').schema.path('status').enumValues, TRIAL_STATUSES);
  assert.deepEqual(Enquiry.schema.path('source').enumValues, ENQUIRY_SOURCES);
  assert.deepEqual(ENQUIRY_SOURCES, [
    'Walk-in', 'Instagram', 'Facebook', 'WhatsApp', 'Website', 'Referral', 'Google', 'Other'
  ]);
  assert.deepEqual(Enquiry.schema.path('interestedIn').enumValues, INTEREST_OPTIONS);
  assert.equal(Enquiry.schema.path('age').options.min, 1);
  assert.equal(Enquiry.schema.path('expectedJoiningDate').instance, 'Date');
  assert.equal(Enquiry.schema.path('statusHistory').schema.path('previousStatus').instance, 'String');
  assert.equal(Enquiry.schema.path('statusHistory').schema.path('newStatus').instance, 'String');
  assert.equal(Enquiry.schema.path('followUps').schema.path('assignedStaffId').instance, 'ObjectId');
  assert.equal(Enquiry.schema.path('trials').schema.path('assignedTrainerId').instance, 'ObjectId');
  assert.equal(Enquiry.schema.path('trials').schema.path('nextFollowUpAt').instance, 'Date');
  assert.ok(Enquiry.schema.indexes().some(([index, options]) =>
    index.tenantId === 1 && index.normalizedPhone === 1 && options.unique === true
  ));
  assert.ok(Member.schema.indexes().some(([index, options]) =>
    index.tenantId === 1 && index.sourceEnquiryId === 1 && options.unique === true
  ));
});

test('enquiry lookup filter uses authenticated tenant and business context only', () => {
  const req = {
    tenantId: 'authenticated-tenant',
    owner: { businessId: 'authenticated-business' },
    params: { id: 'an-enquiry-id' },
    body: { tenantId: 'attacker-tenant', businessId: 'attacker-business' }
  };
  assert.deepEqual(_enquiryFilter(req, req.params.id), {
    _id: req.params.id,
    tenantId: req.tenantId,
    businessId: req.owner.businessId
  });
});

test('duplicate enquiry response includes the existing tenant-scoped enquiry details', async () => {
  const original = Enquiry.findOne;
  const existing = { _id: 'existing-id', fullName: 'Existing Lead', phone: '4155552671' };
  let filter;
  Enquiry.findOne = (query) => {
    filter = query;
    return { select() { return this; }, lean: async () => existing };
  };
  try {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await enquiryController.createEnquiry({
      tenantId: 'tenant-1',
      owner: { _id: 'owner-1', businessId: 'business-1' },
      body: { fullName: 'New Lead', phone: '415-555-2671', tenantId: 'attacker' }
    }, res);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(filter, {
      tenantId: 'tenant-1',
      businessId: 'business-1',
      normalizedPhone: '4155552671'
    });
    assert.equal(res.body.existingEnquiryId, existing._id);
    assert.deepEqual(res.body.enquiry, existing);
  } finally {
    Enquiry.findOne = original;
  }
});

test('enquiry creation accepts optional frontend fields and stores canonical values', async () => {
  const original = { findOne: Enquiry.findOne, create: Enquiry.create };
  Enquiry.findOne = () => ({ lean: async () => null });
  Enquiry.create = async (data) => data;
  try {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await enquiryController.createEnquiry({
      tenantId: 'tenant-1',
      owner: { _id: 'owner-1', businessId: 'business-1' },
      body: {
        fullName: 'New Lead',
        phone: '+1 (415) 555-2671',
        age: null,
        interestedIn: 'Both',
        expectedJoiningDate: '2026-12-01',
        source: 'WhatsApp',
        tenantId: 'attacker'
      }
    }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.enquiry.tenantId, 'tenant-1');
    assert.equal(res.body.enquiry.age, null);
    assert.equal(res.body.enquiry.interestedIn, 'Both');
    assert.equal(res.body.enquiry.source, 'WhatsApp');
    assert.equal(res.body.enquiry.status, 'NEW');
    assert.equal(res.body.enquiry.statusHistory[0].newStatus, 'NEW');
  } finally {
    Enquiry.findOne = original.findOne;
    Enquiry.create = original.create;
  }
});

test('enquiry list applies source, assigned staff and date filters inside tenant scope', async () => {
  const original = { find: Enquiry.find, countDocuments: Enquiry.countDocuments };
  let captured;
  Enquiry.find = (filter) => {
    captured = filter;
    return {
      sort() { return this; },
      skip() { return this; },
      limit() { return this; },
      lean: async () => []
    };
  };
  Enquiry.countDocuments = async () => 0;
  try {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await enquiryController.listEnquiries({
      tenantId: 'tenant-1',
      owner: { _id: 'owner-1', businessId: 'business-1' },
      query: {
        source: 'Referral',
        assignedStaffId: '507f1f77bcf86cd799439011',
        from: '2026-11-01',
        to: '2026-11-30',
        tenantId: 'attacker'
      }
    }, res);
    assert.equal(captured.tenantId, 'tenant-1');
    assert.equal(captured.businessId, 'business-1');
    assert.equal(captured.source, 'Referral');
    assert.equal(captured.assignedStaffId, '507f1f77bcf86cd799439011');
    assert.equal(captured.createdAt.$gte.toISOString(), '2026-11-01T00:00:00.000Z');
    assert.equal(captured.createdAt.$lte.toISOString(), '2026-11-30T23:59:59.999Z');
  } finally {
    Enquiry.find = original.find;
    Enquiry.countDocuments = original.countDocuments;
  }
});

test('enquiry dashboard returns the nine requested metrics plus existing status counts', async () => {
  const original = {
    countDocuments: Enquiry.countDocuments,
    aggregate: Enquiry.aggregate,
    businessFindOne: Business.findOne
  };
  Business.findOne = () => ({
    select() { return this; },
    lean: async () => ({ timeZone: 'Asia/Kolkata' })
  });
  Enquiry.countDocuments = async (filter) => {
    if (filter.status === 'NEW') return 2;
    if (filter.status === 'INTERESTED') return 3;
    if (filter.status === 'CONVERTED') return 4;
    if (filter.status === 'LOST') return 5;
    if (filter.nextFollowUpAt?.$gte) return 6;
    if (filter.nextFollowUpAt?.$lt) return 7;
    if (filter.trials) return 8;
    return 30;
  };
  Enquiry.aggregate = async (pipeline) => {
    assert.equal(pipeline[0].$match.tenantId, 'tenant-1');
    assert.equal(pipeline[0].$match.businessId, 'business-1');
    return [{ _id: 'NEW', count: 2 }];
  };
  try {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await enquiryController.getEnquiryDashboard({
      tenantId: 'tenant-1',
      owner: { _id: 'owner-1', businessId: 'business-1' },
      query: {}
    }, res);
    assert.deepEqual(res.body.dashboard, {
      total: 30,
      statusCounts: { NEW: 2 },
      new: 2,
      interested: 3,
      followUpsToday: 6,
      overdueFollowUps: 7,
      trialsScheduled: 8,
      converted: 4,
      conversionRate: 13.33,
      lost: 5,
      overdue: 7,
      dueFollowUps: 13
    });
  } finally {
    Enquiry.countDocuments = original.countDocuments;
    Enquiry.aggregate = original.aggregate;
    Business.findOne = original.businessFindOne;
  }
});

test('enquiry conversion creates a tenant-scoped member before marking the enquiry converted', async () => {
  const original = {
    findOne: Enquiry.findOne,
    updateOne: Enquiry.updateOne,
    memberFindOne: Member.findOne,
    memberCreate: Member.create
  };
  const order = [];
  const memberId = '507f1f77bcf86cd799439099';
  Enquiry.findOne = () => ({ lean: async () => ({
    _id: '507f1f77bcf86cd799439088',
    fullName: 'Alex Member',
    phone: '4155552671',
    email: '',
    gender: 'Other',
    notes: '',
    status: 'INTERESTED',
    convertedMemberId: null
  }) });
  Member.findOne = () => ({
    select() { return this; },
    lean: async () => null
  });
  Member.create = async (data) => {
    order.push('member');
    assert.equal(data.tenantId, 'tenant-1');
    assert.equal(data.businessId, 'business-1');
    assert.equal(data.createdBy, 'owner-1');
    assert.equal(data.sourceEnquiryId, '507f1f77bcf86cd799439088');
    return { ...data, _id: memberId };
  };
  Enquiry.updateOne = async (filter, update) => {
    order.push('enquiry');
    assert.equal(filter.tenantId, 'tenant-1');
    assert.equal(filter.businessId, 'business-1');
    assert.equal(update.$set.convertedMemberId, memberId);
    assert.equal(update.$push.statusHistory.previousStatus, 'INTERESTED');
    assert.equal(update.$push.statusHistory.newStatus, 'CONVERTED');
    assert.equal(update.$push.statusHistory.status, 'CONVERTED');
    return { matchedCount: 1 };
  };
  try {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await enquiryController.convertEnquiryToMember({
      tenantId: 'tenant-1',
      owner: { _id: 'owner-1', businessId: 'business-1' },
      params: { id: '507f1f77bcf86cd799439088' },
      body: {}
    }, res);
    assert.deepEqual(order, ['member', 'enquiry']);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.enquiry.status, 'CONVERTED');
    assert.equal(res.body.member._id, memberId);
  } finally {
    Enquiry.findOne = original.findOne;
    Enquiry.updateOne = original.updateOne;
    Member.findOne = original.memberFindOne;
    Member.create = original.memberCreate;
  }
});

test('failed member creation does not mark the enquiry converted', async () => {
  const original = {
    findOne: Enquiry.findOne,
    updateOne: Enquiry.updateOne,
    memberFindOne: Member.findOne,
    memberCreate: Member.create,
    consoleError: console.error
  };
  let updateCalled = false;
  Enquiry.findOne = () => ({ lean: async () => ({
    _id: '507f1f77bcf86cd799439088',
    fullName: 'Alex Member',
    phone: '4155552671',
    status: 'INTERESTED',
    convertedMemberId: null
  }) });
  Member.findOne = () => ({
    select() { return this; },
    lean: async () => null
  });
  Member.create = async () => { throw new Error('member storage failed'); };
  Enquiry.updateOne = async () => { updateCalled = true; return { matchedCount: 1 }; };
  console.error = () => {};
  try {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await enquiryController.convertEnquiryToMember({
      tenantId: 'tenant-1',
      owner: { _id: 'owner-1', businessId: 'business-1' },
      params: { id: '507f1f77bcf86cd799439088' },
      body: {}
    }, res);
    assert.equal(updateCalled, false);
    assert.equal(res.statusCode, 500);
  } finally {
    Enquiry.findOne = original.findOne;
    Enquiry.updateOne = original.updateOne;
    Member.findOne = original.memberFindOne;
    Member.create = original.memberCreate;
    console.error = original.consoleError;
  }
});

test('enquiry conversion rolls the created member back if the enquiry update loses a race', async () => {
  const original = {
    findOne: Enquiry.findOne,
    updateOne: Enquiry.updateOne,
    memberFindOne: Member.findOne,
    memberCreate: Member.create,
    memberDeleteOne: Member.deleteOne
  };
  let removedMemberId;
  const memberId = '507f1f77bcf86cd799439099';
  Enquiry.findOne = () => ({ lean: async () => ({
    _id: '507f1f77bcf86cd799439088',
    fullName: 'Alex Member',
    phone: '4155552671',
    status: 'INTERESTED',
    convertedMemberId: null
  }) });
  Member.findOne = () => ({ select() { return this; }, lean: async () => null });
  Member.create = async (data) => ({ ...data, _id: memberId });
  Enquiry.updateOne = async () => ({ matchedCount: 0 });
  Member.deleteOne = async (filter) => {
    removedMemberId = filter._id;
    return { deletedCount: 1 };
  };
  try {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await enquiryController.convertEnquiryToMember({
      tenantId: 'tenant-1',
      owner: { _id: 'owner-1', businessId: 'business-1' },
      params: { id: '507f1f77bcf86cd799439088' },
      body: {}
    }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(removedMemberId, memberId);
  } finally {
    Enquiry.findOne = original.findOne;
    Enquiry.updateOne = original.updateOne;
    Member.findOne = original.memberFindOne;
    Member.create = original.memberCreate;
    Member.deleteOne = original.memberDeleteOne;
  }
});

test('enquiry conversion reports failed member rollback instead of hiding the orphan', async () => {
  const original = {
    findOne: Enquiry.findOne,
    updateOne: Enquiry.updateOne,
    memberFindOne: Member.findOne,
    memberCreate: Member.create,
    memberDeleteOne: Member.deleteOne,
    consoleError: console.error
  };
  const memberId = '507f1f77bcf86cd799439099';
  Enquiry.findOne = () => ({ lean: async () => ({
    _id: '507f1f77bcf86cd799439088',
    fullName: 'Alex Member',
    phone: '4155552671',
    status: 'INTERESTED',
    convertedMemberId: null
  }) });
  Member.findOne = () => ({ select() { return this; }, lean: async () => null });
  Member.create = async (data) => ({ ...data, _id: memberId });
  Enquiry.updateOne = async () => ({ matchedCount: 0 });
  Member.deleteOne = async () => { throw new Error('member deletion unavailable'); };
  console.error = () => {};
  try {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await enquiryController.convertEnquiryToMember({
      tenantId: 'tenant-1',
      owner: { _id: 'owner-1', businessId: 'business-1' },
      params: { id: '507f1f77bcf86cd799439088' },
      body: {}
    }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.conversionRollbackFailed, true);
    assert.equal(res.body.memberId, memberId);
  } finally {
    Enquiry.findOne = original.findOne;
    Enquiry.updateOne = original.updateOne;
    Member.findOne = original.memberFindOne;
    Member.create = original.memberCreate;
    Member.deleteOne = original.memberDeleteOne;
    console.error = original.consoleError;
  }
});
