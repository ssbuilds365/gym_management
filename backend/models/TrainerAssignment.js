const mongoose = require('mongoose');

const trainerAssignmentSchema = new mongoose.Schema({
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
  memberId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Member',
    required: true
  },
  trainerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TrainerStaff',
    required: true
  },
  assignmentRole: {
    type: String,
    enum: ['Primary', 'Additional'],
    required: true,
    default: 'Primary'
  },
  trainingType: {
    type: String,
    enum: ['General', 'Personal Training'],
    required: true,
    default: 'General'
  },
  assignedAt: {
    type: Date,
    required: true,
    default: Date.now
  },
  endedAt: {
    type: Date,
    default: null
  },
  status: {
    type: String,
    enum: ['Active', 'Ended'],
    required: true,
    default: 'Active'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Owner',
    required: true
  }
}, { timestamps: true });

trainerAssignmentSchema.index({ tenantId: 1, memberId: 1, assignedAt: -1 });
trainerAssignmentSchema.index({ tenantId: 1, trainerId: 1, status: 1, assignedAt: -1 });
trainerAssignmentSchema.index(
  { tenantId: 1, memberId: 1, assignmentRole: 1 },
  { unique: true, partialFilterExpression: { assignmentRole: 'Primary', status: 'Active' } }
);
trainerAssignmentSchema.index(
  { tenantId: 1, memberId: 1, trainerId: 1, assignmentRole: 1 },
  { unique: true, partialFilterExpression: { status: 'Active' } }
);

module.exports = mongoose.model('TrainerAssignment', trainerAssignmentSchema);
