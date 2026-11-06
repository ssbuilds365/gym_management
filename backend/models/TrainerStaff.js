const mongoose = require('mongoose');

const trainerStaffSchema = new mongoose.Schema(
  {
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 30 },
    email: { type: String, trim: true, lowercase: true, default: '' },
    role: { type: String, enum: ['Trainer', 'Staff'], required: true },
    specialization: { type: String, trim: true, default: '', maxlength: 120 },
    designation: { type: String, trim: true, default: '', maxlength: 120 },
    department: { type: String, trim: true, default: '', maxlength: 120 },
    joiningDate: { type: Date, default: Date.now },
    salaryAmount: { type: Number, min: 0, default: null },
    compensationType: {
      type: String,
      enum: ['Salary', 'Commission'],
      default: 'Salary'
    },
    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Owner',
      required: true
    }
  },
  { timestamps: true }
);

trainerStaffSchema.index({ tenantId: 1, createdAt: -1 });
trainerStaffSchema.index({ tenantId: 1, status: 1, role: 1 });
trainerStaffSchema.index({ tenantId: 1, role: 1, joiningDate: -1 });

module.exports = mongoose.model('TrainerStaff', trainerStaffSchema);
