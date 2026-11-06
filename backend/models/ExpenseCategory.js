const mongoose = require('mongoose');

const expenseCategorySchema = new mongoose.Schema({
  tenantId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Business',
    required: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80
  },
  normalizedName: {
    type: String,
    required: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Owner',
    required: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Owner',
    required: true
  }
}, { timestamps: true });

expenseCategorySchema.index({ tenantId: 1, normalizedName: 1 }, { unique: true });
expenseCategorySchema.index({ tenantId: 1, isActive: 1, name: 1 });

module.exports = mongoose.model('ExpenseCategory', expenseCategorySchema);
