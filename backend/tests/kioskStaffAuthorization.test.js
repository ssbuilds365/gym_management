const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../routes/kioskRoutes');
const requireKioskGymOwner = require('../middleware/kioskStaffAuthorization');
const { protectOwner } = require('../middleware/authMiddleware');
const { protectKiosk } = require('../middleware/kioskAuthMiddleware');
const { registerFace } = require('../controllers/biometricController');

const makeResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});

test('kiosk staff face registration requires kiosk auth, owner auth, and gym-match checks', () => {
  const routeLayer = router.stack.find(layer =>
    layer.route?.path === '/staff/enrollment/face/:id'
  );
  assert.ok(routeLayer, 'staff registration route is registered');
  const handlers = routeLayer.route.stack.map(layer => layer.handle);
  assert.equal(handlers[1], protectKiosk);
  assert.equal(handlers[2], protectOwner);
  assert.equal(handlers[3], requireKioskGymOwner);
  assert.equal(handlers[4], registerFace);
});

test('rejects missing kiosk authorization before registration', () => {
  const response = makeResponse();
  let continued = false;
  requireKioskGymOwner({ owner: { role: 'owner' } }, response, () => {
    continued = true;
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'KIOSK_AUTH_REQUIRED');
  assert.equal(continued, false);
});

test('rejects staff accounts without owner privileges or with a different gym', () => {
  const staffResponse = makeResponse();
  requireKioskGymOwner({
    tenantId: 'tenant-a',
    kiosk: { tenantId: 'tenant-a', businessId: 'business-a' },
    owner: { role: 'staff', tenantId: 'tenant-a', businessId: 'business-a' }
  }, staffResponse, () => assert.fail('staff must not proceed'));
  assert.equal(staffResponse.statusCode, 403);
  assert.equal(staffResponse.body.code, 'STAFF_AUTH_REQUIRED');

  const mismatchResponse = makeResponse();
  requireKioskGymOwner({
    tenantId: 'tenant-a',
    kiosk: { tenantId: 'tenant-a', businessId: 'business-a' },
    owner: { role: 'owner', tenantId: 'tenant-a', businessId: 'business-b' }
  }, mismatchResponse, () => assert.fail('cross-gym owner must not proceed'));
  assert.equal(mismatchResponse.statusCode, 403);
  assert.equal(mismatchResponse.body.code, 'STAFF_GYM_MISMATCH');
});

test('allows an owner only when both kiosk and owner gym identifiers match', () => {
  const response = makeResponse();
  let continued = false;
  requireKioskGymOwner({
    tenantId: 'tenant-a',
    kiosk: { tenantId: 'tenant-a', businessId: 'business-a' },
    owner: { role: 'owner', tenantId: 'tenant-a', businessId: 'business-a' }
  }, response, () => {
    continued = true;
  });
  assert.equal(continued, true);
});
