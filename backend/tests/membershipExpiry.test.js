const test = require('node:test');
const assert = require('node:assert/strict');
const {
  addMembershipDuration,
  classifyMembershipExpiry,
  createMembershipExpiryPipeline,
  getMembershipExpiryWindow
} = require('../utils/membershipExpiry');
const { localDateTimeToUtc } = require('../utils/dashboardPeriods');

const localMidnight = (year, month, day, timeZone) =>
  localDateTimeToUtc({ year, month, day }, timeZone);

test('membership expiry uses business-local calendar days and exclusive day-eight boundary', () => {
  const timeZone = 'Asia/Kolkata';
  const now = new Date('2026-03-01T04:00:00.000Z');

  assert.equal(
    classifyMembershipExpiry(localMidnight(2026, 2, 28, timeZone), now, timeZone).status,
    'expired'
  );
  assert.equal(
    classifyMembershipExpiry(localMidnight(2026, 3, 1, timeZone), now, timeZone).status,
    'today'
  );
  assert.equal(
    classifyMembershipExpiry(localMidnight(2026, 3, 8, timeZone), now, timeZone).status,
    'expiringSoon'
  );
  assert.equal(
    classifyMembershipExpiry(localMidnight(2026, 3, 9, timeZone), now, timeZone).status,
    'active'
  );
});

test('membership expiry windows and renewal periods respect daylight-saving local midnights', () => {
  const timeZone = 'America/New_York';
  const now = new Date('2026-03-08T12:00:00.000Z');
  const window = getMembershipExpiryWindow(now, timeZone);
  const expectedStart = localMidnight(2026, 3, 8, timeZone);
  const expectedTomorrow = localMidnight(2026, 3, 9, timeZone);

  assert.equal(window.todayStart.toISOString(), expectedStart.toISOString());
  assert.equal(window.tomorrowStart.toISOString(), expectedTomorrow.toISOString());
  assert.equal((window.tomorrowStart - window.todayStart) / 3600000, 23);

  const start = localMidnight(2026, 3, 8, timeZone);
  const end = addMembershipDuration(start, 1, 'Days', timeZone);
  assert.equal(end.toISOString(), expectedTomorrow.toISOString());
});

test('membership start dates are parsed as local dates rather than UTC date boundaries', () => {
  const parsed = require('../utils/membershipExpiry').parseMembershipStartDate(
    '2026-03-01',
    'Asia/Kolkata'
  );
  assert.equal(parsed.toISOString(), '2026-02-28T18:30:00.000Z');
});

test('expiry aggregation is tenant-scoped, deduplicates members and pages filtered rows', () => {
  const tenantId = 'tenant-a';
  const businessId = 'tenant-a';
  const pipeline = createMembershipExpiryPipeline({
    tenantId,
    businessId,
    window: {
      todayStart: new Date('2026-03-01T00:00:00.000Z'),
      tomorrowStart: new Date('2026-03-02T00:00:00.000Z'),
      next8DayStart: new Date('2026-03-09T00:00:00.000Z')
    },
    category: 'all',
    search: 'A.*',
    planId: 'plan-a',
    page: 3,
    limit: 10,
    sort: 'desc'
  });

  assert.deepEqual(pipeline[0].$match, {
    tenantId,
    businessId,
    status: { $in: ['Active', 'Expired'] }
  });
  assert.deepEqual(pipeline[3].$group, {
    _id: '$memberId',
    membership: { $first: '$$ROOT' }
  });
  const facets = pipeline.at(-1).$facet;
  assert.equal(facets.records[0].$match.planId, 'plan-a');
  assert.equal(facets.records[1].$sort.endDate, -1);
  assert.equal(facets.records[2].$skip, 20);
  assert.equal(facets.records[3].$limit, 10);
  assert.equal(facets.records[0].$match.$or[0]['member.fullName'].source, 'A\\.\\*');
});
