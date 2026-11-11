const normalizeIndianMobile = value => {
  const digits = String(value || '').replace(/\D/g, '');
  const mobile = digits.length === 12 && digits.startsWith('91')
    ? digits.slice(2)
    : digits.length === 11 && digits.startsWith('0')
      ? digits.slice(1)
      : digits;

  return /^[6-9]\d{9}$/.test(mobile) ? `91${mobile}` : '';
};

const campaignSummary = recipients => {
  const summary = {
    totalRecipients: recipients.length,
    whatsappOpened: 0,
    manuallyMarkedSent: 0,
    skipped: 0,
    invalidNumber: 0,
    pending: 0
  };

  for (const recipient of recipients) {
    if (recipient.whatsappOpenedAt || recipient.status === 'WHATSAPP_OPENED') {
      summary.whatsappOpened += 1;
    }
    if (recipient.status === 'MANUALLY_MARKED_SENT') summary.manuallyMarkedSent += 1;
    if (recipient.status === 'SKIPPED') summary.skipped += 1;
    if (recipient.status === 'INVALID_NUMBER') summary.invalidNumber += 1;
    if (recipient.status === 'PENDING' || recipient.status === 'WHATSAPP_OPENED') {
      summary.pending += 1;
    }
  }

  return summary;
};

module.exports = { normalizeIndianMobile, campaignSummary };
