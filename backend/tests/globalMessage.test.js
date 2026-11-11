const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIndianMobile, campaignSummary } = require('../utils/globalMessage');

test('normalizes supported Indian mobile formats and rejects invalid numbers', () => {
  assert.equal(normalizeIndianMobile('9876543210'), '919876543210');
  assert.equal(normalizeIndianMobile('+91 98765-43210'), '919876543210');
  assert.equal(normalizeIndianMobile('09876543210'), '919876543210');
  assert.equal(normalizeIndianMobile('12345'), '');
  assert.equal(normalizeIndianMobile('0123456789'), '');
});

test('keeps chat-opened separate from manually marked sent and pending', () => {
  const summary = campaignSummary([
    { status: 'PENDING' },
    { status: 'WHATSAPP_OPENED' },
    { status: 'MANUALLY_MARKED_SENT', whatsappOpenedAt: new Date() },
    { status: 'SKIPPED' },
    { status: 'INVALID_NUMBER' }
  ]);
  assert.deepEqual(summary, {
    totalRecipients: 5,
    whatsappOpened: 2,
    manuallyMarkedSent: 1,
    skipped: 1,
    invalidNumber: 1,
    pending: 2
  });
});
