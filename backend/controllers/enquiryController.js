const mongoose = require('mongoose');
const Enquiry = require('../models/Enquiry');
const Member = require('../models/Member');
const MembershipPlan = require('../models/MembershipPlan');
const TrainerStaff = require('../models/TrainerStaff');
const Business = require('../models/Business');
const { getDashboardPeriods } = require('../utils/dashboardPeriods');
const { DEFAULT_TIME_ZONE, isValidTimeZone } = require('../utils/membershipExpiry');
const {
  ENQUIRY_STATUSES,
  TRIAL_STATUSES,
  ENQUIRY_SOURCES,
  INTEREST_OPTIONS,
  normalizePhone,
  parseEnquiryDate,
  pagination,
  normalizeTrialStatus
} = require('../utils/enquiries');

const contextFor = (req) => ({
  tenantId: req.tenantId,
  businessId: req.owner.businessId || req.tenantId,
  ownerId: req.owner._id
});

const enquiryFilter = (req, id) => ({
  ...(id ? { _id: id } : {}),
  tenantId: req.tenantId,
  businessId: req.owner.businessId || req.tenantId
});

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);
const respondError = (res, error, fallback) => {
  if (error?.name === 'CastError') {
    return res.status(400).json({ success: false, message: 'Invalid ID or date' });
  }
  if (error?.code === 11000) {
    return res.status(409).json({ success: false, message: 'An enquiry with this phone number already exists' });
  }
  console.error(fallback, error);
  return res.status(500).json({ success: false, message: fallback });
};

const validateReferences = async ({
  tenantId,
  businessId,
  planId,
  assignedStaffId,
  assignedTrainerId
}) => {
  if (planId !== undefined && planId !== null && planId !== '') {
    if (!isValidId(planId)) return 'Invalid membership plan';
    const plan = await MembershipPlan.findOne({
      _id: planId,
      tenantId,
      businessId,
      status: 'Active'
    }).select('_id').lean();
    if (!plan) return 'Membership plan not found or inactive';
  }
  if (assignedStaffId !== undefined && assignedStaffId !== null && assignedStaffId !== '') {
    if (!isValidId(assignedStaffId)) return 'Invalid assigned staff member';
    const staff = await TrainerStaff.findOne({
      _id: assignedStaffId,
      tenantId,
      status: 'Active'
    }).select('_id').lean();
    if (!staff) return 'Staff member not found or inactive';
  }
  if (assignedTrainerId !== undefined && assignedTrainerId !== null && assignedTrainerId !== '') {
    if (!isValidId(assignedTrainerId)) return 'Invalid assigned trainer';
    const trainer = await TrainerStaff.findOne({
      _id: assignedTrainerId,
      tenantId,
      status: 'Active',
      role: 'Trainer'
    }).select('_id').lean();
    if (!trainer) return 'Trainer not found or inactive';
  }
  return null;
};

const getDateRange = (query) => {
  const range = {};
  const from = query.from || query.dateFrom || query.startDate;
  const to = query.to || query.dateTo || query.endDate;
  if (from) {
    const parsed = parseEnquiryDate(from);
    if (parsed.error) return { error: 'Invalid from date' };
    range.$gte = parsed.value;
  }
  if (to) {
    const parsed = parseEnquiryDate(to);
    if (parsed.error) return { error: 'Invalid to date' };
    if (typeof to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      parsed.value.setUTCHours(23, 59, 59, 999);
    }
    range.$lte = parsed.value;
  }
  if (range.$gte && range.$lte && range.$gte > range.$lte) {
    return { error: 'From date must be before to date' };
  }
  return { range: Object.keys(range).length ? range : null };
};

const parseDateTime = (date, time) => {
  if (!time) return parseEnquiryDate(date);
  if (typeof date !== 'string' || typeof time !== 'string' ||
      !/^\d{1,2}:\d{2}(?::\d{2})?$/.test(time)) {
    return { error: 'Invalid date or time' };
  }
  const parsedDate = parseEnquiryDate(date);
  if (parsedDate.error) return parsedDate;
  const [hours, minutes, seconds = '0'] = time.split(':').map(Number);
  if (hours > 23 || minutes > 59 || seconds > 59) return { error: 'Invalid date or time' };
  const result = new Date(parsedDate.value);
  result.setHours(hours, minutes, seconds, 0);
  return { value: result };
};

const statusHistoryEntry = (previousStatus, newStatus, ownerId, note = '') => ({
  previousStatus: previousStatus || null,
  newStatus,
  status: newStatus,
  changedAt: new Date(),
  changedBy: ownerId,
  note
});

