const test = require('node:test');
const assert = require('node:assert/strict');
const { getDashboardPeriods } = require('../utils/dashboardPeriods');

test('dashboard periods use gym-local calendar day, Monday week and 12 months', () => {
  const now = new Date('2026-03-01T04:00:00.000Z');
  const periods = getDashboardPeriods(now, 'Asia/Kolkata');

  assert.equal(periods.todayStart.toISOString(), '2026-02-28T18:30:00.000Z');
  assert.equal(periods.tomorrowStart.toISOString(), '2026-03-01T18:30:00.000Z');
  assert.equal(periods.weekStart.toISOString(), '2026-02-22T18:30:00.000Z');
  assert.equal(periods.monthStart.toISOString(), '2026-02-28T18:30:00.000Z');
  assert.equal(periods.months.length, 12);
  assert.equal(periods.months[0].key, '2025-04');
  assert.equal(periods.months.at(-1).key, '2026-03');
});

test('dashboard day boundaries account for daylight-saving transitions', () => {
  const periods = getDashboardPeriods(
    new Date('2026-03-08T12:00:00.000Z'),
    'America/New_York'
  );

  assert.equal(periods.todayStart.toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(periods.tomorrowStart.toISOString(), '2026-03-09T04:00:00.000Z');
  assert.equal(
    (periods.tomorrowStart - periods.todayStart) / 3_600_000,
    23
  );
  assert.equal(periods.weekStart.toISOString(), '2026-03-02T05:00:00.000Z');
});
