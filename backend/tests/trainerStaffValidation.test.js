const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTrainerStaffRecord } = require('../controllers/trainerStaffController');

test('trainer and staff validation normalizes profile data and compensation', () => {
  const result = validateTrainerStaffRecord({
    name: '  Alex Trainer ',
    phone: '+1 (415) 555-0132',
    email: 'ALEX@EXAMPLE.COM ',
    role: 'Trainer',
    specialization: '  Strength ',
    maxClientCapacity: '24',
    joiningDate: '2026-04-15',
    salaryAmount: '1250.50',
    compensationType: 'Commission',
    status: 'Active'
  }, true);

  assert.equal(result.error, undefined);
  assert.equal(result.data.name, 'Alex Trainer');
  assert.equal(result.data.phone, '+1 (415) 555-0132');
  assert.equal(result.data.email, 'alex@example.com');
  assert.equal(result.data.specialization, 'Strength');
  assert.equal(result.data.maxClientCapacity, 24);
  assert.equal(result.data.salaryAmount, 1250.5);
  assert.equal(result.data.compensationType, 'Commission');
  assert.equal(result.data.joiningDate.toISOString(), '2026-04-15T00:00:00.000Z');
});

test('trainer and staff validation rejects malformed contact and compensation fields', () => {
  assert.equal(
    validateTrainerStaffRecord({ name: 'Person', phone: '12', role: 'Staff' }, true).error,
    'Enter a valid phone number'
  );
  assert.equal(
    validateTrainerStaffRecord({ email: 'not-an-email' }, false).error,
    'Enter a valid email address'
  );
  assert.equal(
    validateTrainerStaffRecord({ salaryAmount: -1 }, false).error,
    'Salary or commission must be a non-negative amount'
  );
  assert.equal(
    validateTrainerStaffRecord({ joiningDate: 'not-a-date' }, false).error,
    'Enter a valid joining date'
  );
  assert.equal(
    validateTrainerStaffRecord({ maxClientCapacity: 0 }, false).error,
    'Maximum client capacity must be a positive whole number'
  );
  assert.equal(
    validateTrainerStaffRecord({ maxClientCapacity: 1.5 }, false).error,
    'Maximum client capacity must be a positive whole number'
  );
});