const rollbackMemberOrError = async ({ memberId, tenantId, businessId }) => {
  const result = await Member.deleteOne({ _id: memberId, tenantId, businessId });
  if (result.deletedCount === 1) return null;
  const remains = await Member.exists({ _id: memberId, tenantId, businessId });
  return remains ? new Error(`Created member ${memberId} still exists after rollback`) : null;
};

const duplicateEnquiryResponse = (res, enquiry) => res.status(409).json({
  success: false,
  message: 'An enquiry with this phone number already exists',
  existingEnquiryId: enquiry._id,
  enquiry
});

const getBusinessTimeZone = async (tenantId) => {
  const business = await Business.findOne({ _id: tenantId }).select('timeZone').lean();
  if (!business) return null;
  return isValidTimeZone(business.timeZone) ? business.timeZone : DEFAULT_TIME_ZONE;
};

exports.listEnquiries = async (req, res) => {
  try {
    const { page, limit, skip } = pagination(req.query);
    const filter = enquiryFilter(req);
    if (req.query.status) {
      if (!ENQUIRY_STATUSES.includes(req.query.status)) {
        return res.status(400).json({ success: false, message: 'Invalid enquiry status' });
      }
      filter.status = req.query.status;
    }
    if (req.query.search) {
      const search = String(req.query.search).trim().slice(0, 100);
      if (search) {
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.$or = [
          { fullName: { $regex: escaped, $options: 'i' } },
          { phone: { $regex: escaped, $options: 'i' } }
        ];
      }
    }
    if (req.query.from || req.query.to || req.query.dateFrom || req.query.dateTo ||
        req.query.startDate || req.query.endDate) {
      const { range, error } = getDateRange(req.query);
      if (error) return res.status(400).json({ success: false, message: error });
      filter.createdAt = range;
    }
    if (req.query.source !== undefined) {
      if (!ENQUIRY_SOURCES.includes(req.query.source)) {
        return res.status(400).json({ success: false, message: 'Invalid enquiry source' });
      }
      filter.source = req.query.source;
    }
    const assignedStaffId = req.query.assignedStaffId || req.query.staffId;
    if (assignedStaffId) {
      if (!isValidId(assignedStaffId)) {
        return res.status(400).json({ success: false, message: 'Invalid assigned staff ID' });
      }
      filter.assignedStaffId = assignedStaffId;
    }
    const [enquiries, total] = await Promise.all([
      Enquiry.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      Enquiry.countDocuments(filter)
    ]);
    return res.status(200).json({
      success: true,
      enquiries,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1
      }
    });
  } catch (error) {
    return respondError(res, error, 'Unable to fetch enquiries');
  }
};

