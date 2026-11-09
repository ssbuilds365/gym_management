const test = require('node:test');
const assert = require('node:assert/strict');
const Business = require('../models/Business');
const Member = require('../models/Member');
const { getTodaysBirthdays } = require('../controllers/dashboardController');
const { getLocalDateParts } = require('../utils/dashboardPeriods');

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

const mockBusiness = (t, timeZone) => {
  t.mock.method(Business, 'findOne', () => ({
    select() {
      return this;
    },
    lean: async () => ({ timeZone })
  }));
};

test('today birthdays use local business date, tenant scope, and include inactive members', async t => {
  const tenantId = 'tenant-id';
  const businessId = 'business-id';
  const timeZone = 'America/Los_Angeles';
  const today = getLocalDateParts(new Date(), timeZone);
  const birthday = new Date(Date.UTC(today.year - 26, today.month - 1, today.day));
  mockBusiness(t, timeZone);

  let pipeline;
  t.mock.method(Member, 'aggregate', async value => {
    pipeline = value;
    return [{
      _id: 'member-id',
      fullName: 'Alex Member',
      phone: '5551234567',
      dateOfBirth: birthday
    }];
  });

  const response = createResponse();
  await getTodaysBirthdays({
    tenantId,
    owner: { businessId }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.timeZone, timeZone);
  assert.equal(response.body.count, 1);
  assert.deepEqual(response.body.members, [{
    _id: 'member-id',
    fullName: 'Alex Member',
    phone: '5551234567',
    age: 26
  }]);

  const match = pipeline[0].$match;
  assert.equal(match.tenantId, tenantId);
  assert.equal(match.businessId, businessId);
  assert.equal(match.deletedAt, null);
  assert.equal('status' in match, false);
  assert.deepEqual(pipeline[2].$match, {
    'birthdayParts.month': today.month,
    'birthdayParts.day': today.day
  });
  assert.deepEqual(pipeline.at(-1).$project, {
    fullName: 1,
    phone: 1,
    dateOfBirth: 1
  });
});

test('today birthdays returns a valid empty state when no members match', async t => {
  mockBusiness(t, 'Asia/Kolkata');
  t.mock.method(Member, 'aggregate', async () => []);

  const response = createResponse();
  await getTodaysBirthdays({
    tenantId: 'tenant-id',
    owner: { businessId: 'business-id' }
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.count, 0);
  assert.deepEqual(response.body.members, []);
});
