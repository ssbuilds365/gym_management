export interface GlobalMessageMember {
  _id: string;
  fullName: string;
  phone: string;
  normalizedMobile: string;
  membership?: { endDate?: string | null } | null;
  planName?: string;
  pendingAmount?: number;
}

export const normalizeIndianMobile = (value: string): string => {
  const digits = String(value || '').replace(/\D/g, '');
  const mobile = digits.startsWith('91') && digits.length === 12
    ? digits.slice(2)
    : digits.startsWith('0') && digits.length === 11
      ? digits.slice(1)
      : digits;
  return /^[6-9]\d{9}$/.test(mobile) ? `91${mobile}` : '';
};

export const personalizeGlobalMessage = (
  template: string,
  member: GlobalMessageMember,
  gymName: string,
  timeZone = 'Asia/Kolkata'
): string => {
  const values: Record<string, string> = {
    name: member.fullName || '',
    gymName: gymName || '',
    expiryDate: member.membership?.endDate
      ? new Intl.DateTimeFormat('en-IN', {
          timeZone,
          day: '2-digit',
          month: 'short',
          year: 'numeric'
        })
          .format(new Date(member.membership.endDate))
      : '',
    pendingAmount: Number(member.pendingAmount || 0).toLocaleString('en-IN'),
    planName: member.planName || ''
  };
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_match, variable: string) => values[variable] ?? '');
};

export const createWhatsAppUrl = (mobile: string, message: string): string => {
  const normalized = normalizeIndianMobile(mobile);
  if (!normalized) throw new Error('This member does not have a valid Indian mobile number.');
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
};