exports.createEnquiry = async (req, res) => {
  try {
    const { tenantId, businessId, ownerId } = contextFor(req);
    const body = req.body || {};
    const fullName = String(body.fullName ?? body.name ?? '').trim();
    const phone = normalizePhone(body.phone ?? body.mobile);
    if (!fullName || fullName.length > 120 || !phone) {
      return res.status(400).json({ success: false, message: 'A valid name and phone number are required' });
    }
    if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email).trim())) {
      return res.status(400).json({ success: false, message: 'Invalid email address' });
    }
    const status = body.status || 'NEW';
    if (!ENQUIRY_STATUSES.includes(status) || status === 'CONVERTED') {
      return res.status(400).json({ success: false, message: 'Invalid enquiry status' });
    }
    const gender = body.gender || 'Other';
    if (!['Male', 'Female', 'Other'].includes(gender)) {
      return res.status(400).json({ success: false, message: 'Invalid gender' });
    }
    if (body.age !== undefined && body.age !== null && body.age !== '' &&
        typeof body.age !== 'number' && typeof body.age !== 'string') {
      return res.status(400).json({ success: false, message: 'Invalid age' });
    }
    const age = body.age === undefined || body.age === null || body.age === ''
      ? null
      : Number(body.age);
    if (age !== null && (!Number.isInteger(age) || age < 1 || age > 120)) {
      return res.status(400).json({ success: false, message: 'Age must be a whole number between 1 and 120' });
    }
    if (body.interestedIn != null && !INTEREST_OPTIONS.includes(body.interestedIn)) {
      return res.status(400).json({ success: false, message: 'Invalid enquiry interest' });
    }
    const expectedJoiningDate = body.expectedJoiningDate
      ? parseEnquiryDate(body.expectedJoiningDate, { nullable: true })
      : { value: null };
    if (expectedJoiningDate.error) {
      return res.status(400).json({ success: false, message: expectedJoiningDate.error });
    }
    const source = body.source == null || body.source === '' ? null : String(body.source).trim();
    if (source !== null && !ENQUIRY_SOURCES.includes(source)) {
      return res.status(400).json({ success: false, message: 'Invalid enquiry source' });
    }
    const nextFollowUp = body.nextFollowUpAt
      ? parseEnquiryDate(body.nextFollowUpAt, { nullable: true })
      : { value: null };
    if (nextFollowUp.error) {
      return res.status(400).json({ success: false, message: nextFollowUp.error });
    }
    const referenceError = await validateReferences({
      tenantId, businessId, planId: body.planId, assignedStaffId: body.assignedStaffId
    });
    if (referenceError) return res.status(400).json({ success: false, message: referenceError });
    const existing = await Enquiry.findOne({
      tenantId,
      businessId,
      normalizedPhone: phone.normalizedPhone
    }).lean();
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'An enquiry with this phone number already exists',
        existingEnquiryId: existing._id,
        enquiry: existing
      });
    }
    const enquiry = await Enquiry.create({
      tenantId,
      businessId,
      fullName,
      phone: phone.phone,
      normalizedPhone: phone.normalizedPhone,
      email: body.email || '',
      gender,
      age,
      interestedIn: body.interestedIn || null,
      expectedJoiningDate: expectedJoiningDate.value,
      source,
      status,
      planId: body.planId || null,
      assignedStaffId: body.assignedStaffId || null,
      nextFollowUpAt: nextFollowUp.value,
      notes: String(body.notes || '').trim(),
      statusHistory: [statusHistoryEntry(null, status, ownerId, 'Enquiry created')],
      createdBy: ownerId
    });
    return res.status(201).json({ success: true, message: 'Enquiry created successfully', enquiry });
  } catch (error) {
    if (error?.code === 11000) {
      const { tenantId, businessId } = contextFor(req);
      const phone = normalizePhone(req.body?.phone ?? req.body?.mobile);
      const existing = phone
        ? await Enquiry.findOne({ tenantId, businessId, normalizedPhone: phone.normalizedPhone }).lean()
        : null;
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'An enquiry with this phone number already exists',
          existingEnquiryId: existing._id,
          enquiry: existing
        });
      }
    }
    return respondError(res, error, 'Unable to create enquiry');
  }
};

exports.getEnquiry = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid enquiry ID' });
    }
    const enquiry = await Enquiry.findOne(enquiryFilter(req, req.params.id)).lean();
    if (!enquiry) return res.status(404).json({ success: false, message: 'Enquiry not found' });
    return res.status(200).json({ success: true, enquiry });
  } catch (error) {
    return respondError(res, error, 'Unable to fetch enquiry');
  }
};

