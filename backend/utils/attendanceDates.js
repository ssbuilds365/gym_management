const {
  getLocalDateParts,
  localDateTimeToUtc
} = require('./dashboardPeriods');

const getNextDateParts = ({ year, month, day }) => {
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    year: nextDate.getUTCFullYear(),
    month: nextDate.getUTCMonth() + 1,
    day: nextDate.getUTCDate()
  };
};

const getAttendanceDayBounds = (date, timeZone) => {
  const localDate = getLocalDateParts(date, timeZone);
  const parts = {
    year: localDate.year,
    month: localDate.month,
    day: localDate.day
  };
  const nextDateParts = getNextDateParts(parts);
  const start = localDateTimeToUtc(parts, timeZone);
  const nextStart = localDateTimeToUtc(nextDateParts, timeZone);

  return {
    start,
    nextStart,
    end: new Date(nextStart.getTime() - 1)
  };
};

const getAttendanceDateBounds = (dateValue, timeZone) => {
  let parts;
  if (typeof dateValue === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    const [year, month, day] = dateValue.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() + 1 !== month ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    parts = { year, month, day };
  } else {
    const date = dateValue ? new Date(dateValue) : new Date();
    if (Number.isNaN(date.getTime())) return null;
    const localDate = getLocalDateParts(date, timeZone);
    parts = {
      year: localDate.year,
      month: localDate.month,
      day: localDate.day
    };
  }

  const nextParts = getNextDateParts(parts);
  return {
    start: localDateTimeToUtc(parts, timeZone),
    nextStart: localDateTimeToUtc(nextParts, timeZone),
    legacyStart: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)),
    legacyNextStart: new Date(Date.UTC(
      nextParts.year,
      nextParts.month - 1,
      nextParts.day
    ))
  };
};

module.exports = {
  getAttendanceDayBounds,
  getAttendanceDateBounds
};
