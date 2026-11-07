const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_EXPENSE_CATEGORIES,
  deriveExpenseStatus,
  parseExpenseDate,
  serializeExpense,
  toMinorUnits
} = require('../utils/expenses');
const {
  buildExpenseFilter,
  csvCell,
  validateCreateExpense
} = require('../controllers/expenseController');

test('expense amounts use integer minor units and reject invalid precision', () => {
  assert.equal(toMinorUnits('125.50'), 12550);
  assert.equal(toMinorUnits('125.555'), null);
  assert.equal(toMinorUnits('0'), null);
  assert.equal(toMinorUnits('-1'), null);
  assert.equal(toMinorUnits('not-money'), null);
});

test('expense status is derived from recorded paid amount', () => {
  assert.equal(deriveExpenseStatus(10000, 0), 'PENDING');
  assert.equal(deriveExpenseStatus(10000, 4200), 'PARTIALLY_PAID');
  assert.equal(deriveExpenseStatus(10000, 10000), 'PAID');
});

test('expense serialization exposes receipt metadata but not private Cloudinary identifiers', () => {
  const result = serializeExpense({
    amountMinor: 1250,
    paidAmountMinor: 0,
    payments: [],
    receipt: {
      publicId: 'private/tenant/asset',
      resourceType: 'raw',
      format: 'pdf',
      originalName: 'invoice.pdf',
      uploadedAt: new Date('2026-11-06T00:00:00Z')
    }
  });
  assert.equal(result.receipt.originalName, 'invoice.pdf');
  assert.equal(result.receipt.publicId, undefined);
  assert.equal(result.receipt.url, undefined);
});

test('expense date parsing uses the business local calendar date', () => {
  assert.equal(
    parseExpenseDate('2026-03-08', 'America/Los_Angeles').toISOString(),
    '2026-03-08T08:00:00.000Z'
  );
  assert.equal(parseExpenseDate('2026-02-30', 'Asia/Kolkata'), null);
});

test('new expenses start pending and do not fabricate payment records', () => {
  const ownerId = '507f1f77bcf86cd799439011';
  const base = {
    title: 'Electricity',
    category: DEFAULT_EXPENSE_CATEGORIES[1],
    amount: '1200.00',
    expenseDate: '2026-11-06',
    paymentMethod: 'UPI'
  };
  const pending = validateCreateExpense({ ...base, status: 'PENDING' }, 'Asia/Kolkata', ownerId);
  assert.equal(pending.error, undefined);
  assert.equal(pending.data.paidAmountMinor, 0);
  assert.equal(pending.data.payments.length, 0);

  const paid = validateCreateExpense({ ...base, status: 'PAID', paidAmount: base.amount }, 'Asia/Kolkata', ownerId);
  assert.equal(paid.error, undefined);
  assert.equal(paid.data.status, 'PENDING');
  assert.equal(paid.data.paidAmountMinor, 0);
  assert.equal(paid.data.payments.length, 0);

  const partial = validateCreateExpense({
    ...base,
    status: 'PARTIALLY_PAID',
    paidAmount: '400.25'
  }, 'Asia/Kolkata', ownerId);
  assert.equal(partial.error, undefined);
  assert.equal(partial.data.status, 'PENDING');
  assert.equal(partial.data.paidAmountMinor, 0);
  assert.equal(partial.data.payments.length, 0);
});

test('expense creation does not accept a client-supplied payment status as proof of payment', () => {
  const result = validateCreateExpense({
    title: 'Repair',
    category: 'Equipment Repair',
    amount: 100,
    expenseDate: '2026-11-06',
    status: 'PARTIALLY_PAID',
    paidAmount: 100
  }, 'Asia/Kolkata', 'owner-1');
  assert.equal(result.error, undefined);
  assert.equal(result.data.status, 'PENDING');
  assert.equal(result.data.paidAmountMinor, 0);
});

test('expense filters always scope to authenticated tenant and business', () => {
  const tenantId = 'tenant-from-auth';
  const businessId = 'business-from-auth';
  const filter = buildExpenseFilter({
    tenantId,
    businessId,
    query: { search: 'rent', category: 'Rent', status: 'PENDING' },
    range: { from: new Date('2026-11-01T00:00:00Z'), toExclusive: new Date('2026-12-01T00:00:00Z') }
  });

  test('active and archived expense filters include both archive schemas without losing tenant scope', () => {
    const base = { tenantId: 'authenticated-tenant', businessId: 'authenticated-business' };
    const active = buildExpenseFilter({ ...base, query: {}, range: null });
    assert.equal(active.archivedAt, null);
    assert.equal(active.deletedAt, null);

    const archived = buildExpenseFilter({ ...base, query: { archived: 'true' }, range: null });
    assert.equal(archived.tenantId, base.tenantId);
    assert.equal(archived.businessId, base.businessId);
    assert.equal(archived.$and[0].$or.length, 2);
  });
  assert.equal(filter.tenantId, tenantId);
  assert.equal(filter.businessId, businessId);
  assert.equal(filter.category, 'Rent');
  assert.equal(filter.status, 'PENDING');
  assert.equal(filter.expenseDate.$gte.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(filter.expenseDate.$lt.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.ok(filter.$or.length > 0);
});

test('CSV export escapes cells and neutralizes spreadsheet formulas', () => {
  assert.equal(csvCell('Gym, North'), '"Gym, North"');
  assert.equal(csvCell('=HYPERLINK("https://example.test")'), `"'=HYPERLINK(""https://example.test"")"`);
});
