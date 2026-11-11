const MembershipPlan = require('../models/MembershipPlan');

// CREATE MEMBERSHIP PLAN
const createPlan = async (req, res) => {
  try {
    const { planName, duration, durationType, price, description, benefits } = req.body;

    if (!planName || !duration || price === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Plan name, duration and price are required'
      });
    }

    const plan = await MembershipPlan.create({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      createdBy: req.owner._id,
      planName,
      duration,
      durationType: durationType || 'Months',
      price,
      description: description || '',
      benefits: Array.isArray(benefits) ? benefits : []
    });

    res.status(201).json({
      success: true,
      message: 'Membership plan created successfully',
      plan
    });
  } catch (error) {
    console.error('Create Plan Error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to create membership plan'
    });
  }
};

// GET ALL MEMBERSHIP PLANS
const getAllPlans = async (req, res) => {
  try {
    const plans = await MembershipPlan.find({
      tenantId: req.tenantId
    }).sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      total: plans.length,
      plans
    });
  } catch (error) {
    console.error('Get Plans Error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to fetch membership plans'
    });
  }
};

// UPDATE MEMBERSHIP PLAN
const updatePlan = async (req, res) => {
  try {
    const allowedFields = [
      'planName',
      'duration',
      'durationType',
      'price',
      'description',
      'benefits',
      'status'
    ];

    const updates = {};

    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    const plan = await MembershipPlan.findOneAndUpdate(
      {
        _id: req.params.id,
        tenantId: req.tenantId
      },
      updates,
      {
        returnDocument: 'after',
        runValidators: true
      }
    );

    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Membership plan not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Membership plan updated successfully',
      plan
    });
  } catch (error) {
    console.error('Update Plan Error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to update membership plan'
    });
  }
};

// DELETE MEMBERSHIP PLAN
const deletePlan = async (req, res) => {
  try {
    const plan = await MembershipPlan.findOneAndDelete({
      _id: req.params.id,
      tenantId: req.tenantId
    });

    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Membership plan not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Membership plan deleted successfully'
    });
  } catch (error) {
    console.error('Delete Plan Error:', error);
    res.status(500).json({
      success: false,
      message: 'Unable to delete membership plan'
    });
  }
};

module.exports = {
  createPlan,
  getAllPlans,
  updatePlan,
  deletePlan
};