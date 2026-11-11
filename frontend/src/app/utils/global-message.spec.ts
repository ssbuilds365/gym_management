import { createWhatsAppUrl, normalizeIndianMobile, personalizeGlobalMessage } from './global-message';

describe('global message utilities', () => {
  it('normalizes and validates Indian mobile numbers', () => {
    expect(normalizeIndianMobile('9876543210')).toBe('919876543210');
    expect(normalizeIndianMobile('+91 98765-43210')).toBe('919876543210');
    expect(normalizeIndianMobile('09876543210')).toBe('919876543210');
    expect(normalizeIndianMobile('1234567890')).toBe('');
  });

  it('replaces available variables without leaking missing placeholders', () => {
    const text = personalizeGlobalMessage(
      'Hi {{name}} from {{gymName}}. Due {{pendingAmount}} on {{expiryDate}} for {{planName}} {{unknown}}',
      {
        _id: 'member-1',
        fullName: 'Asha',
        phone: '9876543210',
        normalizedMobile: '919876543210',
        membership: null,
        planName: '',
        pendingAmount: 1200
      },
      'SS Fitness'
    );
    expect(text).toContain('Hi Asha from SS Fitness. Due 1,200 on  for  ');
    expect(text).not.toContain('{{');
    expect(text).not.toContain('undefined');
  });

  it('creates an encoded wa.me link and refuses invalid numbers', () => {
    expect(createWhatsAppUrl('9876543210', 'Hi Asha!\nRenew now.'))
      .toBe('https://wa.me/919876543210?text=Hi%20Asha!%0ARenew%20now.');
    expect(() => createWhatsAppUrl('12345', 'Hello')).toThrow('valid Indian mobile number');
  });
});