exports.updateEnquiry = async (req, res) => {
  try {
    const { tenantId, businessId } = contextFor(req);
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid enquiry ID' });
    }
    const allowed = [
      'fullName', 'phone', 'email', 'gender', 'age', 'interestedIn',
      'expectedJoiningDate', 'source', 'planId', 'assignedStaffId',
      'nextFollowUpAt', 'notes'
    ];
    const updates = {};
    for (const field of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) updates[field] = req.body[field];
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ success: false, message: 'No editable fields supplied' });
    }
    if (updates.fullName !== undefined) {
      updates.fullName = String(updates.fullName).trim();
      if (!updates.fullName || updates.fullName.length > 120) {
        return res.status(400).json({ success: false, message: 'Invalid enquiry name' });
      }
    }
    if (updates.phone !== undefined) {
      const parsed = normalizePhone(updates.phone);
      if (!parsed) return res.status(400).json({ success: false, message: 'Invalid phone number' });
      updates.phone = parsed.phone;
      updates.normalizedPhone = parsed.normalizedPhone;
    }
    if (updates.email !== undefined) {
      updates.email = String(updates.email || '').trim().toLowerCase();
      if (updates.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.email)) {
        return res.status(400).json({ success: false, message: 'Invalid email address' });
      }
    }
    if (updates.gender !== undefined && !['Male', 'Female', 'Other'].includes(updates.gender)) {
      return res.status(400).json({ success: false, message: 'Invalid gender' });
    }
    if (updates.age !== undefined) {
      if (updates.age !== null && updates.age !== '' &&
          typeof updates.age !== 'number' && typeof updates.age !== 'string') {
        return res.status(400).json({ success: false, message: 'Invalid age' });
      }
      updates.age = updates.age === '' || updates.age === null ? null : Number(updates.age);
      if (updates.age !== null && (!Number.isInteger(updates.age) || updates.age < 1 || updates.age > 120)) {
        return res.status(400).json({ success: false, message: 'Age must be a whole number between 1 and 120' });
      }
    }
    if (updates.interestedIn !== undefined &&
        updates.interestedIn !== null &&
        updates.interestedIn !== '' &&
        !INTEREST_OPTIONS.includes(updates.interestedIn)) {
      return res.status(400).json({ success: false, message: 'Invalid enquiry interest' });
    }
    if (updates.interestedIn === '') updates.interestedIn = null;
    if (updates.source !== undefined) {
      updates.source = updates.source == null || updates.source === '' ? null : String(updates.source).trim();
      if (updates.source !== null && !ENQUIRY_SOURCES.includes(updates.source)) {
        return res.status(400).json({ success: false, message: 'Invalid enquiry source' });
      }
    }
    if (updates.notes !== undefined) updates.notes = String(updates.notes || '').trim();
    if (updates.expectedJoiningDate !== undefined) {
      const parsed = parseEnquiryDate(updates.expectedJoiningDate, { nullable: true });
      if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
      updates.expectedJoiningDate = parsed.value;
    }
    if (updates.nextFollowUpAt !== undefined) {
      const parsed = parseEnquiryDate(updates.nextFollowUpAt, { nullable: true });
      if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
      updates.nextFollowUpAt = parsed.value;
    }
    if (updates.planId === '') updates.planId = null;
    if (updates.assignedStaffId === '') updates.assignedStaffId = null;
    const referenceError = await validateReferences({
      tenantId, businessId, planId: updates.planId, assignedStaffId: updates.assignedStaffId
    });
    if (referenceError) return res.status(400).json({ success: false, message: referenceError });
    const enquiry = await Enquiry.findOneAndUpdate(
      { ...enquiryFilter(req, req.params.id), status: { $ne: 'CONVERTED' } },
      { $set: { ...updates, updatedBy: req.owner._id } },
      { new: true, runValidators: true }
    );
    if (!enquiry) {
      const exists = await Enquiry.exists(enquiryFilter(req, req.params.id));
      return res.status(exists ? 409 : 404).json({
        success: false,
        message: exists ? 'Converted enquiries cannot be edited' : 'Enquiry not found'
      });
    }
    return res.status(200).json({ success: true, message: 'Enquiry updated successfully', enquiry });
  } catch (error) {
    if (error?.code === 11000 && error.keyPattern?.normalizedPhone) {
      const { tenantId, businessId } = contextFor(req);
      const phone = normalizePhone(req.body?.phone);
      const existing = phone
        ? await Enquiry.findOne({
          tenantId,
          businessId,
          normalizedPhone: phone.normalizedPhone
        }).lean()
        : null;
      if (existing) return duplicateEnquiryResponse(res, existing);
    }
    return respondError(res, error, 'Unable to update enquiry');
  }
};

exports.deleteEnquiry = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid enquiry ID' });
    }
    const enquiry = await Enquiry.findOneAndDelete(enquiryFilter(req, req.params.id));
    if (!enquiry) return res.status(404).json({ success: false, message: 'Enquiry not found' });
    return res.status(200).json({ success: true, message: 'Enquiry deleted successfully' });
  } catch (error) {
    return respondError(res, error, 'Unable to delete enquiry');
  }
};

exports.updateEnquiryStatus = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid enquiry ID' });
    }
    const { status, note = '' } = req.body || {};
    if (!ENQUIRY_STATUSES.includes(status) || status === 'CONVERTED') {
      return res.status(400).json({ success: false, message: 'Invalid enquiry status' });
    }
    const previous = await Enquiry.findOne(enquiryFilter(req, req.params.id)).select('status').lean();
    if (!previous) return res.status(404).json({ success: false, message: 'Enquiry not found' });
    if (previous.status === 'CONVERTED') {
      return res.status(409).json({ success: false, message: 'Converted enquiries cannot change status' });
    }
    const enquiry = await Enquiry.findOneAndUpdate(
      { ...enquiryFilter(req, req.params.id), status: previous.status },
      {
        $set: { status, updatedBy: req.owner._id },
        $push: {
          statusHistory: statusHistoryEntry(previous.status, status, req.owner._id, String(note).trim())
        }
      },
      { new: true, runValidators: true }
    );
    if (!enquiry) {
      return res.status(409).json({ success: false, message: 'Enquiry status changed; reload and retry' });
    }
    return res.status(200).json({ success: true, message: 'Enquiry status updated', enquiry });
  } catch (error) {
    return respondError(res, error, 'Unable to update enquiry status');
  }
};

