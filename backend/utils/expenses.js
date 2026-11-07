const { parseMembershipStartDate } = require('./membershipExpiry');

const DEFAULT_EXPENSE_CATEGORIES = Object.freeze([
  'Rent',
  'Electricity',
  'Water Bill',
  'Internet',
  'Gym Maintenance',
  'Equipment Purchase',
  'Equipment Repair',
  'Staff Salary',
  'Trainer Salary',
  'Cleaning',
  'Housekeeping',
  'Marketing & Advertising',
  'Software & Subscriptions',
  'Licenses & Compliance',
  'Office Supplies',
  'Miscellaneous'
]);

const PAYMENT_METHODS = Object.freeze([
  'Cash',
  'UPI',
  'Bank Transfer',
  'Card',
  'Other'
]);

const toMinorUnits = value => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000) return null;
  const rounded = Math.round(amount * 100);
  if (Math.abs(amount * 100 - rounded) > 0.000001) return null;
  return rounded;
};

const deriveExpenseStatus = (amountMinor, paidAmountMinor) => {
  if (paidAmountMinor >= amountMinor) return 'PAID';
  return paidAmountMinor > 0 ? 'PARTIALLY_PAID' : 'PENDING';
};

const parseExpenseDate = (value, timeZone) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return parseMembershipStartDate(value, timeZone);
};

const expenseSnapshot = expense => ({
  title: expense.title,
  category: expense.category,
  amountMinor: expense.amountMinor,
  paidAmountMinor: expense.paidAmountMinor,
  status: expense.status,
  expenseDate: expense.expenseDate,
  vendor: expense.vendor,
  invoiceNumber: expense.invoiceNumber,
  transactionReference: expense.transactionReference,
  description: expense.description,
  paymentMethod: expense.paymentMethod,
  payments: (expense.payments || []).map(payment => ({
    amountMinor: payment.amountMinor,
    paymentMethod: payment.paymentMethod,
    paidAt: payment.paidAt,
    reference: payment.reference,
    notes: payment.notes,
    requestId: payment.requestId,
    recordedBy: payment.recordedBy
  })),
  dueDate: expense.dueDate,
  notes: expense.notes,
  archivedAt: expense.archivedAt,
  receipt: expense.receipt
});

const serializeExpense = expense => ({
  _id: expense._id,
  title: expense.title,
  category: expense.category,
  amount: expense.amountMinor / 100,
  paidAmount: expense.paidAmountMinor / 100,
  outstandingAmount: Math.max(0, expense.amountMinor - expense.paidAmountMinor) / 100,
  status: expense.status,
  paymentMethod: expense.paymentMethod,
  expenseDate: expense.expenseDate,
  vendor: expense.vendor,
  invoiceNumber: expense.invoiceNumber,
  transactionReference: expense.transactionReference,
  description: expense.description,
  notes: expense.notes || '',
  dueDate: expense.dueDate || null,
  receipt: expense.receipt?.publicId
    ? {
        originalName: expense.receipt.originalName,
        uploadedAt: expense.receipt.uploadedAt
      }
    : null,
  archivedAt: expense.archivedAt || expense.deletedAt || null,
  payments: (expense.payments || []).map(payment => ({
    _id: payment._id,
    amount: payment.amountMinor / 100,
    paymentMethod: payment.paymentMethod,
    paidAt: payment.paidAt,
    reference: payment.reference,
    notes: payment.notes,
    recordedBy: payment.recordedBy
  })),
  createdAt: expense.createdAt,
  updatedAt: expense.updatedAt
});

module.exports = {
  DEFAULT_EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  deriveExpenseStatus,
  expenseSnapshot,
  parseExpenseDate,
  serializeExpense,
  toMinorUnits
};
