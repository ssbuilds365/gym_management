const mongoose = require('mongoose');

const memberSchema = new mongoose.Schema(
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

        fullName: {
            type: String,
            required: true,
            trim: true
        },

        phone: {
            type: String,
            required: true,
            trim: true
        },

        email: {
            type: String,
            trim: true,
            lowercase: true,
            default: ''
        },

        gender: {
            type: String,
            enum: ['Male', 'Female', 'Other'],
            default: 'Other'
        },

        dateOfBirth: {
            type: Date,
            default: null
        },

        address: {
            type: String,
            default: ''
        },

        emergencyContact: {
            type: String,
            default: ''
        },

        joiningDate: {
            type: Date,
            default: Date.now
        },

        status: {
            type: String,
            enum: ['Active', 'Inactive', 'On Hold'],
            default: 'Active'
        },

        assignedTrainerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'TrainerStaff',
            default: null
        },

        deletedAt: {
            type: Date,
            default: null,
            select: false
        },

        notes: {
            type: String,
            default: ''
        },

        qrTokenHash: {
            type: String,
            default: null,
            select: false
        },

        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Owner',
            required: true
        }
    },
    {
        timestamps: true
    }
);

// Same phone number can exist in different businesses,
// but should not be duplicated within the same business.
memberSchema.index(
    { tenantId: 1, phone: 1 },
    { unique: true }
);
memberSchema.index({ tenantId: 1, createdAt: -1 });
memberSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
memberSchema.index({ tenantId: 1, assignedTrainerId: 1 });

module.exports = mongoose.model('Member', memberSchema);