exports.getStatusHistory = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid enquiry ID' });
    const enquiry = await Enquiry.findOne(enquiryFilter(req, req.params.id)).select('statusHistory').lean();
    if (!enquiry) return res.status(404).json({ success: false, message: 'Enquiry not found' });
    return res.status(200).json({ success: true, history: enquiry.statusHistory });
  } catch (error) {
    return respondError(res, error, 'Unable to fetch status history');
  }
};

exports.addFollowUp = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid enquiry ID' });
    const body = req.body || {};
    const followUpDate = parseDateTime(body.followUpAt || body.date, body.time);
    const nextDate = body.nextFollowUpAt
      ? parseEnquiryDate(body.nextFollowUpAt, { nullable: true })
      : { value: null };
    if (followUpDate.error || nextDate.error) {
      return res.status(400).json({ success: false, message: followUpDate.error || nextDate.error });
    }
    const { tenantId, businessId } = contextFor(req);
    const referenceError = await validateReferences({
      tenantId,
      businessId,
      assignedStaffId: body.assignedStaffId
    });
    if (referenceError) return res.status(400).json({ success: false, message: referenceError });
    const previous = await Enquiry.findOne(enquiryFilter(req, req.params.id)).select('status').lean();
    if (!previous) return res.status(404).json({ success: false, message: 'Enquiry not found' });
    if (previous.status === 'CONVERTED') {
      return res.status(409).json({ success: false, message: 'Converted enquiries cannot record follow-ups' });
    }
    const followUp = {
      followUpAt: followUpDate.value,
      date: followUpDate.value,
      assignedStaffId: body.assignedStaffId || null,
      outcome: String(body.outcome || '').trim(),
      note: String(body.note || body.notes || '').trim(),
      notes: String(body.note || body.notes || '').trim(),
      nextFollowUpAt: nextDate.value,
      createdBy: req.owner._id
    };
    const update = {
      $set: { status: 'FOLLOW_UP', updatedBy: req.owner._id },
      $push: {
        followUps: followUp,
        statusHistory: statusHistoryEntry(previous.status, 'FOLLOW_UP', req.owner._id, 'Follow-up recorded')
      }
    };
    if (body.nextFollowUpAt !== undefined) update.$set.nextFollowUpAt = nextDate.value;
    const enquiry = await Enquiry.findOneAndUpdate(
      { ...enquiryFilter(req, req.params.id), status: previous.status },
      update,
      { new: true, runValidators: true }
    );
    if (!enquiry) return res.status(409).json({ success: false, message: 'Enquiry changed; reload and retry' });
    return res.status(201).json({ success: true, message: 'Follow-up recorded', followUps: enquiry.followUps });
  } catch (error) {
    return respondError(res, error, 'Unable to record follow-up');
  }
};

exports.getFollowUps = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid enquiry ID' });
    const enquiry = await Enquiry.findOne(enquiryFilter(req, req.params.id)).select('followUps').lean();
    if (!enquiry) return res.status(404).json({ success: false, message: 'Enquiry not found' });
    return res.status(200).json({ success: true, followUps: enquiry.followUps });
  } catch (error) {
    return respondError(res, error, 'Unable to fetch follow-ups');
  }
};

