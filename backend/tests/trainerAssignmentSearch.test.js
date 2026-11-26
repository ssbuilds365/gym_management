const test = require('node:test');
const assert = require('node:assert/strict');
const Member = require('../models/Member');
const TrainerStaff = require('../models/TrainerStaff');
const TrainerAssignment = require('../models/TrainerAssignment');
const {
  searchAssignableMembers,
  getTrainerAssignments
} = require('../controllers/trainerAssignmentController');

const response = () => ({
  statusCode: 200,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});

test('trainer member search scopes active records by tenant, limits results, and formats the existing ID', async t => {
  const memberResults = [{
    _id: '507f1f77bcf86cd799b3d3bc',
    fullName: 'Santosh',
    phone: '9833788644'
  }];
  let filter;
  let selectedFields;
  let requestedLimit;
  const chain = {
    select(fields) {
      selectedFields = fields;
      return this;
    },
    sort(sort) {
      assert.deepEqual(sort, { fullName: 1, _id: 1 });
      return this;
    },
    skip(skip) {
      assert.equal(skip, 20);
      return this;
    },
    limit(limit) {
      requestedLimit = limit;
      return this;
    },
    lean: async () => memberResults
  };
  t.mock.method(Member, 'find', query => {
    filter = query;
    return chain;
  });

  const res = response();
  await searchAssignableMembers({
    tenantId: 'authenticated-tenant',
    owner: { businessId: 'authenticated-business' },
    query: { search: 'Santosh', page: '2', limit: '100' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(filter.tenantId, 'authenticated-tenant');
  assert.equal(filter.businessId, 'authenticated-business');
  assert.equal(filter.status, 'Active');
  assert.equal(filter.deletedAt, null);
  assert.equal(filter.$or[0].fullName.$regex, 'Santosh');
  assert.equal(filter.$or[0].fullName.$options, 'i');
  assert.equal(filter.$or[1].phone.$regex, 'Santosh');
  assert.equal(selectedFields, '_id fullName phone');
  assert.equal(requestedLimit, 21);
  assert.deepEqual(res.body.members, [{
    ...memberResults[0],
    memberId: 'B3D3BC'
  }]);
  assert.deepEqual(res.body.pagination, { page: 2, limit: 20, hasMore: false });
});

test('trainer member search matches partial phones and the displayed ID suffix', async t => {
  let filter;
  t.mock.method(Member, 'find', query => {
    filter = query;
    return {
      select() { return this; },
      sort() { return this; },
      skip() { return this; },
      limit() { return this; },
      lean: async () => []
    };
  });

  const res = response();
  await searchAssignableMembers({
    tenantId: 'authenticated-tenant',
    owner: { businessId: 'authenticated-business' },
    query: { search: 'b3d3bc', page: '1', limit: '20' }
  }, res);

  assert.equal(filter.$or[1].phone.$regex, 'b3d3bc');
  assert.equal(filter.$or[2].$expr.$regexMatch.input.$substrBytes[1], 18);
  assert.equal(filter.$or[2].$expr.$regexMatch.input.$substrBytes[2], 6);
  assert.equal(filter.$or[2].$expr.$regexMatch.regex, 'b3d3bc');
  assert.equal(filter.$or[2].$expr.$regexMatch.options, 'i');
  assert.deepEqual(res.body.members, []);
  assert.equal(res.body.pagination.hasMore, false);

  await searchAssignableMembers({
    tenantId: 'authenticated-tenant',
    owner: { businessId: 'authenticated-business' },
    query: { search: '98337', page: '1', limit: '20' }
  }, response());
  assert.equal(filter.$or[1].phone.$regex, '98337');
  assert.equal(filter.$or.length, 3);

  await searchAssignableMembers({
    tenantId: 'authenticated-tenant',
    owner: { businessId: 'authenticated-business' },
    query: { search: '9833788644', page: '1', limit: '20' }
  }, response());
  assert.equal(filter.$or[1].phone.$regex, '9833788644');
});

test('trainer member search caps oversized result pages at twenty records', async t => {
  const memberResults = Array.from({ length: 21 }, (_, index) => ({
    _id: `member-${index}`,
    fullName: `Member ${index}`,
    phone: `90000000${String(index).padStart(2, '0')}`
  }));
  let requestedLimit;
  t.mock.method(Member, 'find', () => ({
    select() { return this; },
    sort() { return this; },
    skip() { return this; },
    limit(limit) {
      requestedLimit = limit;
      return this;
    },
    lean: async () => memberResults
  }));

  const res = response();
  await searchAssignableMembers({
    tenantId: 'authenticated-tenant',
    owner: { businessId: 'authenticated-business' },
    query: { search: '', page: '1', limit: '5000' }
  }, res);

  assert.equal(requestedLimit, 21);
  assert.equal(res.body.members.length, 20);
  assert.equal(res.body.pagination.hasMore, true);
});

test('trainer assignments include canonical assignment records and remain tenant-scoped', async t => {
  const trainerId = '507f1f77bcf86cd799439011';
  const assignedMemberId = '507f1f77bcf86cd799439012';
  const legacyMemberId = '507f1f77bcf86cd799439013';
  let memberFilter;
  const trainer = { _id: trainerId, name: 'Trainer', status: 'Active' };
  t.mock.method(TrainerStaff, 'findOne', filter => {
    assert.equal(filter._id, trainerId);
    assert.equal(filter.tenantId, 'authenticated-tenant');
    return {
      select() { return this; },
      lean: async () => trainer
    };
  });
  let assignmentFindCalls = 0;
  t.mock.method(TrainerAssignment, 'find', filter => {
    assert.equal(filter.tenantId, 'authenticated-tenant');
    assert.equal(filter.businessId, 'authenticated-business');
    assert.equal(filter.trainerId, trainerId);
    assignmentFindCalls += 1;
    if (filter.status) {
      assert.equal(filter.status, 'Active');
      return {
        select() { return this; },
        lean: async () => [{ memberId: assignedMemberId, assignmentRole: 'Additional' }]
      };
    }
    return {
      sort() { return this; },
      lean: async () => []
    };
  });
  t.mock.method(Member, 'find', filter => {
    memberFilter = filter;
    return {
      select() { return this; },
      sort() { return this; },
      lean: async () => [
        {
          _id: assignedMemberId,
          fullName: 'Canonical assignment',
          phone: '5551234',
          assignedTrainerId: null,
          additionalTrainerIds: []
        },
        {
          _id: legacyMemberId,
          fullName: 'Legacy assignment',
          phone: '5555678',
          assignedTrainerId: trainerId,
          additionalTrainerIds: []
        }
      ]
    };
  });

  const res = response();
  await getTrainerAssignments({
    params: { id: trainerId },
    tenantId: 'authenticated-tenant',
    owner: { businessId: 'authenticated-business' }
  }, res);

  assert.equal(assignmentFindCalls, 2);
  assert.equal(memberFilter.tenantId, 'authenticated-tenant');
  assert.equal(memberFilter.businessId, 'authenticated-business');
  assert.equal(memberFilter.deletedAt, null);
  assert.deepEqual(memberFilter.$or[2]._id.$in, [assignedMemberId]);
  assert.equal(res.body.members[0].assignmentRole, 'Additional');
  assert.equal(res.body.members[0].memberId, '439012');
  assert.equal(res.body.members[1].assignmentRole, 'Primary');
});
