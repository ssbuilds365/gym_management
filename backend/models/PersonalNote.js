const mongoose = require('mongoose');

const personalNoteSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Owner', required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  content: { type: String, required: true, trim: true, maxlength: 10000 }
}, { timestamps: true });

personalNoteSchema.index({ tenantId: 1, ownerId: 1, updatedAt: -1 });

module.exports = mongoose.model('PersonalNote', personalNoteSchema);
