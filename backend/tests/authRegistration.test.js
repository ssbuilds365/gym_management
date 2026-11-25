process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/ssfm-auth-registration-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const Owner = require('../models/Owner');
const Business = require('../models/Business');
const OwnerSession = require('../models/OwnerSession');
const { registerOwner } = require('../controllers/authController');

const validRegistration = () => ({
  name: '  Test Owner  ',
  email: '  OWNER@example.com ',
  phone: '9876543210',
  password: 'secure-password',
  businessName: '  Test Gym  ',
  businessType: 'Gym',
  address: '  Test Address  '
});

const makeResponse = () => ({
  statusCode: 200,
  body: null,
  cookieName: '',
  cookieValue: '',
  cookieSettings: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
  cookie(name, value, settings) {
    this.cookieName = name;
    this.cookieValue = value;
    this.cookieSettings = settings;
  }
});

const makeRequest = body => ({
  body,
  get: () => 'Registration test'
});

const mockSuccessfulCreation = (t, {
  ownerLookup,
  ownerCreate,
  sessionFailure,
  ownerDelete = async () => null,
  businessDelete = async () => null
} = {}) => {
  const created = { business: null, owner: null, session: null };
  t.mock.method(Owner, 'findOne', async query => {
    if (ownerLookup) return ownerLookup(query);
    return null;
  });
  t.mock.method(bcrypt, 'hash', async () => 'hashed-password');
  t.mock.method(Business, 'create', async data => {
    created.business = { ...data, _id: 'business-id' };
    return created.business;
  });
  t.mock.method(Owner, 'create', ownerCreate || (async data => {
    created.owner = {
      ...data,
      _id: 'owner-id',
      businessId: data.businessId,
      tenantId: data.tenantId,
      role: 'owner'
    };
    return created.owner;
  }));
  t.mock.method(OwnerSession, 'create', async data => {
    if (sessionFailure) throw sessionFailure;
    created.session = {
      ...data,
      _id: 'session-id',
      createdAt: new Date('2025-01-01T00:00:00.000Z')
    };
    return created.session;
  });
  created.deleteOwner = t.mock.method(Owner, 'findByIdAndDelete', ownerDelete);
  created.deleteBusiness = t.mock.method(Business, 'findByIdAndDelete', businessDelete);
  return created;
};

test('registerOwner creates a normalized account and issues a session', async t => {
  const created = mockSuccessfulCreation(t);
  const res = makeResponse();

  await registerOwner(makeRequest(validRegistration()), res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.owner.email, 'owner@example.com');
  assert.equal(res.body.business.businessName, 'Test Gym');
  assert.equal(created.business.ownerName, 'Test Owner');
  assert.equal(created.business.phone, '9876543210');
  assert.equal(created.owner.phone, '9876543210');
  assert.equal(created.owner.password, 'hashed-password');
  assert.equal(res.cookieName, 'ssfm_session');
  assert.equal(res.body.session.id, 'session-id');
});

test('registerOwner rejects duplicate email and mobile before creating records', async t => {
  const duplicateCases = [
    {
      name: 'email',
      ownerLookup: query => query.email
        ? { _id: 'existing-owner' }
        : null,
      message: 'An account with this email already exists'
    },
    {
      name: 'mobile',
      ownerLookup: query => query.phone
        ? { _id: 'existing-owner' }
        : null,
      message: 'An account with this mobile number already exists'
    }
  ];

  for (const duplicateCase of duplicateCases) {
    await t.test(duplicateCase.name, async t => {
      const created = mockSuccessfulCreation(t, {
        ownerLookup: duplicateCase.ownerLookup
      });
      const res = makeResponse();

      await registerOwner(makeRequest(validRegistration()), res);

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.message, duplicateCase.message);
      assert.equal(created.business, null);
      assert.equal(created.owner, null);
    });
  }
});

test('registerOwner rejects malformed phone numbers before database writes', async t => {
  const created = mockSuccessfulCreation(t);
  const res = makeResponse();

  await registerOwner(makeRequest({
    ...validRegistration(),
    phone: 'not-a-mobile'
  }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'Please enter a valid 10-digit mobile number');
  assert.equal(created.business, null);
  assert.equal(created.owner, null);
});

test('registerOwner maps duplicate-key races to conflict and rolls back the business', async t => {
  const duplicateKeyError = Object.assign(new Error('duplicate key'), {
    code: 11000,
    keyPattern: { email: 1 }
  });
  const created = mockSuccessfulCreation(t, {
    ownerCreate: async () => {
      throw duplicateKeyError;
    }
  });
  const res = makeResponse();

  await registerOwner(makeRequest(validRegistration()), res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.message, 'An account with this email already exists');
  assert.equal(created.deleteOwner.mock.callCount(), 0);
  assert.equal(created.deleteBusiness.mock.callCount(), 1);
});

test('registerOwner rolls back both records if session creation fails', async t => {
  const created = mockSuccessfulCreation(t, {
    sessionFailure: new Error('session storage unavailable')
  });
  const res = makeResponse();

  await registerOwner(makeRequest(validRegistration()), res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.success, false);
  assert.equal(created.deleteOwner.mock.callCount(), 1);
  assert.equal(created.deleteBusiness.mock.callCount(), 1);
  assert.ok(created.owner);
  assert.ok(created.business);
});
