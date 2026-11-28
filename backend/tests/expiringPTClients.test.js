const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getExpiringPTWindow,
  getRemainingDays
} = require('../utils/expiringPTClients');

test('PT expiry window includes today through the fifth calendar day', () => {
  const now = new Date('2026-11-28T08:00:00.000Z');
  const window = getExpiringPTWindow(now, 'Asia/Kolkata');

  assert.equal(window.todayDate, '2026-11-28');
  assert.equal(getRemainingDays(new Date('2026-12-03T00:30:00.000Z'), now, 'Asia/Kolkata'), 5);
  assert.equal(getRemainingDays(new Date('2026-11-28T00:30:00.000Z'), now, 'Asia/Kolkata'), 0);
  assert.equal(getRemainingDays(new Date('2026-11-27T00:30:00.000Z'), now, 'Asia/Kolkata'), -1);
});
