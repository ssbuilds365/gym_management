const test = require('node:test');
const assert = require('node:assert/strict');
const Business = require('../models/Business');
const Member = require('../models/Member');
const MemberMembership = require('../models/MemberMembership');
const Payment = require('../models/Payment');
const { getEligible } = require('../controllers/globalMessageController');

const createResponse = () => ({
  statusCode: 200,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});

const createRequest = (filter = 'all', search = '', page = '1', limit = '50') => ({
  tenantId: 'tenant-id',
  owner: { businessId: 'business-id' },
  query: { filter, search, page, limit }
});

const setBusinessMock = () => {
  Business.findById = () => ({
    select: () => ({
      lean: async () => ({ timeZone: 'Asia/Kolkata' })
    })
  });
};

test('eligible-member endpoint uses tenant-scoped member queries and returns paginated data', async () => {
  const originals = {
    findById: Business.findById,
    memberFind: Member.find,
    membershipFind: MemberMembership.find,
    paymentAggregate: Payment.aggregate
  };
  const now = new Date();
  const members = [
    { _id: 'member-active', fullName: 'Asha Active', phone: '9876543210', status: 'Active' },
    { _id: 'member-expired', fullName: 'Bala Expired', phone: '9876543211', status: 'Inactive' },
    { _id: 'member-soon', fullName: 'Chitra Soon', phone: '+91 98765 43212', status: 'Active' },
    { _id: 'member-no-plan', fullName: 'Deepa No Plan', phone: '9876543213', status: 'Active' },
    { _id: 'member-invalid', fullName: 'Esha Invalid', phone: '12345', status: 'Active' }
  ];
  const memberships = [
    {
      _id: 'membership-active',
      memberId: 'member-active',
      planId: { planName: 'Monthly' },
      startDate: new Date(now.getTime() - 30 * 86400000),
      endDate: new Date(now.getTime() + 15 * 86400000),
      planPrice: 1000,
      status: 'Active'
    },
    {
      _id: 'membership-expired',
      memberId: 'member-expired',
      planId: { planName: 'Annual' },
      startDate: new Date('2020-01-01T00:00:00.000Z'),
      endDate: new Date('2020-12-31T00:00:00.000Z'),
      planPrice: 1000,
      status: 'Expired'
    },
    {
      _id: 'membership-soon',
      memberId: 'member-soon',
      planId: { planName: 'Monthly' },
      startDate: new Date(now.getTime() - 30 * 86400000),
      endDate: new Date(now.getTime() + 3 * 86400000),
      planPrice: 1000,
      status: 'Active'
    },
    {
      _id: 'membership-invalid',
      memberId: 'member-invalid',
      planId: { planName: 'Trial' },
      startDate: new Date(now.getTime() - 30 * 86400000),
      endDate: new Date(now.getTime() + 15 * 86400000),
      planPrice: 1000,
      status: 'Active'
    }
  ];
  let memberQuery;
  let membershipQuery;
  setBusinessMock();
  Member.find = filter => {
    memberQuery = filter;
    return {
      sort: () => ({
        lean: () => ({
          cursor: () => ({
            async *[Symbol.asyncIterator]() {
              for (const member of members) yield member;
            }
          })
        })
      })
    };
  };
  MemberMembership.find = filter => {
    membershipQuery = filter;
    return {
      populate: () => ({
        sort: () => ({ lean: async () => memberships })
      })
    };
  };
  Payment.aggregate = async () => [];

  try {
    const allResponse = createResponse();
    await getEligible(createRequest('all', '', '2', '2'), allResponse);
    assert.equal(allResponse.statusCode, 200);
    assert.equal(allResponse.body.success, true);
    assert.equal(allResponse.body.pagination.total, 4);
    assert.equal(allResponse.body.pagination.totalPages, 2);
    assert.equal(allResponse.body.members.length, 2);
    assert.equal(allResponse.body.invalidNumberCount, 1);
    assert.equal(memberQuery.tenantId, 'tenant-id');
    assert.equal(memberQuery.businessId, 'business-id');
    assert.equal(memberQuery.deletedAt, null);
    assert.deepEqual(membershipQuery.memberId.$in, members.map(member => member._id));
    assert.equal(membershipQuery.tenantId, 'tenant-id');
    assert.equal(membershipQuery.businessId, 'business-id');

    for (const [filter, expectedNames] of [
      ['active', ['Asha Active', 'Chitra Soon']],
      ['expired', ['Bala Expired']],
      ['expiringSoon', ['Chitra Soon']],
      ['pendingFees', ['Asha Active', 'Bala Expired', 'Chitra Soon']]
    ]) {
      const response = createResponse();
      await getEligible(createRequest(filter), response);
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body.members.map(member => member.fullName), expectedNames);
    }

    const searchResponse = createResponse();
    await getEligible(createRequest('all', 'Asha'), searchResponse);
    assert.ok(memberQuery.$or.some(condition => condition.fullName?.$regex === 'Asha'));
  } finally {
    Business.findById = originals.findById;
    Member.find = originals.memberFind;
    MemberMembership.find = originals.membershipFind;
    Payment.aggregate = originals.paymentAggregate;
  }
});

test('member lookup errors log sanitized diagnostics and return a generic server message', async () => {
  const originalFindById = Business.findById;
  const originalMemberFind = Member.find;
  const originalError = console.error;
  const logCalls = [];
  const sensitivePhone = '9876543210';
  setBusinessMock();
  Member.find = () => ({
    sort: () => ({
      lean: () => ({
        cursor: () => ({
          async *[Symbol.asyncIterator]() {
            throw new Error(`query rejected for ${sensitivePhone}`);
          }
        })
      })
    })
  });
  console.error = (...args) => logCalls.push(args);

  try {
    const response = createResponse();
    await getEligible(createRequest('active', sensitivePhone), response);

    assert.equal(response.statusCode, 500);
    assert.equal(response.body.message, 'Unable to load eligible members.');
    assert.equal(logCalls[0][0], '[global-message] member lookup failed');
    assert.equal(logCalls[0][1].name, 'Error');
    assert.match(logCalls[0][1].message, /\[redacted-search\]/);
    assert.match(logCalls[0][1].stack, /Error: query rejected/);
    assert.doesNotMatch(JSON.stringify(logCalls[0]), new RegExp(sensitivePhone));
    assert.equal(logCalls[0][1].context.tenantIdValid, false);
  } finally {
    Business.findById = originalFindById;
    Member.find = originalMemberFind;
    console.error = originalError;
  }
});
