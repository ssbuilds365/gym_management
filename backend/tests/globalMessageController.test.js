const test = require('node:test');
const assert = require('node:assert/strict');
const Business = require('../models/Business');
const Member = require('../models/Member');
const { getEligible } = require('../controllers/globalMessageController');

test('eligible-member endpoint builds tenant-filtered aggregation and returns page data', async () => {
  const originalFindById = Business.findById;
  const originalAggregate = Member.aggregate;
  let pipeline;

  Business.findById = () => ({
    select: () => ({
      lean: async () => ({ timeZone: 'Asia/Kolkata' })
    })
  });
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
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      }
    };

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
