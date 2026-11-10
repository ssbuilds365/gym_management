const Attendance = require('../models/Attendance');
const Business = require('../models/Business');
const { getAttendanceDayBounds } = require('../utils/attendanceDates');
const {
  DEFAULT_TIME_ZONE,
  isValidTimeZone
} = require('../utils/membershipExpiry');

const RECONCILIATION_INTERVAL_MS = 60_000;

const getBusinessTimeZone = business => (
  isValidTimeZone(business.timeZone) ? business.timeZone : DEFAULT_TIME_ZONE
);

const closeAttendanceIfOverdue = async ({
  attendance,
  business,
  now,
  AttendanceModel = Attendance
}) => {
  const checkIn = new Date(attendance.checkIn);
  if (Number.isNaN(checkIn.getTime())) {
    console.error(`Skipping attendance ${attendance._id}: invalid check-in timestamp`);
    return false;
  }

  const { start, end } = getAttendanceDayBounds(checkIn, getBusinessTimeZone(business));
  if (now < end) return false;

  const checkOut = end < checkIn ? checkIn : end;
  const durationMinutes = Math.max(
    0,
    Math.floor((checkOut.getTime() - checkIn.getTime()) / 60_000)
  );
  const result = await AttendanceModel.updateOne(
    {
      _id: attendance._id,
      tenantId: business._id,
      businessId: business._id,
      checkOut: null
    },
    {
      $set: {
        attendanceDate: start,
        checkOut,
        checkoutType: 'AUTOMATIC',
        durationMinutes
      }
    }
  );

  return result.modifiedCount === 1;
};

const reconcileOpenAttendance = async ({
  now = new Date(),
  BusinessModel = Business,
  AttendanceModel = Attendance,
  tenantId
} = {}) => {
  let closedCount = 0;
  const businesses = await BusinessModel.find(tenantId ? { _id: tenantId } : {})
    .select('_id timeZone')
    .lean();

  for (const business of businesses) {
    const openRecords = await AttendanceModel.find({
      tenantId: business._id,
      businessId: business._id,
      checkOut: null,
      checkIn: { $lte: now }
    })
      .select('_id checkIn')
      .lean();

    for (const attendance of openRecords) {
      if (await closeAttendanceIfOverdue({
        attendance,
        business,
        now,
        AttendanceModel
      })) {
        closedCount += 1;
      }
    }
  }

  return closedCount;
};

const startAttendanceAutoCheckout = async () => {
  const reconcileAndLog = async () => {
    try {
      const closedCount = await reconcileOpenAttendance();
      if (closedCount > 0) {
        console.info(`Automatically checked out ${closedCount} attendance record(s)`);
      }
    } catch (error) {
      console.error('Attendance auto-checkout reconciliation failed:', error);
    }
  };

  let timer;
  const scheduleNextReconciliation = () => {
    timer = setTimeout(async () => {
      await reconcileAndLog();
      scheduleNextReconciliation();
    }, RECONCILIATION_INTERVAL_MS);
    timer.unref();
  };

  await reconcileAndLog();
  scheduleNextReconciliation();
  return timer;
};

module.exports = {
  closeAttendanceIfOverdue,
  reconcileOpenAttendance,
  startAttendanceAutoCheckout
};
