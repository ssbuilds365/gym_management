const {
  getLocalDateParts,
  localDateTimeToUtc
} = require('./dashboardPeriods');

const shiftCalendarDate = (parts, days) => {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
};

const getExpiringPTWindow = (now, timeZone) => {
  const localNow = getLocalDateParts(now, timeZone);
  const today = {
    year: localNow.year,
    month: localNow.month,
    day: localNow.day
  };
  return {
    todayDate: `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`,
    start: localDateTimeToUtc(today, timeZone),
    endExclusive: localDateTimeToUtc(shiftCalendarDate(today, 6), timeZone)
  };
};

const getRemainingDays = (endDate, now, timeZone) => {
  const endParts = getLocalDateParts(new Date(endDate), timeZone);
  const nowParts = getLocalDateParts(now, timeZone);
  const endKey = Date.UTC(endParts.year, endParts.month - 1, endParts.day);
  const todayKey = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
  return Math.round((endKey - todayKey) / 86400000);
};

module.exports = {
  getExpiringPTWindow,
  getRemainingDays
};
