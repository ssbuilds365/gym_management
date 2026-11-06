const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveReportPeriod } = require('../utils/reportPeriods');

test('report periods resolve gym-local calendar dates and week boundaries', () => {
  const now = new Date('2026-11-04T12:00:00.000Z');
  const today = resolveReportPeriod({ period: 'today', timezone: 'Asia/Kolkata' }, now);
  assert.equal(today.fromDate, '2026-11-04');
  assert.equal(today.toDate, '2026-11-04');
  assert.equal(today.from.toISOString(), '2026-11-03T18:30:00.000Z');
  assert.equal(today.toExclusive.toISOString(), '2026-11-04T18:30:00.000Z');

  const week = resolveReportPeriod({ period: 'week', timezone: 'Asia/Kolkata' }, now);
  assert.equal(week.fromDate, '2026-11-02');
  assert.equal(week.toDate, '2026-11-04');
});

test('custom report periods validate dates and include the full last calendar day', () => {
  const range = resolveReportPeriod({
    period: 'custom',
    from: '2026-02-01',
    to: '2026-02-28',
    timezone: 'Asia/Kolkata'
  });
  assert.equal(range.fromDate, '2026-02-01');
  assert.equal(range.toDate, '2026-02-28');
  assert.equal(range.toExclusive.toISOString(), '2026-02-28T18:30:00.000Z');
  assert.equal(resolveReportPeriod({ period: 'custom', from: '2026-02-30', to: '2026-03-01' }), null);
});

test('calendar-day reporting handles daylight-saving boundaries', () => {
  const range = resolveReportPeriod({
    period: 'custom',
    from: '2026-03-08',
    to: '2026-03-08',
    timezone: 'America/New_York'
  });
  assert.equal(range.from.toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(range.toExclusive.toISOString(), '2026-03-09T04:00:00.000Z');
  assert.equal(range.fromDate, '2026-03-08');
});

test('date range rejects reversed and overlong custom periods', () => {
  assert.equal(resolveReportPeriod({
    period: 'custom',
    from: '2026-02-02',
    to: '2026-02-01'
  }), null);
  assert.equal(resolveReportPeriod({
    period: 'custom',
    from: '2024-01-01',
    to: '2025-01-02'
  }), null);
});