exports.addTrial = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid enquiry ID' });
    const body = req.body || {};
    const start = parseDateTime(body.startDate || body.date, body.time);
    const end = body.endDate ? parseEnquiryDate(body.endDate, { nullable: true }) : { value: null };
    const nextFollowUp = body.nextFollowUpAt
      ? parseEnquiryDate(body.nextFollowUpAt, { nullable: true })
      : { value: null };
    const status = normalizeTrialStatus(body.status || 'SCHEDULED');
    if (start.error || end.error || nextFollowUp.error) {
      return res.status(400).json({
        success: false,
        message: start.error || end.error || nextFollowUp.error
      });
    }
    if (end.value && end.value < start.value) {
      return res.status(400).json({ success: false, message: 'Trial end date must be after its start date' });
    }
    if (!TRIAL_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid trial status' });
    }
    const { tenantId, businessId } = contextFor(req);
    const referenceError = await validateReferences({
      tenantId,
      businessId,
      assignedTrainerId: body.assignedTrainerId
    });
    if (referenceError) return res.status(400).json({ success: false, message: referenceError });
    const previous = await Enquiry.findOne(enquiryFilter(req, req.params.id)).select('status').lean();
    if (!previous) return res.status(404).json({ success: false, message: 'Enquiry not found' });
    if (previous.status === 'CONVERTED') {
      return res.status(409).json({ success: false, message: 'Converted enquiries cannot record trials' });
    }
    const trial = {
      date: start.value,
      startDate: start.value,
      endDate: end.value,
      nextFollowUpAt: nextFollowUp.value,
      status,
      assignedTrainerId: body.assignedTrainerId || null,
      feedback: String(body.feedback || '').trim(),
      notes: String(body.notes || '').trim(),
      createdBy: req.owner._id
    };
    const update = { $push: { trials: trial } };
    update.$set = { updatedBy: req.owner._id };
    if (body.nextFollowUpAt !== undefined) {
      update.$set.nextFollowUpAt = nextFollowUp.value;
    }
    if (status === 'SCHEDULED') {
      update.$set.status = 'TRIAL_SCHEDULED';
      update.$push.statusHistory = statusHistoryEntry(
        previous.status,
        'TRIAL_SCHEDULED',
        req.owner._id,
        'Trial scheduled'
      );
    }
    const enquiry = await Enquiry.findOneAndUpdate(
      { ...enquiryFilter(req, req.params.id), status: previous.status },
      update,
      { new: true, runValidators: true }
    );
    if (!enquiry) return res.status(409).json({ success: false, message: 'Enquiry changed; reload and retry' });
    return res.status(201).json({ success: true, message: 'Trial recorded', trials: enquiry.trials });
  } catch (error) {
    return respondError(res, error, 'Unable to record trial');
  }
};

exports.getTrials = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid enquiry ID' });
    const enquiry = await Enquiry.findOne(enquiryFilter(req, req.params.id)).select('trials').lean();
    if (!enquiry) return res.status(404).json({ success: false, message: 'Enquiry not found' });
    return res.status(200).json({ success: true, trials: enquiry.trials });
  } catch (error) {
    return respondError(res, error, 'Unable to fetch trial history');
  }
};

exports.getEnquiryDashboard = async (req, res) => {
  try {
    const filter = enquiryFilter(req);
    const now = new Date();
    const timeZone = await getBusinessTimeZone(req.tenantId);
    if (!timeZone) return res.status(404).json({ success: false, message: 'Business not found' });
    const periods = getDashboardPeriods(now, timeZone);
    const todayStart = periods.todayStart;
    const todayEnd = new Date(periods.tomorrowStart.getTime() - 1);
    const openStatusFilter = { status: { $nin: ['CONVERTED', 'LOST'] } };
    const [
      total,
      statusCounts,
      newEnquiries,
      interested,
      followUpsToday,
      overdueFollowUps,
      trialsScheduled,
      converted,
      lost
    ] = await Promise.all([
      Enquiry.countDocuments(filter),
      Enquiry.aggregate([
        { $match: filter },
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]),
      Enquiry.countDocuments({ ...filter, status: 'NEW' }),
      Enquiry.countDocuments({ ...filter, status: 'INTERESTED' }),
      Enquiry.countDocuments({
        ...filter,
        ...openStatusFilter,
        nextFollowUpAt: { $gte: todayStart, $lte: todayEnd }
      }),
      Enquiry.countDocuments({
        ...filter,
        ...openStatusFilter,
        nextFollowUpAt: { $ne: null, $lt: todayStart }
      }),
      Enquiry.countDocuments({
        ...filter,
        trials: {
          $elemMatch: {
            startDate: { $gte: todayStart },
            status: 'SCHEDULED'
          }
        }
      }),
      Enquiry.countDocuments({ ...filter, status: 'CONVERTED' }),
      Enquiry.countDocuments({ ...filter, status: 'LOST' })
    ]);
    return res.status(200).json({
      success: true,
      dashboard: {
        total,
        statusCounts: Object.fromEntries(statusCounts.map(({ _id, count }) => [_id, count])),
        new: newEnquiries,
        interested,
        followUpsToday,
        overdueFollowUps,
        trialsScheduled,
        converted,
        conversionRate: total ? Number(((converted / total) * 100).toFixed(2)) : 0,
        lost,
        overdue: overdueFollowUps,
        dueFollowUps: followUpsToday + overdueFollowUps
      }
    });
  } catch (error) {
    return respondError(res, error, 'Unable to fetch enquiry dashboard');
  }
};

