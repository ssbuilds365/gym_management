const parseMemberDateRange = (fromValue, toValue) => {
  if (fromValue === undefined && toValue === undefined) {
    return { range: null };
  }

  if (typeof fromValue !== 'string' || typeof toValue !== 'string') {
    return { error: 'Both joining date range boundaries are required' };
  }

  const from = new Date(fromValue);
  const to = new Date(toValue);
  if (
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    from.toISOString() !== fromValue ||
    to.toISOString() !== toValue ||
    from >= to
  ) {
    return { error: 'Invalid joining date range' };
  }

  return { range: { $gte: from, $lt: to } };
};

module.exports = { parseMemberDateRange };
