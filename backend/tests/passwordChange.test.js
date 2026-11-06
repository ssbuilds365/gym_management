const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const {
  changeOwnerPassword,
  validatePasswordChangeInput
} = require('../services/passwordChange');

const createHarness = async () => {
  const owner = {
    _id: 'owner-a',
    tenantId: 'tenant-a',
    isActive: true,
    password: await bcrypt.hash('OldPassword1!', 4),
    passwordChangedAt: null
  };
  const sessions = [
    { ownerId: 'owner-a', tenantId: 'tenant-a', revokedAt: null, revokedReason: null },
    { ownerId: 'owner-a', tenantId: 'tenant-a', revokedAt: null, revokedReason: null },
    { ownerId: 'owner-b', tenantId: 'tenant-b', revokedAt: null, revokedReason: null }
  ];
  const audits = [];
  let transactionEnded = false;
  const ownerModel = {
    findOne: filter => ({
      select: async () => filter._id === owner._id && filter.tenantId === owner.tenantId && owner.isActive
        ? owner
        : null
    }),
    updateOne: async (filter, update, options) => {
      assert.ok(options.session);
      if (
        filter._id !== owner._id ||
        filter.tenantId !== owner.tenantId ||
        filter.password !== owner.password
      ) return { matchedCount: 0 };
      Object.assign(owner, update.$set);
      return { matchedCount: 1 };
    }
  };
  const sessionModel = {
    updateMany: async (filter, update, options) => {
      assert.ok(options.session);
      for (const session of sessions) {
        if (
          session.ownerId === filter.ownerId &&
          session.tenantId === filter.tenantId &&
          session.revokedAt === filter.revokedAt
        ) {
          Object.assign(session, update.$set);
        }
      }
    }
  };
  const auditModel = {
    create: async (records, options) => {
      assert.ok(options.session);
      audits.push(...records);
    }
  };
  const mongooseInstance = {
    startSession: async () => ({
      withTransaction: async callback => callback(),
      endSession: async () => { transactionEnded = true; }
    })
  };

  return {
    owner,
    sessions,
    audits,
    get transactionEnded() { return transactionEnded; },
    dependencies: { ownerModel, sessionModel, auditModel, mongooseInstance }
  };
};

test('password change validation rejects missing, weak, and mismatched input', () => {
  assert.match(validatePasswordChangeInput({
    currentPassword: '',
    newPassword: 'new-password',
    confirmPassword: 'new-password'
  }), /required/);
  assert.match(validatePasswordChangeInput({
    currentPassword: 'current-password',
    newPassword: 'weak',
    confirmPassword: 'weak'
  }), /at least 8/);
  assert.match(validatePasswordChangeInput({
    currentPassword: 'current-password',
    newPassword: 'new-password',
    confirmPassword: 'different-password'
  }), /do not match/);
  assert.equal(validatePasswordChangeInput({
    currentPassword: 'current-password',
    newPassword: 'new-password',
    confirmPassword: 'new-password'
  }), '');
});

test('password change rejects an incorrect current password without mutations', async () => {
  const harness = await createHarness();
  const previousHash = harness.owner.password;
  const result = await changeOwnerPassword({
    ownerId: 'owner-a',
    tenantId: 'tenant-a',
    currentPassword: 'wrong-password',
    newPassword: 'NewPassword2!',
    ...harness.dependencies
  });

  assert.equal(result.error, 'CURRENT_PASSWORD_INVALID');
  assert.equal(harness.owner.password, previousHash);
  assert.equal(harness.audits.length, 0);
  assert.ok(harness.sessions.every(session => session.revokedAt === null));
});

test('password change updates only the authenticated owner and revokes their sessions', async () => {
  const harness = await createHarness();
  const changedAt = new Date('2026-11-05T00:00:00.000Z');
  const result = await changeOwnerPassword({
    ownerId: 'owner-a',
    tenantId: 'tenant-a',
    currentPassword: 'OldPassword1!',
    newPassword: 'NewPassword2!',
    now: changedAt,
    ...harness.dependencies
  });

  assert.deepEqual(result, { success: true });
  assert.equal(await bcrypt.compare('OldPassword1!', harness.owner.password), false);
  assert.equal(await bcrypt.compare('NewPassword2!', harness.owner.password), true);
  assert.equal(harness.owner.passwordChangedAt, changedAt);
  assert.ok(harness.sessions.slice(0, 2).every(
    session => session.revokedAt === changedAt && session.revokedReason === 'password_changed'
  ));
  assert.equal(harness.sessions[2].revokedAt, null);
  assert.deepEqual(harness.audits, [{
    ownerId: 'owner-a',
    tenantId: 'tenant-a',
    action: 'PASSWORD_CHANGED',
    occurredAt: changedAt
  }]);
  assert.equal(JSON.stringify(harness.audits).includes('NewPassword2!'), false);
  assert.equal(harness.transactionEnded, true);
});

test('password change cannot load or modify an owner from another tenant', async () => {
  const harness = await createHarness();
  const result = await changeOwnerPassword({
    ownerId: 'owner-a',
    tenantId: 'tenant-b',
    currentPassword: 'OldPassword1!',
    newPassword: 'NewPassword2!',
    ...harness.dependencies
  });

  assert.equal(result.error, 'OWNER_UNAVAILABLE');
  assert.equal(await bcrypt.compare('OldPassword1!', harness.owner.password), true);
  assert.equal(harness.audits.length, 0);
  assert.ok(harness.sessions.every(session => session.revokedAt === null));
});
