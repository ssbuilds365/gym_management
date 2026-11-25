const test = require('node:test');
const assert = require('node:assert/strict');
const Member = require('../models/Member');
const MemberMembership = require('../models/MemberMembership');
const Payment = require('../models/Payment');
const { getAllMembers } = require('../controllers/memberController');

const makeResponse = () => ({
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
});

const captureSearchFilter = async search => {
  const originalMethods = {
    find: Member.find,
    countDocuments: Member.countDocuments,
    membershipFind: MemberMembership.find,
    aggregate: Payment.aggregate
  };
  let capturedFilter;
  Member.find = filter => {
    capturedFilter = filter;
    return {
      sort() { return this; },
      skip() { return this; },
      limit() { return this; },
      lean: async () => []
    };
  };
  Member.countDocuments = async () => 0;
  MemberMembership.find = () => ({
    populate() { return this; },
    sort() { return this; },
    lean: async () => []
  });
  Payment.aggregate = async () => [];
  try {
    const response = makeResponse();
    await getAllMembers({
      query: { search, page: '1', limit: '10' },
      tenantId: 'tenant-a',
      owner: { businessId: 'business-a' }
    }, response);
    assert.equal(response.statusCode, 200);
    return capturedFilter;
  } finally {
    Member.find = originalMethods.find;
    Member.countDocuments = originalMethods.countDocuments;
    MemberMembership.find = originalMethods.membershipFind;
    Payment.aggregate = originalMethods.aggregate;
  }
};

test('member search includes escaped name/phone and legacy member ID matches within the gym', async () => {
  const filter = await captureSearchFilter('M.*104');
  assert.equal(filter.tenantId, 'tenant-a');
  assert.equal(filter.businessId, 'business-a');
  assert.deepEqual(filter.$or, [
    { fullName: { $regex: 'M\\.\\*104', $options: 'i' } },
    { phone: { $regex: 'M\\.\\*104', $options: 'i' } },
    { legacyMemberId: { $regex: 'M\\.\\*104', $options: 'i' } }
  ]);
});

test('member search supports an exact MongoDB member ID', async () => {
  const memberId = '507f1f77bcf86cd799439011';
  const filter = await captureSearchFilter(memberId);
  assert.ok(filter.$or.some(condition => condition._id === memberId));
});
