const mongoose = require('mongoose');

const statusHistorySchema = new mongoose.Schema({
  previousStatus: {
    type: String,
    enum: ['NEW', 'CONTACTED', 'INTERESTED', 'TRIAL_SCHEDULED', 'FOLLOW_UP', 'CONVERTED', 'LOST', null],
    default: null
  },
  newStatus: {
    type: String,
    enum: ['NEW', 'CONTACTED', 'INTERESTED', 'TRIAL_SCHEDULED', 'FOLLOW_UP', 'CONVERTED', 'LOST'],
    required: true
  },
  status: {
    type: String,
    enum: ['NEW', 'CONTACTED', 'INTERESTED', 'TRIAL_SCHEDULED', 'FOLLOW_UP', 'CONVERTED', 'LOST'],
    required: true
  },
  changedAt: { type: Date, default: Date.now },
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Owner', required: true },
  note: { type: String, trim: true, default: '' }
});

const followUpSchema = new mongoose.Schema({
  followUpAt: { type: Date, required: true },
  date: { type: Date, default: null },
  assignedStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'TrainerStaff', default: null },
  outcome: { type: String, trim: true, default: '' },
  note: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },
  nextFollowUpAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Owner', required: true }
});

const trialSchema = new mongoose.Schema({
  date: { type: Date, default: null },
  startDate: { type: Date, required: true },
  endDate: { type: Date, default: null },
  nextFollowUpAt: { type: Date, default: null },
  status: {
    type: String,
    enum: ['SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
    default: 'SCHEDULED'
  },
  assignedTrainerId: { type: mongoose.Schema.Types.ObjectId, ref: 'TrainerStaff', default: null },
  feedback: { type: String, trim: true, default: '' },
  notes: { type: String, trim: true, default: '' },
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Owner', required: true }
});

const enquirySchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  fullName: { type: String, required: true, trim: true, maxlength: 120 },
  phone: { type: String, required: true, trim: true, maxlength: 30 },
  normalizedPhone: { type: String, required: true, trim: true },
  email: { type: String, trim: true, lowercase: true, default: '' },
  gender: { type: String, enum: ['Male', 'Female', 'Other'], default: 'Other' },
  age: { type: Number, min: 1, max: 120, default: null },
  interestedIn: { type: String, enum: ['Gym Membership', 'Personal Training', 'Both'], default: null },
  expectedJoiningDate: { type: Date, default: null },
  source: {
    type: String,
    enum: ['Walk-in', 'Instagram', 'Facebook', 'WhatsApp', 'Website', 'Referral', 'Google', 'Other'],
    default: null
  },
  status: {
    type: String,
    enum: ['NEW', 'CONTACTED', 'INTERESTED', 'TRIAL_SCHEDULED', 'FOLLOW_UP', 'CONVERTED', 'LOST'],
    default: 'NEW'
  },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: 'MembershipPlan', default: null },
  assignedStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'TrainerStaff', default: null },
  nextFollowUpAt: { type: Date, default: null },
  notes: { type: String, trim: true, default: '' },
  statusHistory: { type: [statusHistorySchema], default: [] },
  followUps: { type: [followUpSchema], default: [] },
  trials: { type: [trialSchema], default: [] },
  convertedMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', default: null },
  convertedAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Owner', required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Owner', default: null }
}, { timestamps: true });

enquirySchema.index({ tenantId: 1, normalizedPhone: 1 }, { unique: true });
enquirySchema.index({ tenantId: 1, businessId: 1, createdAt: -1 });
enquirySchema.index({ tenantId: 1, businessId: 1, status: 1, createdAt: -1 });
enquirySchema.index({ tenantId: 1, businessId: 1, nextFollowUpAt: 1 });
enquirySchema.index({ tenantId: 1, businessId: 1, planId: 1 });
enquirySchema.index({ tenantId: 1, businessId: 1, assignedStaffId: 1, createdAt: -1 });
enquirySchema.index({ tenantId: 1, businessId: 1, source: 1, createdAt: -1 });

module.exports = mongoose.model('Enquiry', enquirySchema);
