const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema(
  {
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

    attendanceDate: {
      type: Date,
      required: true
    },

    checkIn: {
      type: Date,
      required: true
    },

    checkOut: {
      type: Date,
      default: null
    },

    checkoutType: {
      type: String,
      enum: ['MANUAL', 'AUTOMATIC'],
      default: null
    },

    durationMinutes: {
      type: Number,
      min: 0,
      default: null
    },

    attendanceType: {
      type: String,
      enum: ['Manual', 'QR', 'Biometric'],
      default: 'Manual'
    },

    status: {
      type: String,
      enum: ['Present', 'Absent', 'Late'],
      default: 'Present'
    },

    notes: {
      type: String,
      default: ''
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Owner',
      required: true
    }
  },
  { timestamps: true }
);

// Daily attendance lookup
attendanceSchema.index({ tenantId: 1, attendanceDate: 1, checkIn: -1 });
attendanceSchema.index({ tenantId: 1, businessId: 1, checkOut: 1, checkIn: 1 });

// Member attendance history
attendanceSchema.index({
  tenantId: 1,
  memberId: 1,
  attendanceDate: -1,
  checkIn: -1
});

module.exports = mongoose.model('Attendance', attendanceSchema);