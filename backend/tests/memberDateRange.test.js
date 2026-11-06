const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMemberDateRange } = require('../utils/memberDateRange');

test('member date range allows an omitted filter', () => {
  assert.deepEqual(parseMemberDateRange(undefined, undefined), { range: null });
});

test('member date range uses inclusive start and exclusive end', () => {
  const result = parseMemberDateRange(
    '2026-01-01T00:00:00.000Z',
    '2026-02-01T00:00:00.000Z'
  );

  assert.equal(result.range.$gte.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(result.range.$lt.toISOString(), '2026-02-01T00:00:00.000Z');
});

test('member date range rejects missing, malformed, and reversed boundaries', () => {
  assert.ok(parseMemberDateRange('2026-01-01T00:00:00.000Z').error);
  assert.ok(parseMemberDateRange('not-a-date', '2026-02-01T00:00:00.000Z').error);
  assert.ok(parseMemberDateRange(
    '2026-02-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  ).error);
});
