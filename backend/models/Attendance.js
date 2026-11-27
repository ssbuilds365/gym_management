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
      required: false,
      default: null
    },

    subjectType: {
      type: String,
      enum: ['Member', 'Staff', 'Trainer'],
      default: 'Member'
    },

    subjectId: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: 'subjectRef',
      default: null
    },

    subjectRef: {
      type: String,
      enum: ['Member', 'TrainerStaff'],
      default: 'Member'
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

    kioskIdempotencyKey: {
      type: String,
      trim: true,
      default: null,
      select: false
    },

    status: {
      type: String,
      enum: ['Present', 'Absent', 'Late', 'Half Day', 'Leave'],
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
attendanceSchema.index({
  tenantId: 1,
  subjectType: 1,
  subjectId: 1,
  attendanceDate: 1,
  checkIn: -1
});
attendanceSchema.index(
  { tenantId: 1, kioskIdempotencyKey: 1 },
  {
    name: 'tenant_kiosk_idempotency_unique',
    unique: true,
    partialFilterExpression: { kioskIdempotencyKey: { $type: 'string' } }
  }
);
attendanceSchema.index(
  { tenantId: 1, memberId: 1, attendanceDate: 1 },
  {
    unique: true,
    partialFilterExpression: { attendanceType: 'Biometric' }
  }
);

module.exports = mongoose.model('Attendance', attendanceSchema);