exports.getEnquiryAnalytics = async (req, res) => {
  try {
    const filter = enquiryFilter(req);
    const timeZone = await getBusinessTimeZone(req.tenantId);
    if (!timeZone) return res.status(404).json({ success: false, message: 'Business not found' });
    if (req.query.from || req.query.to || req.query.dateFrom || req.query.dateTo ||
        req.query.startDate || req.query.endDate) {
      const { range, error } = getDateRange(req.query);
      if (error) return res.status(400).json({ success: false, message: error });
      filter.createdAt = range;
    }
    const [result = {}] = await Enquiry.aggregate([
      { $match: filter },
      {
        $facet: {
          statuses: [
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
          ],
          sources: [
            {
              $group: {
                _id: { $ifNull: ['$source', 'Unknown'] },
                total: { $sum: 1 },
                converted: { $sum: { $cond: [{ $eq: ['$status', 'CONVERTED'] }, 1, 0] } },
                lost: { $sum: { $cond: [{ $eq: ['$status', 'LOST'] }, 1, 0] } }
              }
            },
            { $sort: { total: -1, _id: 1 } }
          ],
          monthly: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: timeZone } },
                total: { $sum: 1 },
                converted: { $sum: { $cond: [{ $eq: ['$status', 'CONVERTED'] }, 1, 0] } },
                lost: { $sum: { $cond: [{ $eq: ['$status', 'LOST'] }, 1, 0] } }
              }
            },
            { $sort: { _id: 1 } }
          ],
          staff: [
            {
              $group: {
                _id: '$assignedStaffId',
                total: { $sum: 1 },
                converted: { $sum: { $cond: [{ $eq: ['$status', 'CONVERTED'] }, 1, 0] } },
                lost: { $sum: { $cond: [{ $eq: ['$status', 'LOST'] }, 1, 0] } }
              }
            },
            {
              $lookup: {
                from: 'trainerstaffs',
                let: { staffId: '$_id' },
                pipeline: [{
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$_id', '$$staffId'] },
                        { $eq: ['$tenantId', req.tenantId] }
                      ]
                    }
                  }
                }, { $project: { name: 1, role: 1 } }],
                as: 'staff'
              }
            },
            {
              $project: {
                _id: 0,
                staffId: '$_id',
                staffName: { $ifNull: [{ $arrayElemAt: ['$staff.name', 0] }, 'Unassigned'] },
                total: 1,
                converted: 1,
                lost: 1,
                conversionRate: {
                  $cond: [{ $gt: ['$total', 0] }, { $multiply: [{ $divide: ['$converted', '$total'] }, 100] }, 0]
                }
              }
            },
            { $sort: { total: -1, staffName: 1 } }
          ],
          totals: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                converted: { $sum: { $cond: [{ $eq: ['$status', 'CONVERTED'] }, 1, 0] } },
                lost: { $sum: { $cond: [{ $eq: ['$status', 'LOST'] }, 1, 0] } }
              }
            }
          ]
        }
      }
    ]);
    const totals = result.totals?.[0] || { total: 0, converted: 0, lost: 0 };
    return res.status(200).json({
      success: true,
      analytics: {
        total: totals.total,
        converted: totals.converted,
        lost: totals.lost,
        conversionRate: totals.total ? Number(((totals.converted / totals.total) * 100).toFixed(2)) : 0,
        statuses: result.statuses || [],
        sources: result.sources || [],
        sourceTotals: result.sources || [],
        monthly: result.monthly || [],
        monthlyEnquiryTrend: result.monthly || [],
        staff: result.staff || [],
        staffWise: result.staff || []
      }
    });
  } catch (error) {
    return respondError(res, error, 'Unable to fetch enquiry analytics');
  }
};

