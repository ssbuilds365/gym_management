const DAY_MS = 86400000;
const { localDateTimeToUtc, getLocalDateParts } = require('./dashboardPeriods');

const isValidTimeZone = timeZone => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const parseDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? null
    : date;
};

const resolveReportPeriod = (query, now = new Date()) => {
  if (query.timezone && !isValidTimeZone(query.timezone)) return null;
  const timeZone = typeof query.timezone === 'string' && isValidTimeZone(query.timezone)
    ? query.timezone
    : 'UTC';
  const period = query.period || 'custom';
  const today = getLocalDateParts(now, timeZone);
  const localStart = parts => localDateTimeToUtc(
    { year: parts.year, month: parts.month, day: parts.day },
    timeZone
  );
  const shiftedDay = (parts, amount) => {
    const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
    return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
  };
  let from;
  let toExclusive;
  switch (period) {
    case 'today':
      from = localStart(today);
      toExclusive = localStart(shiftedDay(today, 1));
      break;
    case 'yesterday':
      from = localStart(shiftedDay(today, -1));
      toExclusive = localStart(today);
      break;
    case 'week': {
      const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
      const mondayOffset = (weekday + 6) % 7;
      from = localStart(shiftedDay(today, -mondayOffset));
      toExclusive = localStart(shiftedDay(today, 1));
      break;
    }
    case 'month':
      from = localStart({ ...today, day: 1 });
      toExclusive = localStart(shiftedDay(today, 1));
      break;
    case 'lastMonth':
      from = localStart({
        year: today.month === 1 ? today.year - 1 : today.year,
        month: today.month === 1 ? 12 : today.month - 1,
        day: 1
      });
      toExclusive = localStart({ ...today, day: 1 });
      break;
    case 'year':
      from = localStart({ year: today.year, month: 1, day: 1 });
      toExclusive = localStart(shiftedDay(today, 1));
      break;
    case 'custom': {
      const parsedFrom = parseDate(query.from);
      const parsedTo = parseDate(query.to);
      if (!parsedFrom || !parsedTo) return null;
      const fromParts = {
        year: parsedFrom.getUTCFullYear(),
        month: parsedFrom.getUTCMonth() + 1,
        day: parsedFrom.getUTCDate()
      };
      const toParts = {
        year: parsedTo.getUTCFullYear(),
        month: parsedTo.getUTCMonth() + 1,
        day: parsedTo.getUTCDate()
      };
      from = localStart(fromParts);
      toExclusive = localStart(shiftedDay(toParts, 1));
      break;
    }
    default:
      return null;
  }

  const fromLocal = getLocalDateParts(from, timeZone);
  const endLocal = getLocalDateParts(new Date(toExclusive.getTime() - 1), timeZone);
  const calendarDays = (
    Date.UTC(endLocal.year, endLocal.month - 1, endLocal.day) -
    Date.UTC(fromLocal.year, fromLocal.month - 1, fromLocal.day)
  ) / DAY_MS + 1;
  if (toExclusive <= from || calendarDays > 366) {
    return null;
  }
  return {
    period,
    timeZone,
    from,
    toExclusive,
    to: new Date(toExclusive.getTime() - 1),
    fromDate: `${fromLocal.year}-${String(fromLocal.month).padStart(2, '0')}-${String(fromLocal.day).padStart(2, '0')}`,
    toDate: `${endLocal.year}-${String(endLocal.month).padStart(2, '0')}-${String(endLocal.day).padStart(2, '0')}`,
    previousFrom: localDateTimeToUtc(
      (() => {
        const shifted = new Date(Date.UTC(
          fromLocal.year,
          fromLocal.month - 1,
          fromLocal.day - calendarDays
        ));
        return {
          year: shifted.getUTCFullYear(),
          month: shifted.getUTCMonth() + 1,
          day: shifted.getUTCDate()
        };
      })(),
      timeZone
    ),
    previousToExclusive: from
  };
};

module.exports = { DAY_MS, parseDate, resolveReportPeriod, isValidTimeZone };
