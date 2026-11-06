const formatterCache = new Map();

const getFormatter = (timeZone) => {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      })
    );
  }

  return formatterCache.get(timeZone);
};

const getLocalDateParts = (date, timeZone) => {
  const parts = getFormatter(timeZone).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second
  };
};

const localDateTimeToUtc = (parts, timeZone) => {
  const desiredUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0
  );
  let guess = desiredUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const localParts = getLocalDateParts(new Date(guess), timeZone);
    const representedUtc = Date.UTC(
      localParts.year,
      localParts.month - 1,
      localParts.day,
      localParts.hour,
      localParts.minute,
      localParts.second
    );
    const difference = representedUtc - guess;
    if (difference === 0) break;
    guess = desiredUtc - difference;
  }

  return new Date(guess);
};

const shiftCalendarDate = (parts, days) => {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
};

const shiftCalendarMonth = (year, month, offset) => {
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1
  };
};

const getDashboardPeriods = (now, timeZone) => {
  const localNow = getLocalDateParts(now, timeZone);
  const todayDate = {
    year: localNow.year,
    month: localNow.month,
    day: localNow.day
  };
  const todayStart = localDateTimeToUtc(todayDate, timeZone);
  const tomorrowStart = localDateTimeToUtc(
    shiftCalendarDate(todayDate, 1),
    timeZone
  );
  const weekday = new Date(
    Date.UTC(localNow.year, localNow.month - 1, localNow.day)
  ).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  const weekStart = localDateTimeToUtc(
    shiftCalendarDate(todayDate, -daysSinceMonday),
    timeZone
  );
  const monthStart = localDateTimeToUtc(
    { year: localNow.year, month: localNow.month, day: 1 },
    timeZone
  );
  const firstMonth = shiftCalendarMonth(localNow.year, localNow.month, -11);
  const firstMonthStart = localDateTimeToUtc(
    { ...firstMonth, day: 1 },
    timeZone
  );
  const months = Array.from({ length: 12 }, (_, index) => {
    const calendarMonth = shiftCalendarMonth(
      firstMonth.year,
      firstMonth.month,
      index
    );
    return {
      key: `${calendarMonth.year}-${String(calendarMonth.month).padStart(2, '0')}`,
      start: localDateTimeToUtc({ ...calendarMonth, day: 1 }, timeZone)
    };
  });

  return {
    todayStart,
    tomorrowStart,
    weekStart,
    monthStart,
    firstMonthStart,
    months
  };
};

module.exports = {
  getDashboardPeriods,
  localDateTimeToUtc,
  getLocalDateParts
};
