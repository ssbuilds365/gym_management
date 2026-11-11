const test = require('node:test');
const assert = require('node:assert/strict');
const Business = require('../models/Business');
const Member = require('../models/Member');
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

const mockBusiness = () => {
  Business.findById = () => ({
    select: () => ({
      lean: async () => ({ timeZone: 'Asia/Kolkata' })
    })
  });
};

test('eligible-member endpoint builds tenant-filtered aggregation and returns page data', async () => {
  const originalFindById = Business.findById;
  const originalAggregate = Member.aggregate;
  let pipeline;
  mockBusiness();
  Member.aggregate = async value => {
    pipeline = value;
    return [{
      members: [{ _id: 'member-id', fullName: 'Asha', normalizedMobile: '919876543210' }],
      total: [{ value: 1 }],
      invalid: [{ value: 0 }]
    }];
  };

  try {
    const req = {
      tenantId: 'tenant-id',
      owner: { businessId: 'business-id' },
      query: { filter: 'active', search: '', page: '1', limit: '50' }
    };
    const res = createResponse();

    await getEligible(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.members.length, 1);
    assert.equal(res.body.pagination.total, 1);
    assert.ok(pipeline.some(stage => stage.$match?.tenantId === 'tenant-id'));
    assert.ok(pipeline.some(stage => stage.$facet?.members));
  } finally {
    Business.findById = originalFindById;
    Member.aggregate = originalAggregate;
  }
});

test('eligible-member filters add membership and fee constraints without dropping tenant scope', async () => {
  const originalFindById = Business.findById;
  const originalAggregate = Member.aggregate;
  const expected = {
    active: ['status', 'membership._id', 'expiryCategory'],
    expired: ['membership._id', 'expiryCategory'],
    expiringSoon: ['status', 'membership._id', 'expiryCategory'],
    pendingFees: ['pendingAmount']
  };
  mockBusiness();

  try {
    for (const [filter, expectedKeys] of Object.entries(expected)) {
      let pipeline;
      Member.aggregate = async value => {
        pipeline = value;
        return [{ members: [], total: [], invalid: [] }];
      };
      const req = {
        tenantId: 'tenant-id',
        owner: { businessId: 'business-id' },
        query: { filter, search: '', page: '1', limit: '50' }
      };
      const res = createResponse();

      await getEligible(req, res);

      assert.equal(res.statusCode, 200, `${filter} filter should succeed`);
      const memberMatch = pipeline.at(-1).$facet.members[0].$match;
      for (const key of expectedKeys) assert.ok(key in memberMatch, `${filter} has ${key}`);
      assert.equal(pipeline[0].$match.tenantId, 'tenant-id');
      assert.equal(pipeline[0].$match.businessId, 'business-id');
    }
  } finally {
    Business.findById = originalFindById;
    Member.aggregate = originalAggregate;
  }
});

test('member lookup errors log sanitized diagnostics and return a generic server message', async () => {
  const originalFindById = Business.findById;
  const originalAggregate = Member.aggregate;
  const originalError = console.error;
  const logCalls = [];
  const sensitivePhone = '9876543210';
  mockBusiness();
  Member.aggregate = async () => {
    throw new Error(`query rejected for ${sensitivePhone}`);
  };
  console.error = (...args) => logCalls.push(args);

  try {
    const req = {
      tenantId: 'tenant-id',
      owner: { businessId: 'business-id' },
      query: { filter: 'active', search: sensitivePhone, page: '1', limit: '50' }
    };
    const res = createResponse();

    await getEligible(req, res);

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'Unable to load eligible members.');
    assert.equal(logCalls[0][0], '[global-message] member lookup failed');
    assert.equal(logCalls[0][1].name, 'Error');
    assert.match(logCalls[0][1].message, /\[redacted-search\]/);
    assert.match(logCalls[0][1].stack, /Error: query rejected/);
    assert.doesNotMatch(JSON.stringify(logCalls[0]), new RegExp(sensitivePhone));
    assert.equal(logCalls[0][1].context.tenantIdValid, false);
  } finally {
    Business.findById = originalFindById;
    Member.aggregate = originalAggregate;
    console.error = originalError;
  }
});