exports.convertEnquiryToMember = async (req, res) => {
  let createdMember;
  try {
    const { tenantId, businessId, ownerId } = contextFor(req);
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid enquiry ID' });
    }
    const enquiry = await Enquiry.findOne(enquiryFilter(req, req.params.id)).lean();
    if (!enquiry) return res.status(404).json({ success: false, message: 'Enquiry not found' });
    if (enquiry.status === 'CONVERTED' || enquiry.convertedMemberId) {
      return res.status(409).json({ success: false, message: 'Enquiry has already been converted' });
    }
    const phoneDigits = normalizePhone(enquiry.phone)?.normalizedPhone;
    const memberPhonePatterns = phoneDigits
      ? [phoneDigits, ...(phoneDigits.length === 10 ? [`91${phoneDigits}`] : [])]
        .map(digits => `^\\D*${digits.split('').join('\\D*')}\\D*$`)
      : [];
    const existingMember = await Member.findOne({
      tenantId,
      businessId,
      phone: { $in: memberPhonePatterns.map(pattern => new RegExp(pattern)) },
      deletedAt: null
    }).select('_id fullName phone').lean();
    if (existingMember) {
      return res.status(409).json({
        success: false,
        message: 'A member with this phone number already exists',
        existingMemberId: existingMember._id,
        member: existingMember
      });
    }
    const body = req.body || {};
    if (body.email !== undefined && body.email !== null && body.email !== '' &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email).trim())) {
      return res.status(400).json({ success: false, message: 'Invalid email address' });
    }
    const gender = body.gender || enquiry.gender || 'Other';
    if (!['Male', 'Female', 'Other'].includes(gender)) {
      return res.status(400).json({ success: false, message: 'Invalid gender' });
    }
    const dateOfBirth = body.dateOfBirth
      ? parseEnquiryDate(body.dateOfBirth, { nullable: true })
      : { value: null };
    const joiningDate = body.joiningDate
      ? parseEnquiryDate(body.joiningDate, { nullable: true })
      : enquiry.expectedJoiningDate
        ? { value: enquiry.expectedJoiningDate }
        : { value: new Date() };
    if (dateOfBirth.error || joiningDate.error) {
      return res.status(400).json({ success: false, message: dateOfBirth.error || joiningDate.error });
    }
    createdMember = await Member.create({
      tenantId,
      businessId,
      fullName: enquiry.fullName,
      phone: enquiry.phone,
      email: body.email === undefined ? enquiry.email : String(body.email).trim().toLowerCase(),
      gender,
      dateOfBirth: dateOfBirth.value,
      address: String(body.address || '').trim(),
      emergencyContact: String(body.emergencyContact || '').trim(),
      joiningDate: joiningDate.value,
      notes: String(body.notes || enquiry.notes || '').trim(),
      sourceEnquiryId: enquiry._id,
      createdBy: ownerId
    });
    const convertedAt = new Date();
    const result = await Enquiry.updateOne(
      {
        _id: enquiry._id,
        tenantId,
        businessId,
        status: { $ne: 'CONVERTED' },
        convertedMemberId: null
      },
      {
        $set: {
          status: 'CONVERTED',
          convertedMemberId: createdMember._id,
          convertedAt,
          updatedBy: ownerId
        },
        $push: {
          statusHistory: statusHistoryEntry(enquiry.status, 'CONVERTED', ownerId, 'Converted to member')
        }
      }
    );
    if (!result.matchedCount) {
      const rollbackError = await rollbackMemberOrError({
        memberId: createdMember._id,
        tenantId,
        businessId
      });
      if (rollbackError) {
        createdMember = null;
        console.error('Enquiry conversion rollback failed', rollbackError);
        return res.status(500).json({
          success: false,
          message: 'Conversion did not complete and member rollback failed; manual recovery is required',
          conversionRollbackFailed: true,
          memberId: rollbackError.message.match(/member ([a-f\d]{24})/i)?.[1] || null
        });
      }
      createdMember = null;
      const existing = await Enquiry.findOne(enquiryFilter(req, req.params.id)).lean();
      return res.status(409).json({
        success: false,
        message: 'Enquiry has already been converted',
        existingEnquiryId: existing?._id || enquiry._id,
        enquiry: existing
      });
    }
    return res.status(201).json({
      success: true,
      message: 'Enquiry converted to member successfully',
      member: createdMember,
      enquiry: { ...enquiry, status: 'CONVERTED', convertedMemberId: createdMember._id, convertedAt }
    });
  } catch (error) {
    if (createdMember?._id) {
      try {
        const rollbackError = await rollbackMemberOrError({
          memberId: createdMember._id,
          tenantId: req.tenantId,
          businessId: req.owner.businessId || req.tenantId
        });
        if (rollbackError) throw rollbackError;
        createdMember = null;
      } catch (rollbackError) {
        console.error('Unable to roll back member after enquiry conversion failed', rollbackError);
        return res.status(500).json({
          success: false,
          message: 'Conversion failed and member rollback failed; manual recovery is required',
          conversionRollbackFailed: true,
          memberId: createdMember._id
        });
      }
    }
    if (error?.code === 11000) {
      if (error.keyPattern?.sourceEnquiryId) {
        return res.status(409).json({
          success: false,
          message: 'This enquiry is already being converted or has been converted',
          existingEnquiryId: req.params.id
        });
      }
      return res.status(409).json({
        success: false,
        message: 'A member or enquiry with this phone number already exists'
      });
    }
    return respondError(res, error, 'Unable to convert enquiry to member');
  }
};

exports._validateReferences = validateReferences;
exports._enquiryFilter = enquiryFilter;
