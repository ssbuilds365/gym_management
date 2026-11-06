const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const {
  PASSWORD_RESET_TTL_MS,
  hashResetToken,
  requestPasswordReset,
  findValidPasswordReset,
  resetOwnerPassword
} = require('../services/passwordReset');
const {
  createPasswordResetEmail,
  sendPasswordResetEmail
} = require('../services/passwordResetEmail');

const smtp = {
  host: 'smtp.example.test',
  port: 587,
  user: 'sender@example.test',
  pass: 'smtp-test-secret',
  from: 'SS Fitness Manager <sender@example.test>'
};

const createHarness = async () => {
  const owner = {
    _id: 'owner-a',
    tenantId: 'tenant-a',
    email: 'owner@example.test',
    name: 'Owner',
    isActive: true,
    password: await bcrypt.hash('OldPassword1!', 4),
    passwordChangedAt: null
  };
  const sessions = [
    { ownerId: owner._id, tenantId: owner.tenantId, revokedAt: null },
    { ownerId: owner._id, tenantId: owner.tenantId, revokedAt: null },
    { ownerId: 'owner-b', tenantId: 'tenant-b', revokedAt: null }
  ];
  const records = [];
  const audits = [];
  let transactionEnded = false;
  const ownerModel = {
    findOne: (filter) => ({
      select: async () => filter._id
        ? filter._id === owner._id && filter.tenantId === owner.tenantId &&
          filter.isActive === true ? owner : null
        : filter.email === owner.email && filter.isActive === true ? owner : null
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
  const resetTokenModel = {
    create: async data => {
      const record = { ...data, _id: `reset-${records.length + 1}`, usedAt: null };
      records.push(record);
      return record;
    },
    findOne: filter => ({
      select: async () => records.find(record =>
        record.tokenHash === filter.tokenHash &&
        record.usedAt === filter.usedAt &&
        record.expiresAt > filter.expiresAt.$gt
      ) || null
    }),
    updateOne: async (filter, update, options = {}) => {
      if (options.session) assert.ok(options.session);
      const record = records.find(item =>
        item._id === filter._id &&
        (filter.tokenHash === undefined || item.tokenHash === filter.tokenHash) &&
        (filter.ownerId === undefined || item.ownerId === filter.ownerId) &&
        (filter.tenantId === undefined || item.tenantId === filter.tenantId) &&
        (filter.usedAt === undefined || item.usedAt === filter.usedAt) &&
        (!filter.expiresAt || item.expiresAt > filter.expiresAt.$gt)
      );
      if (!record) return { matchedCount: 0 };
      Object.assign(record, update.$set);
      return { matchedCount: 1 };
    },
    updateMany: async (filter, update, options = {}) => {
      if (options.session) assert.ok(options.session);
      for (const record of records) {
        if (
          (filter.ownerId === undefined || record.ownerId === filter.ownerId) &&
          (filter.tenantId === undefined || record.tenantId === filter.tenantId) &&
          (filter.usedAt === undefined || record.usedAt === filter.usedAt)
        ) Object.assign(record, update.$set);
      }
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
        ) Object.assign(session, update.$set);
      }
    }
  };
  const auditModel = {
    create: async (items, options) => {
      assert.ok(options.session);
      audits.push(...items);
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
    records,
    audits,
    get transactionEnded() { return transactionEnded; },
    dependencies: { ownerModel, resetTokenModel, sessionModel, auditModel, mongooseInstance }
  };
};

test('forgot password stores only a hashed, expiring token and emails the reset URL', async () => {
  const harness = await createHarness();
  const now = new Date('2026-11-05T00:00:00.000Z');
  let emailPayload;
  const result = await requestPasswordReset({
    email: harness.owner.email,
    frontendUrl: 'https://gym.example.test',
    nodeEnv: 'production',
    smtp,
    now,
    emailSender: async payload => { emailPayload = payload; },
    ownerModel: harness.dependencies.ownerModel,
    resetTokenModel: harness.dependencies.resetTokenModel
  });
  const resetUrl = new URL(emailPayload.resetUrl);
  const rawToken = resetUrl.searchParams.get('token');

  assert.deepEqual(result, { success: true });
  assert.equal(resetUrl.origin, 'https://gym.example.test');
  assert.equal(resetUrl.pathname, '/reset-password');
  assert.match(rawToken, /^[a-f0-9]{64}$/);
  assert.equal(harness.records[0].tokenHash, hashResetToken(rawToken));
  assert.equal(harness.records[0].tokenHash.includes(rawToken), false);
  assert.equal(harness.records[0].expiresAt.getTime(), now.getTime() + PASSWORD_RESET_TTL_MS);
});

test('unknown email receives the same generic service result without creating a token', async () => {
  const harness = await createHarness();
  let emailSent = false;
  const result = await requestPasswordReset({
    email: 'unknown@example.test',
    smtp,
    frontendUrl: 'http://localhost:4200',
    ownerModel: harness.dependencies.ownerModel,
    resetTokenModel: harness.dependencies.resetTokenModel,
    emailSender: async () => { emailSent = true; }
  });

  assert.deepEqual(result, { success: true });
  assert.equal(emailSent, false);
  assert.equal(harness.records.length, 0);
});

test('production reset links reject non-HTTPS frontend configuration before owner lookup', async () => {
  const harness = await createHarness();
  let queriedOwners = false;
  await assert.rejects(requestPasswordReset({
    email: harness.owner.email,
    smtp,
    frontendUrl: 'http://gym.example.test',
    nodeEnv: 'production',
    ownerModel: {
      findOne: () => {
        queriedOwners = true;
        throw new Error('owner lookup must not happen');
      }
    },
    resetTokenModel: harness.dependencies.resetTokenModel,
    emailSender: async () => {}
  }), error => error.code === 'RESET_URL_MUST_USE_HTTPS');
  assert.equal(queriedOwners, false);
});

test('email failure invalidates the generated reset token and reports delivery failure', async () => {
  const harness = await createHarness();
  await assert.rejects(requestPasswordReset({
    email: harness.owner.email,
    smtp,
    frontendUrl: 'http://localhost:4200',
    ownerModel: harness.dependencies.ownerModel,
    resetTokenModel: harness.dependencies.resetTokenModel,
    emailSender: async () => { throw new Error('private smtp detail'); }
  }), error => error.code === 'PASSWORD_RESET_EMAIL_DELIVERY_FAILED');

  assert.equal(harness.records.length, 1);
  assert.ok(harness.records[0].usedAt instanceof Date);
});

test('password reset rejects expired and reused tokens', async () => {
  const harness = await createHarness();
  const expired = {
    _id: 'expired',
    ownerId: harness.owner._id,
    tenantId: harness.owner.tenantId,
    tokenHash: hashResetToken('a'.repeat(64)),
    expiresAt: new Date(Date.now() - 1000),
    usedAt: null
  };
  harness.records.push(expired);
  assert.equal(await findValidPasswordReset({
    token: 'a'.repeat(64),
    resetTokenModel: harness.dependencies.resetTokenModel
  }), null);

  const rawToken = 'b'.repeat(64);
  harness.records.push({
    _id: 'used',
    ownerId: harness.owner._id,
    tenantId: harness.owner.tenantId,
    tokenHash: hashResetToken(rawToken),
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: new Date()
  });
  assert.equal(await findValidPasswordReset({
    token: rawToken,
    resetTokenModel: harness.dependencies.resetTokenModel
  }), null);
});

test('valid reset changes password once and revokes sessions only for that owner', async () => {
  const harness = await createHarness();
  const rawToken = 'c'.repeat(64);
  const now = new Date('2026-11-05T00:00:00.000Z');
  harness.records.push({
    _id: 'valid',
    ownerId: harness.owner._id,
    tenantId: harness.owner.tenantId,
    tokenHash: hashResetToken(rawToken),
    expiresAt: new Date(now.getTime() + 60_000),
    usedAt: null
  });

  const result = await resetOwnerPassword({
    token: rawToken,
    newPassword: 'NewPassword2!',
    now,
    ...harness.dependencies
  });

  assert.deepEqual(result, { success: true });
  assert.equal(await bcrypt.compare('OldPassword1!', harness.owner.password), false);
  assert.equal(await bcrypt.compare('NewPassword2!', harness.owner.password), true);
  assert.equal(harness.records[0].usedAt, now);
  assert.ok(harness.sessions.slice(0, 2).every(
    session => session.revokedAt === now && session.revokedReason === 'password_changed'
  ));
  assert.equal(harness.sessions[2].revokedAt, null);
  assert.equal(harness.audits[0].action, 'PASSWORD_RESET');
  assert.equal(harness.audits[0].ownerId, harness.owner._id);
  assert.equal(JSON.stringify(harness.audits).includes('NewPassword2!'), false);
  assert.equal(harness.transactionEnded, true);
  assert.deepEqual(await resetOwnerPassword({
    token: rawToken,
    newPassword: 'AnotherPassword3!',
    now,
    ...harness.dependencies
  }), { error: 'RESET_TOKEN_INVALID' });
});

test('reset email is branded and SMTP credentials remain transport-only', async () => {
  const content = createPasswordResetEmail({
    resetUrl: 'https://gym.example.test/reset-password?token=abc',
    ownerName: '<Owner>'
  });
  assert.equal(content.subject, 'Reset Your SS Fitness Manager Password');
  assert.match(content.html, /SS FITNESS/);
  assert.match(content.html, /15 minutes/);
  assert.match(content.html, /&lt;Owner&gt;/);
  assert.match(content.text, /ignore this email/);

  let transportConfig;
  let sentMessage;
  await sendPasswordResetEmail({
    email: 'owner@example.test',
    ownerName: 'Owner',
    resetUrl: 'https://gym.example.test/reset-password?token=secret',
    smtp: { ...smtp, port: 465 },
    createTransport: settings => {
      transportConfig = settings;
      return { sendMail: async message => { sentMessage = message; } };
    }
  });
  assert.equal(transportConfig.secure, true);
  assert.deepEqual(transportConfig.auth, { user: smtp.user, pass: smtp.pass });
  assert.equal(sentMessage.to, 'owner@example.test');
  assert.equal(sentMessage.from, smtp.from);
});
