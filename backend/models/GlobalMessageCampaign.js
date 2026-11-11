const mongoose = require('mongoose');

const recipientSchema = new mongoose.Schema({
  memberId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Member',
    required: true
  },
  memberName: { type: String, required: true, trim: true },
  mobile: { type: String, required: true, trim: true },
  expiryDate: { type: Date, default: null },
  pendingAmount: { type: Number, min: 0, default: 0 },
  planName: { type: String, trim: true, default: '' },
  status: {
    type: String,
    enum: [
      'PENDING',
      'WHATSAPP_OPENED',
      'MANUALLY_MARKED_SENT',
      'SKIPPED',
      'INVALID_NUMBER'
    ],
    default: 'PENDING'
  },
  whatsappOpenedAt: { type: Date, default: null },
  manuallyMarkedSentAt: { type: Date, default: null },
  skippedAt: { type: Date, default: null }
}, { _id: false });

const campaignSchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true,
    index: true
  },
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Owner',
    required: true
  },
  name: { type: String, trim: true, maxlength: 120, default: '' },
  message: { type: String, required: true, maxlength: 4000 },
  status: {
    type: String,
    enum: ['DRAFT', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'STOPPED'],
    default: 'DRAFT'
  },
  currentRecipientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Member',
    default: null
  },
  recipients: {
    type: [recipientSchema],
    validate: {
      validator: recipients => recipients.length > 0 && recipients.length <= 3000,
      message: 'A campaign must have between 1 and 3000 recipients.'
    }
  }
}, { timestamps: true });

campaignSchema.index({ tenantId: 1, businessId: 1, createdAt: -1 });
campaignSchema.index({ tenantId: 1, businessId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('GlobalMessageCampaign', campaignSchema);
