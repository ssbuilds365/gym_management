const ENQUIRY_STATUSES = [
  'NEW',
  'CONTACTED',
  'INTERESTED',
  'TRIAL_SCHEDULED',
  'FOLLOW_UP',
  'CONVERTED',
  'LOST'
];
const TRIAL_STATUSES = ['SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'];
const ENQUIRY_SOURCES = [
  'Walk-in',
  'Instagram',
  'Facebook',
  'WhatsApp',
  'Website',
  'Referral',
  'Google',
  'Other'
];
const INTEREST_OPTIONS = ['Gym Membership', 'Personal Training', 'Both'];

const normalizePhone = (value) => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const phone = String(value).trim();
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 13 && digits.startsWith('910')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length < 7 || digits.length > 15 || !/^\+?[0-9][0-9\s().-]*$/.test(phone)) {
    return null;
  }
  return { phone, normalizedPhone: digits };
};

const parseEnquiryDate = (value, { nullable = false } = {}) => {
  if ((value === null || value === '') && nullable) return { value: null };
  if (value === undefined || value === null || value === '') {
    return { error: 'A valid date is required' };
  }
  if (!(value instanceof Date) && typeof value !== 'string') {
    return { error: 'Invalid date' };
  }
  if (typeof value === 'string') {
    const isoDate = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
    if (isoDate) {
      const [, year, month, day] = isoDate;
      const check = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
      if (check.getUTCFullYear() !== Number(year) ||
          check.getUTCMonth() !== Number(month) - 1 ||
          check.getUTCDate() !== Number(day)) {
        return { error: 'Invalid date' };
      }
    }
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return { error: 'Invalid date' };
  return { value: parsed };
};

const pagination = (query = {}) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 10));
  return { page, limit, skip: (page - 1) * limit };
};

const normalizeTrialStatus = (status) => ({
  Scheduled: 'SCHEDULED',
  Attended: 'COMPLETED',
  Cancelled: 'CANCELLED',
  'No Show': 'NO_SHOW'
}[status] || status);

module.exports = {
  ENQUIRY_STATUSES,
  TRIAL_STATUSES,
  ENQUIRY_SOURCES,
  INTEREST_OPTIONS,
  normalizePhone,
  parseEnquiryDate,
  pagination,
  normalizeTrialStatus
};
