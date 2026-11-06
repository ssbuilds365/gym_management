
const mongoose = require('mongoose');

const Payment = require('../models/Payment');
const Member = require('../models/Member');
const MemberMembership = require('../models/MemberMembership');
const MembershipPlan = require('../models/MembershipPlan');
const Business = require('../models/Business');
const { toMinorUnits, fromMinorUnits } = require('../utils/currency');
const { calculateGst, isValidStateCode } = require('../utils/gst');
const crypto = require('crypto');

const makeNumber = (prefix) =>
  `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

const getPaymentStatus = (totalFees, totalPaid) => {
  if (totalPaid >= totalFees) return 'FULLY PAID';
  if (totalPaid > 0) return 'PARTIALLY PAID';
  return 'UNPAID';
};

const paymentSummary = (totalFees, totalPaid, transactionAmount) => ({
  totalMembershipFees: fromMinorUnits(totalFees),
  amountReceived: fromMinorUnits(transactionAmount),
  totalAmountPaid: fromMinorUnits(totalPaid),
  pendingAmount: fromMinorUnits(Math.max(0, totalFees - totalPaid)),
  status: getPaymentStatus(totalFees, totalPaid)
});

// Create Payment
exports.createPayment = async (req, res) => {
  let session;

  try {
    const {
      memberId,
      membershipId,
      amount,
      paymentMethod,
      paymentType,
      transactionId,
      paymentDate,
      notes,
      placeOfSupplyStateCode
    } = req.body;

    // Basic validation
    if (!memberId || !membershipId || amount === undefined || amount === null || amount === '' || !paymentMethod) {
      return res.status(400).json({
        success: false,
        message: 'Member, membership, amount and payment method are required'
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(memberId) ||
      !mongoose.Types.ObjectId.isValid(membershipId)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid member or membership ID'
      });
    }

    const paymentCents = toMinorUnits(amount);

    if (paymentCents === null || paymentCents <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Enter a valid payment amount with no more than two decimal places'
      });
    }

    const allowedMethods = [
      'Cash',
      'UPI',
      'Card',
      'Bank Transfer',
      'Razorpay'
    ];

    if (!allowedMethods.includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment method'
      });
    }

    const allowedTypes = [
      'Membership Fee',
      'Registration Fee',
      'Other'
    ];

    const selectedPaymentType = paymentType || 'Membership Fee';

    if (!allowedTypes.includes(selectedPaymentType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment type'
      });
    }

    const selectedDate = paymentDate
      ? new Date(paymentDate)
      : new Date();

    if (Number.isNaN(selectedDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment date'
      });
    }

    const externalReference = String(transactionId || '').trim();
    if (externalReference.length > 120) {
      return res.status(400).json({
        success: false,
        message: 'Transaction reference cannot exceed 120 characters'
      });
    }

    session = await mongoose.startSession();

    let createdPaymentId;

    await session.withTransaction(async () => {
      const business = await Business.findById(req.tenantId).session(session);
      if (!business || String(business._id) !== String(req.owner.businessId)) {
        throw new Error('Business not found');
      }

      const member = await Member.findOne({
        _id: memberId,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        deletedAt: null
      }).session(session);

      if (!member) {
        throw new Error('Member not found');
      }

      const membership = await MemberMembership.findOne({
        _id: membershipId,
        memberId,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        status: { $ne: 'Cancelled' }
      }).session(session);

      if (!membership) {
        throw new Error('Membership not found');
      }

      if (externalReference) {
        const duplicate = await Payment.findOne({
          tenantId: req.tenantId,
          businessId: req.owner.businessId,
          transactionId: externalReference
        }).session(session);
        if (duplicate) {
          const error = new Error('This transaction reference is already recorded');
          error.statusCode = 409;
          throw error;
        }
      }

      const priorPayments = await Payment.find({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        membershipId,
        status: 'Success'
      }).select('amount').session(session).lean();
      const currentPaidCents = priorPayments.reduce((total, record) => {
        const amountCents = toMinorUnits(record.amount);
        if (amountCents === null) throw new Error('Membership payment ledger is invalid');
        return total + amountCents;
      }, 0);
      const planPriceCents = toMinorUnits(membership.planPrice);

      if (currentPaidCents === null || planPriceCents === null) {
        throw new Error('Membership balance is invalid');
      }

      const pendingCents = planPriceCents - currentPaidCents;

      if (pendingCents <= 0) {
        throw new Error('This membership has no pending fees');
      }

      if (paymentCents > pendingCents) {
        throw new Error(
          `Payment cannot exceed pending amount of ₹${fromMinorUnits(pendingCents)}`
        );
      }

      const plan = await MembershipPlan.findOne({
        _id: membership.planId,
        tenantId: req.tenantId,
        businessId: req.owner.businessId
      }).select('planName').session(session);
      if (!plan) throw new Error('Membership plan not found');

      let taxInvoice = null;
      if (membership.gstSnapshot?.enabled) {
        const placeCode = membership.placeOfSupplyStateCode || String(placeOfSupplyStateCode || '');
        if (!isValidStateCode(placeCode)) {
          throw new Error('Select a valid place-of-supply state before recording this GST-enabled membership payment');
        }
        if (
          membership.placeOfSupplyStateCode &&
          placeOfSupplyStateCode &&
          membership.placeOfSupplyStateCode !== placeOfSupplyStateCode
        ) {
          throw new Error('Place of supply must match the state recorded on the original invoice');
        }

        const tax = calculateGst({
          configuredPrice: toMinorUnits(membership.gstSnapshot.configuredPrice),
          rate: membership.gstSnapshot.gstPercentage,
          inclusive: membership.gstSnapshot.taxInclusive,
          businessStateCode: membership.gstSnapshot.stateCode,
          placeOfSupplyStateCode: placeCode
        });
        if (tax.totalAmount !== planPriceCents) {
          throw new Error('Saved GST invoice totals do not match the membership balance');
        }

        const invoiceNumber = membership.invoiceNumber || makeNumber(
          `SSGST-${String(req.owner.businessId).slice(-6)}`
        );
        membership.invoiceNumber = invoiceNumber;
        membership.placeOfSupplyStateCode = placeCode;
        membership.taxBreakdown = {
          ...tax,
          taxableAmount: fromMinorUnits(tax.taxableAmount),
          cgst: fromMinorUnits(tax.cgst),
          sgst: fromMinorUnits(tax.sgst),
          igst: fromMinorUnits(tax.igst),
          totalTax: fromMinorUnits(tax.totalTax),
          totalAmount: fromMinorUnits(tax.totalAmount)
        };
        taxInvoice = {
          invoiceNumber,
          issueDate: selectedDate,
          gstinNumber: membership.gstSnapshot.gstinNumber,
          legalBusinessName: membership.gstSnapshot.legalBusinessName,
          registeredBusinessAddress: membership.gstSnapshot.registeredBusinessAddress,
          businessState: membership.gstSnapshot.state,
          businessStateCode: membership.gstSnapshot.stateCode,
          placeOfSupplyStateCode: placeCode,
          planName: plan.planName,
          configuredPrice: membership.gstSnapshot.configuredPrice,
          taxableAmount: fromMinorUnits(tax.taxableAmount),
          gstPercentage: tax.gstRate,
          cgst: fromMinorUnits(tax.cgst),
          sgst: fromMinorUnits(tax.sgst),
          igst: fromMinorUnits(tax.igst),
          totalTax: fromMinorUnits(tax.totalTax),
          totalAmount: fromMinorUnits(tax.totalAmount),
          taxInclusive: tax.inclusive,
          componentMode: tax.componentMode
        };
      }

      const totalPaidCents = currentPaidCents + paymentCents;
      const summary = paymentSummary(
        planPriceCents,
        totalPaidCents,
        paymentCents
      );
      const receiptNumber = makeNumber('SS-R');
      const receiptDate = new Date();
      const receiptSnapshot = {
        receiptNumber,
        receiptDate,
        paymentDate: selectedDate,
        business: {
          businessName: membership.gstSnapshot?.businessName || business.businessName,
          legalBusinessName: membership.gstSnapshot?.legalBusinessName || '',
          logoUrl: membership.gstSnapshot?.logoUrl || business.logoUrl || '',
          address: membership.gstSnapshot?.registeredBusinessAddress || business.address || '',
          phone: membership.gstSnapshot?.phone || business.phone || '',
          email: membership.gstSnapshot?.email || business.email || '',
          gstinNumber: membership.gstSnapshot?.gstinNumber || ''
        },
        member: {
          id: String(member._id),
          fullName: member.fullName,
          phone: member.phone
        },
        membership: {
          id: String(membership._id),
          planName: plan.planName,
          totalFees: fromMinorUnits(planPriceCents)
        },
        payment: {
          transactionId: externalReference,
          paymentMethod,
          paymentType: selectedPaymentType,
          amountReceived: fromMinorUnits(paymentCents)
        },
        summary,
        taxInvoice
      };

      const payment = new Payment({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        memberId,
        membershipId,
        amount: fromMinorUnits(paymentCents),
        paymentMethod,
        paymentType: selectedPaymentType,
        transactionId: externalReference,
        paymentDate: selectedDate,
        status: 'Success',
        notes: notes || '',
        receiptNumber,
        receiptSnapshot,
        statusHistory: [{
          status: 'Success',
          changedAt: receiptDate,
          changedBy: req.owner._id
        }],
        createdBy: req.owner._id
      });

      await payment.save({ session });

      createdPaymentId = payment._id;

      membership.paidAmount = fromMinorUnits(totalPaidCents);
      membership.paymentStatus = totalPaidCents >= planPriceCents
        ? 'Paid'
        : totalPaidCents > 0
          ? 'Partial'
          : 'Pending';

      await membership.save({ session });
    });

    // Fetch the exact payment created by this request
    const savedPayment = await Payment.findOne({
      _id: createdPaymentId,
      tenantId: req.tenantId,
      businessId: req.owner.businessId
    })
      .populate('memberId', 'fullName phone')
      .populate('membershipId', 'planPrice paidAmount paymentStatus');

    return res.status(201).json({
      success: true,
      message: 'Payment recorded successfully',
      payment: savedPayment
    });

  } catch (error) {
    console.error('Create Payment Error:', error);

    const statusCode = error.statusCode ||
      (error.message === 'Member not found' ||
       error.message === 'Membership not found' ||
       error.message === 'Membership plan not found' ||
       error.message === 'Business not found'
        ? 404
        : 400);

    return res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to record payment'
    });

  } finally {
    if (session) {
      await session.endSession();
    }
  }
};


// Get All Payments
exports.getAllPayments = async (req, res) => {
  try {
    const currentPage = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageLimit = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 25)
    );
    const filter = {
      tenantId: req.tenantId,
      businessId: req.owner.businessId
    };

    const [
      payments,
      summaryResult,
      outstandingResult
    ] = await Promise.all([
      Payment.find(filter)
        .select(
          'receiptNumber memberId membershipId amount paymentMethod paymentType transactionId paymentDate status notes'
        )
        .populate({
          path: 'memberId',
          select: 'fullName phone',
          match: { tenantId: req.tenantId, businessId: req.owner.businessId, deletedAt: null }
        })
        .populate({
          path: 'membershipId',
          select: 'planPrice paidAmount paymentStatus',
          match: { tenantId: req.tenantId, businessId: req.owner.businessId }
        })
        .sort({ paymentDate: -1 })
        .skip((currentPage - 1) * pageLimit)
        .limit(pageLimit)
        .lean(),
      Payment.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalTransactions: { $sum: 1 },
            totalCollection: {
              $sum: {
                $cond: [{ $eq: ['$status', 'Success'] }, '$amount', 0]
              }
            },
            pendingTransactions: {
              $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, 1, 0] }
            }
          }
        }
      ]),
      MemberMembership.aggregate([
        {
          $match: {
            tenantId: req.tenantId,
            businessId: req.owner.businessId,
            status: { $ne: 'Cancelled' }
          }
        },
        {
          $lookup: {
            from: 'members',
            let: { memberId: '$memberId' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$_id', '$$memberId'] },
                      { $eq: ['$tenantId', req.tenantId] },
                      { $eq: ['$businessId', req.owner.businessId] },
                      { $eq: ['$deletedAt', null] }
                    ]
                  }
                }
              }
            ],
            as: 'member'
          }
        },
        { $match: { 'member.0': { $exists: true } } },
        {
          $lookup: {
            from: 'payments',
            let: { membershipId: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$tenantId', req.tenantId] },
                      { $eq: ['$businessId', req.owner.businessId] },
                      { $eq: ['$membershipId', '$$membershipId'] },
                      { $eq: ['$status', 'Success'] }
                    ]
                  }
                }
              },
              { $group: { _id: null, paidAmount: { $sum: '$amount' } } }
            ],
            as: 'ledger'
          }
        },
        {
          $group: {
            _id: null,
            totalOutstanding: {
              $sum: {
                $max: [
                  0,
                  {
                    $round: [
                      {
                        $subtract: [
                          '$planPrice',
                          { $ifNull: [{ $arrayElemAt: ['$ledger.paidAmount', 0] }, 0] }
                        ]
                      },
                      2
                    ]
                  }
                ]
              }
            }
          }
        }
      ])
    ]);

    const summary = summaryResult[0] || {
      totalTransactions: 0,
      totalCollection: 0,
      pendingTransactions: 0,
      totalOutstanding: 0
    };
    summary.totalOutstanding = outstandingResult[0]?.totalOutstanding || 0;
    const totalPages = Math.ceil(summary.totalTransactions / pageLimit);

    return res.status(200).json({
      success: true,
      count: summary.totalTransactions,
      payments,
      summary,
      pagination: {
        currentPage,
        pageLimit,
        totalPayments: summary.totalTransactions,
        totalPages,
        hasNextPage: currentPage < totalPages,
        hasPrevPage: currentPage > 1
      }
    });

  } catch (error) {
    console.error('Get Payments Error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch payments'
    });
  }
};

// Get payment history of a specific member
exports.getMemberPayments = async (req, res) => {
  try {
    const { memberId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(memberId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid member ID'
      });
    }

    // Verify member belongs to logged-in owner's business
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

    const payments = await Payment.find({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      memberId
    })
      .populate({
        path: 'membershipId',
        select: 'planPrice paidAmount paymentStatus startDate endDate invoiceNumber gstSnapshot'
      })
      .sort({ paymentDate: -1 });

    return res.status(200).json({
      success: true,
      count: payments.length,
      payments
    });

  } catch (error) {
    console.error('Get member payments error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch member payment history'
    });
  }
};

exports.recordPaymentRefund = async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  const refundReference = String(req.body.refundReference || '').trim();
  if (req.body.confirmRefund !== true || !reason) {
    return res.status(400).json({
      success: false,
      message: 'Confirm that the refund was completed and provide a reason'
    });
  }
  if (reason.length > 500 || refundReference.length > 120) {
    return res.status(400).json({
      success: false,
      message: 'Refund reason or reference is too long'
    });
  }

  let session;
  try {
    const { paymentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(paymentId)) {
      return res.status(400).json({ success: false, message: 'Invalid payment ID' });
    }

    session = await mongoose.startSession();
    let updatedPayment;
    await session.withTransaction(async () => {
      const payment = await Payment.findOne({
        _id: paymentId,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        status: 'Success'
      }).session(session);
      if (!payment) {
        const error = new Error('Successful payment not found or already refunded');
        error.statusCode = 404;
        throw error;
      }

      const membership = await MemberMembership.findOne({
        _id: payment.membershipId,
        memberId: payment.memberId,
        tenantId: req.tenantId,
        businessId: req.owner.businessId
      }).session(session);
      if (!membership) throw new Error('Membership not found');

      const refundedAt = new Date();
      payment.status = 'Refunded';
      payment.refund = {
        amount: payment.amount,
        currency: 'INR',
        refundReference,
        reason,
        refundedAt,
        recordedBy: req.owner._id
      };
      payment.statusHistory.push({
        status: 'Refunded',
        changedAt: refundedAt,
        changedBy: req.owner._id,
        reason
      });
      await payment.save({ session });

      const remainingPayments = await Payment.find({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        membershipId: membership._id,
        status: 'Success'
      }).select('amount').session(session).lean();
      const totalPaidCents = remainingPayments.reduce((total, record) => {
        const cents = toMinorUnits(record.amount);
        if (cents === null) throw new Error('Membership payment ledger is invalid');
        return total + cents;
      }, 0);
      const totalFeesCents = toMinorUnits(membership.planPrice);
      if (totalFeesCents === null) throw new Error('Membership balance is invalid');
      membership.paidAmount = fromMinorUnits(totalPaidCents);
      membership.paymentStatus = totalPaidCents >= totalFeesCents
        ? 'Paid'
        : totalPaidCents > 0
          ? 'Partial'
          : 'Pending';
      await membership.save({ session });
      updatedPayment = payment;
    });

    return res.status(200).json({
      success: true,
      message: 'Completed refund recorded; paid balance was recalculated',
      payment: updatedPayment
    });
  } catch (error) {
    console.error('Record payment refund error:', error);
    return res.status(error.statusCode || (error.message === 'Membership not found' ? 404 : 500)).json({
      success: false,
      message: error.message || 'Unable to record payment refund'
    });
  } finally {
    if (session) await session.endSession();
  }
};

exports.getPaymentReceipt = async (req, res) => {
  try {
    const { paymentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(paymentId)) {
      return res.status(400).json({ success: false, message: 'Invalid payment ID' });
    }

    const payment = await Payment.findOne({
      _id: paymentId,
      tenantId: req.tenantId,
      businessId: req.owner.businessId
    }).lean();
    if (!payment || !['Success', 'Refunded'].includes(payment.status)) {
      return res.status(404).json({
        success: false,
        message: 'Successful payment receipt not found'
      });
    }

    const [member, membership, business] = await Promise.all([
      Member.findOne({
        _id: payment.memberId,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        deletedAt: null
      }).select('fullName phone').lean(),
      MemberMembership.findOne({
        _id: payment.membershipId,
        memberId: payment.memberId,
        tenantId: req.tenantId,
        businessId: req.owner.businessId
      }).lean(),
      Business.findById(req.tenantId).lean()
    ]);

    if (!member || !membership || !business || String(business._id) !== String(req.owner.businessId)) {
      return res.status(404).json({
        success: false,
        message: 'Payment receipt relationships could not be verified'
      });
    }

    const [plan, successfulPayments] = await Promise.all([
      MembershipPlan.findOne({
        _id: membership.planId,
        tenantId: req.tenantId,
        businessId: req.owner.businessId
      }).select('planName').lean(),
      Payment.find({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        membershipId: membership._id,
        status: 'Success'
      }).select('amount').lean()
    ]);
    if (!plan) {
      return res.status(404).json({
        success: false,
        message: 'Membership plan could not be verified'
      });
    }

    const totalPaidCents = successfulPayments.reduce((total, record) => {
      const cents = toMinorUnits(record.amount);
      return cents === null ? total : total + cents;
    }, 0);
    const totalFeesCents = toMinorUnits(membership.planPrice) || 0;
    const transactionCents = toMinorUnits(payment.amount) || 0;
    const currentSummary = paymentSummary(
      totalFeesCents,
      totalPaidCents,
      transactionCents
    );

    const receipt = payment.receiptSnapshot || {
      receiptNumber: payment.receiptNumber || '',
      receiptDate: payment.createdAt || payment.paymentDate,
      paymentDate: payment.paymentDate,
      business: {
        businessName: business.businessName,
        legalBusinessName: '',
        logoUrl: business.logoUrl || '',
        address: business.address || '',
        phone: business.phone || '',
        email: business.email || '',
        gstinNumber: ''
      },
      member: {
        id: String(member._id),
        fullName: member.fullName,
        phone: member.phone
      },
      membership: {
        id: String(membership._id),
        planName: plan.planName,
        totalFees: fromMinorUnits(totalFeesCents)
      },
      payment: {
        transactionId: payment.transactionId || '',
        paymentMethod: payment.paymentMethod,
        paymentType: payment.paymentType,
        amountReceived: fromMinorUnits(transactionCents)
      },
      summary: currentSummary,
      taxInvoice: null
    };

    return res.status(200).json({
      success: true,
      receipt: {
        ...receipt,
        currentPaymentStatus: currentSummary,
        currentTransactionStatus: payment.status
      }
    });
  } catch (error) {
    console.error('Get payment receipt error:', error);
    return res.status(500).json({
      success: false,
      message: 'Unable to load payment receipt'
    });
  }
};