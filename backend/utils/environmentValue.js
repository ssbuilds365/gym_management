const getEnvironmentValue = (name, processEnvironment, fileEnvironment) => {
  const processValue = processEnvironment[name];
  if (typeof processValue === 'string' && processValue.trim()) {
    return processValue.trim();
  }
  const fileValue = fileEnvironment[name];
  return typeof fileValue === 'string' ? fileValue.trim() : '';
};

module.exports = { getEnvironmentValue };
