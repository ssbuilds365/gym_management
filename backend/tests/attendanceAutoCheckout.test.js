const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getAttendanceDateBounds,
  getAttendanceDayBounds
} = require('../utils/attendanceDates');
const {
  closeAttendanceIfOverdue,
  reconcileOpenAttendance
} = require('../services/attendanceAutoCheckout');

test('attendance day boundaries use each gym timezone and account for DST', () => {
  const kolkata = getAttendanceDayBounds(
    new Date('2026-11-10T01:30:00.000Z'),
    'Asia/Kolkata'
  );
  assert.equal(kolkata.end.toISOString(), '2026-11-10T18:29:59.999Z');

  const losAngeles = getAttendanceDayBounds(
    new Date('2026-11-10T15:00:00.000Z'),
    'America/Los_Angeles'
  );
  assert.equal(losAngeles.end.toISOString(), '2026-11-11T07:59:59.999Z');

  const daylightSavingDay = getAttendanceDayBounds(
    new Date('2026-03-08T12:00:00.000Z'),
    'America/New_York'
  );
  assert.equal(
    daylightSavingDay.nextStart.getTime() - daylightSavingDay.start.getTime(),
    23 * 60 * 60 * 1000
  );
});

test('attendance date input resolves a gym-local day and rejects invalid dates', () => {
  const bounds = getAttendanceDateBounds('2026-11-10', 'Asia/Kolkata');
  assert.equal(bounds.start.toISOString(), '2026-11-09T18:30:00.000Z');
  assert.equal(bounds.nextStart.toISOString(), '2026-11-10T18:30:00.000Z');
  assert.equal(getAttendanceDateBounds('2026-02-30', 'Asia/Kolkata'), null);
});

test('automatic checkout closes overdue records once, preserving manual checkout', async () => {
  const businesses = [
    { _id: 'kolkata', timeZone: 'Asia/Kolkata' },
    { _id: 'los-angeles', timeZone: 'America/Los_Angeles' }
  ];
  const records = [
    {
      _id: 'kolkata-open-1',
      tenantId: 'kolkata',
      businessId: 'kolkata',
      checkIn: new Date('2026-11-10T01:30:00.000Z'),
      checkOut: null
    },
    {
      _id: 'kolkata-open-2',
      tenantId: 'kolkata',
      businessId: 'kolkata',
      checkIn: new Date('2026-11-10T04:00:00.000Z'),
      checkOut: null
    },
    {
      _id: 'kolkata-manual',
      tenantId: 'kolkata',
      businessId: 'kolkata',
      checkIn: new Date('2026-11-10T02:00:00.000Z'),
      checkOut: new Date('2026-11-10T04:00:00.000Z'),
      checkoutType: 'MANUAL'
    },
    {
      _id: 'los-angeles-open',
      tenantId: 'los-angeles',
      businessId: 'los-angeles',
      checkIn: new Date('2026-11-10T15:00:00.000Z'),
      checkOut: null
    }
  ];
  const updates = [];
  const BusinessModel = {
    find: () => ({
      select: () => ({
        lean: async () => businesses
      })
    })
  };
  const AttendanceModel = {
    find: filter => ({
      select: () => ({
        lean: async () => records.filter(record =>
          record.tenantId === filter.tenantId &&
          record.businessId === filter.businessId &&
          record.checkOut === null &&
          record.checkIn <= filter.checkIn.$lte
        )
      })
    }),
    updateOne: async (filter, update) => {
      updates.push({ filter, update });
      const record = records.find(item => (
        item._id === filter._id &&
        item.tenantId === filter.tenantId &&
        item.businessId === filter.businessId &&
        item.checkOut === null
      ));
      if (!record) return { modifiedCount: 0 };
      Object.assign(record, update.$set);
      return { modifiedCount: 1 };
    }
  };
  const now = new Date('2026-11-11T09:00:00.000Z');

  const closed = await reconcileOpenAttendance({
    now,
    BusinessModel,
    AttendanceModel
  });
  assert.equal(closed, 3);
  assert.equal(records[0].checkOut.toISOString(), '2026-11-10T18:29:59.999Z');
  assert.equal(records[0].attendanceDate.toISOString(), '2026-11-09T18:30:00.000Z');
  assert.equal(records[0].checkoutType, 'AUTOMATIC');
  assert.equal(records[0].durationMinutes, 1019);
  assert.equal(records[1].checkoutType, 'AUTOMATIC');
  assert.equal(records[2].checkOut.toISOString(), '2026-11-10T04:00:00.000Z');
  assert.equal(records[2].checkoutType, 'MANUAL');
  assert.equal(records[3].checkOut.toISOString(), '2026-11-11T07:59:59.999Z');

  assert.equal(await reconcileOpenAttendance({
    now,
    BusinessModel,
    AttendanceModel
  }), 0);
  assert.equal(updates.length, 3);
});

test('automatic checkout uses a conditional update and never replaces manual checkout', async () => {
  let updateFilter;
  let updateDocument;
  const closed = await closeAttendanceIfOverdue({
    attendance: {
      _id: 'attendance-1',
      checkIn: new Date('2026-11-10T01:30:00.000Z')
    },
    business: { _id: 'tenant-1', timeZone: 'Asia/Kolkata' },
    now: new Date('2026-11-11T00:00:00.000Z'),
    AttendanceModel: {
      updateOne: async (filter, update) => {
        updateFilter = filter;
        updateDocument = update;
        return { modifiedCount: 0 };
      }
    }
  });

  assert.equal(closed, false);
  assert.equal(updateFilter.checkOut, null);
  assert.equal(updateFilter.tenantId, 'tenant-1');
  assert.equal(updateDocument.$set.checkoutType, 'AUTOMATIC');
});
