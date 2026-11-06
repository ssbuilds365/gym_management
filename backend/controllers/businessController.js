const Business = require('../models/Business');
const {
  isValidGstin,
  isValidStateCode,
  GST_STATES
} = require('../utils/gst');
const { isValidTimeZone } = require('../utils/membershipExpiry');

const businessFields = [
  'businessName',
  'businessType',
  'timeZone',
  'phone',
  'email',
  'address',
  'logoUrl',
  'gstEnabled',
  'gstinNumber',
  'legalBusinessName',
  'registeredBusinessAddress',
  'state',
  'stateCode',
  'gstPercentage',
  'taxInclusive'
];
const businessTypes = ['Gym', 'Yoga Studio', 'Fitness Studio', 'Other'];
const settingsProjection =
  'businessName businessType timeZone ownerName phone email address logoUrl subscriptionStatus gstEnabled gstinNumber legalBusinessName registeredBusinessAddress state stateCode gstPercentage taxInclusive';

const validateGstSettings = (settings) => {
  if (typeof settings.gstEnabled !== 'boolean') {
    return 'GST enabled must be true or false';
  }
  if (!settings.gstEnabled) return null;

  if (!isValidGstin(settings.gstinNumber)) {
    return 'Enter a structurally valid GSTIN. Government registration is not verified by this application.';
  }
  if (settings.gstinNumber.slice(0, 2) !== settings.stateCode) {
    return 'GSTIN state code must match the registered business state code';
  }
  if (!isValidStateCode(settings.stateCode) || !settings.state) {
    return 'Select a valid registered business state and state code';
  }
  if (settings.state !== GST_STATES[settings.stateCode]) {
    return 'Registered business state does not match the state code';
  }
  if (!String(settings.legalBusinessName || '').trim()) {
    return 'Legal business name is required when GST is enabled';
  }
  if (!String(settings.registeredBusinessAddress || '').trim()) {
    return 'Registered business address is required when GST is enabled';
  }
  const rate = Number(settings.gstPercentage);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    return 'GST percentage must be between 0 and 100';
  }
  if (typeof settings.taxInclusive !== 'boolean') {
    return 'Select tax-inclusive or tax-exclusive pricing';
  }
  return null;
};

exports.getSettings = async (req, res) => {
  try {
    const business = await Business.findById(req.tenantId)
      .select(settingsProjection);
    if (!business) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }
    const result = business.toObject();
    result.timeZone = result.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Asia/Kolkata';
    return res.json({ success: true, business: result });
  } catch (error) {
    console.error('Get business settings error:', error);
    return res.status(500).json({
      success: false,
      message: 'Unable to load business settings'
    });
  }
};

exports.updateSettings = async (req, res) => {
  const updates = {};
  for (const field of businessFields) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      updates[field] = req.body[field];
    }
  }

  if (updates.businessName !== undefined) {
    updates.businessName = String(updates.businessName).trim();
    if (!updates.businessName) {
      return res.status(400).json({
        success: false,
        message: 'Business name is required'
      });
    }
  }
  if (updates.businessType !== undefined && !businessTypes.includes(updates.businessType)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid business type'
    });
  }
  if (updates.timeZone !== undefined) {
    updates.timeZone = String(updates.timeZone).trim();
    if (!isValidTimeZone(updates.timeZone)) {
      return res.status(400).json({
        success: false,
        message: 'Enter a valid IANA time zone, such as Asia/Kolkata'
      });
    }
  }
  if (updates.phone !== undefined) updates.phone = String(updates.phone).trim();
  if (updates.email !== undefined) updates.email = String(updates.email).trim().toLowerCase();
  if (updates.address !== undefined) updates.address = String(updates.address).trim();
  if (updates.logoUrl !== undefined) {
    updates.logoUrl = String(updates.logoUrl).trim();
    if (updates.logoUrl) {
      try {
        if (new URL(updates.logoUrl).protocol !== 'https:') throw new Error('protocol');
      } catch {
        return res.status(400).json({
          success: false,
          message: 'Business logo URL must use HTTPS'
        });
      }
    }
  }
  if (updates.gstinNumber !== undefined) {
    updates.gstinNumber = String(updates.gstinNumber).trim().toUpperCase();
  }
  for (const field of ['legalBusinessName', 'registeredBusinessAddress', 'state']) {
    if (updates[field] !== undefined) updates[field] = String(updates[field]).trim();
  }
  if (updates.stateCode !== undefined) {
    updates.stateCode = String(updates.stateCode).trim();
  }
  if (updates.gstEnabled !== undefined && typeof updates.gstEnabled !== 'boolean') {
    return res.status(400).json({
      success: false,
      message: 'GST enabled must be true or false'
    });
  }
  if (updates.taxInclusive !== undefined && typeof updates.taxInclusive !== 'boolean') {
    return res.status(400).json({
      success: false,
      message: 'Select tax-inclusive or tax-exclusive pricing'
    });
  }
  if (updates.gstPercentage !== undefined) {
    const rate = Number(updates.gstPercentage);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      return res.status(400).json({
        success: false,
        message: 'GST percentage must be between 0 and 100'
      });
    }
    updates.gstPercentage = rate;
  }

  try {
    const existing = await Business.findById(req.tenantId);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }
    const validationMessage = validateGstSettings({
      ...existing.toObject(),
      ...updates
    });
    if (validationMessage) {
      return res.status(400).json({
        success: false,
        message: validationMessage
      });
    }

    const business = await Business.findOneAndUpdate(
      { _id: req.tenantId },
      { $set: updates },
      { new: true, runValidators: true }
    ).select(settingsProjection);
    if (!business) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }
    return res.json({ success: true, business });
  } catch (error) {
    console.error('Update business settings error:', error);
    return res.status(500).json({
      success: false,
      message: 'Unable to update business settings'
    });
  }
};

exports.getSubscription = async (req, res) => {
  try {
    const business = await Business.findById(req.tenantId)
      .select('businessName subscriptionStatus')
      .lean();
    if (!business) {
      return res.status(404).json({ success: false, message: 'Business not found' });
    }
    return res.json({
      success: true,
      subscription: {
        status: business.subscriptionStatus,
        planName: null,
        price: null,
        renewalDate: null,
        billingProvider: null,
        billingConfigured: false
      }
    });
  } catch (error) {
    console.error('Get subscription status error:', error);
    return res.status(500).json({
      success: false,
      message: 'Unable to load subscription status'
    });
  }
};
