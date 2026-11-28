const mongoose = require('mongoose');

const trainerSessionSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Owner', required: true, index: true },
  memberId: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  startAt: { type: Date, required: true },
  endAt: { type: Date, required: true },
  notes: { type: String, trim: true, maxlength: 2000, default: '' },
  status: {
    type: String,
    enum: ['Scheduled', 'Completed', 'Cancelled'],
    default: 'Scheduled',
    index: true
  }
}, { timestamps: true });

trainerSessionSchema.index({ tenantId: 1, ownerId: 1, startAt: 1, status: 1 });
trainerSessionSchema.index({ tenantId: 1, memberId: 1, startAt: 1 });
trainerSessionSchema.index({ tenantId: 1, businessId: 1, ownerId: 1, status: 1, endAt: 1, startAt: 1 });

module.exports = mongoose.model('TrainerSession', trainerSessionSchema);
