exports.toMinorUnits = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;

  const scaled = amount * 100;
  const rounded = Math.round(scaled);
  return Math.abs(scaled - rounded) <= 1e-7 ? rounded : null;
};

exports.fromMinorUnits = (value) => value / 100;
