
const MemberMembership = require('../models/MemberMembership');
const Member = require('../models/Member');
const MembershipPlan = require('../models/MembershipPlan');
const Business = require('../models/Business');
const Payment = require('../models/Payment');
const { toMinorUnits, fromMinorUnits } = require('../utils/currency');
const { calculateGst } = require('../utils/gst');
const {
  addMembershipDuration,
  isValidTimeZone,
  parseMembershipStartDate,
  DEFAULT_TIME_ZONE
} = require('../utils/membershipExpiry');

// Assign membership to a member
const assignMembership = async (req, res) => {
  try {
    const { memberId, planId, startDate, paidAmount = 0 } = req.body;

    if (!memberId || !planId || !startDate) {
      return res.status(400).json({
        success: false,
        message: 'Member, plan and start date are required'
      });
    }

    const member = await Member.findOne({
      _id: memberId,
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      deletedAt: null
    });

    if (!member) {
      return res.status(404).json({
        success: false,
        message: 'Member not found'
      });
    }

    const plan = await MembershipPlan.findOne({
      _id: planId,
      tenantId: req.tenantId,
      status: 'Active'
    });

    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Active membership plan not found'
      });
    }

    const amountPaidCents = toMinorUnits(paidAmount);
    const planPriceCents = toMinorUnits(plan.price);

    if (
      amountPaidCents === null ||
      planPriceCents === null ||
      amountPaidCents < 0 ||
      amountPaidCents > planPriceCents
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid paid amount'
      });
    }
    if (amountPaidCents > 0) {
      return res.status(400).json({
        success: false,
        message: 'Record initial membership payments through Payments & Fees so the transaction and receipt are recorded.'
      });
    }

    const business = await Business.findById(req.tenantId).lean();
    if (!business || String(business._id) !== String(req.owner.businessId)) {
      return res.status(404).json({
        success: false,
        message: 'Business not found'
      });
    }

    let gstSnapshot;
    let invoiceAmountCents = planPriceCents;
    if (business.gstEnabled) {
      let tax;
      try {
        tax = calculateGst({
          configuredPrice: planPriceCents,
          rate: business.gstPercentage,
          inclusive: business.taxInclusive,
          businessStateCode: business.stateCode,
          placeOfSupplyStateCode: business.stateCode
        });
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: 'Business GST settings are incomplete or invalid; review Settings before assigning a membership.'
        });
      }

      invoiceAmountCents = tax.totalAmount;
      gstSnapshot = {
        enabled: true,
        configuredPrice: fromMinorUnits(planPriceCents),
        taxableAmount: fromMinorUnits(tax.taxableAmount),
        gstPercentage: tax.gstRate,
        totalTax: fromMinorUnits(tax.totalTax),
        totalAmount: fromMinorUnits(tax.totalAmount),
        taxInclusive: tax.inclusive,
        gstinNumber: business.gstinNumber,
        legalBusinessName: business.legalBusinessName,
        registeredBusinessAddress: business.registeredBusinessAddress,
        businessName: business.businessName,
        phone: business.phone,
        email: business.email,
        logoUrl: business.logoUrl || '',
        state: business.state,
        stateCode: business.stateCode
      };
    } else {
      gstSnapshot = {
        enabled: false,
        configuredPrice: fromMinorUnits(planPriceCents),
        taxableAmount: fromMinorUnits(planPriceCents),
        gstPercentage: 0,
        totalTax: 0,
        totalAmount: fromMinorUnits(planPriceCents),
        taxInclusive: true,
        businessName: business.businessName,
        phone: business.phone,
        email: business.email,
        address: business.address || '',
        logoUrl: business.logoUrl || ''
      };
    }

    const timeZone = isValidTimeZone(business.timeZone)
      ? business.timeZone
      : DEFAULT_TIME_ZONE;
    const membershipStartDate = parseMembershipStartDate(startDate, timeZone);

    if (!membershipStartDate) {
      return res.status(400).json({
        success: false,
        message: 'Invalid start date'
      });
    }

    const endDate = addMembershipDuration(
      membershipStartDate,
      plan.duration,
      plan.durationType,
      timeZone
    );

    const membership = await MemberMembership.create({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      memberId: member._id,
      planId: plan._id,
      startDate: membershipStartDate,
      endDate,
      planPrice: fromMinorUnits(invoiceAmountCents),
      paidAmount: 0,
      paymentStatus: 'Pending',
      gstSnapshot,
      status: 'Active',
      createdBy: req.owner._id
    });

    return res.status(201).json({
      success: true,
      message: 'Membership assigned successfully',
      membership
    });

  } catch (error) {
    console.error('Assign Membership Error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to assign membership'
    });
  }
};

// Get membership history of a member
const getMemberMemberships = async (req, res) => {
  try {
    const { memberId } = req.params;

    const member = await Member.findOne({
      _id: memberId,
      tenantId: req.tenantId,
      deletedAt: null
    });

    if (!member) {
      return res.status(404).json({
        success: false,
        message: 'Member not found'
      });
    }

    const memberships = await MemberMembership.find({
      memberId,
      tenantId: req.tenantId,
      businessId: req.owner.businessId
    })
      .populate('planId', 'planName duration durationType price')
      .sort({ createdAt: -1 });

    const membershipIds = memberships.map(membership => membership._id);
    const paidAmounts = membershipIds.length
      ? await Payment.aggregate([
          {
            $match: {
              tenantId: req.tenantId,
              businessId: req.owner.businessId,
              membershipId: { $in: membershipIds },
              status: 'Success'
            }
          },
          {
            $group: {
              _id: '$membershipId',
              paidAmount: { $sum: '$amount' }
            }
          }
        ])
      : [];
    const paidByMembership = new Map(
      paidAmounts.map(item => [String(item._id), item.paidAmount])
    );
    const membershipsWithLedgerStatus = memberships.map(membership => {
      const paidAmount = Number(paidByMembership.get(String(membership._id)) || 0);
      return {
        ...membership.toObject(),
        paidAmount,
        paymentStatus: paidAmount >= Number(membership.planPrice)
          ? 'Paid'
          : paidAmount > 0
            ? 'Partial'
            : 'Pending'
      };
    });

    return res.status(200).json({
      success: true,
      memberships: membershipsWithLedgerStatus
    });

  } catch (error) {
    console.error('Get Membership History Error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch membership history'
    });
  }
};

module.exports = {
  assignMembership,
  getMemberMemberships
};
