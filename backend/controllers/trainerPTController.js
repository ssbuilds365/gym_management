const mongoose = require('mongoose');
const Member = require('../models/Member');
const TrainerStaff = require('../models/TrainerStaff');
const TrainerAssignment = require('../models/TrainerAssignment');
const TrainerPTPackage = require('../models/TrainerPTPackage');
const TrainerPTPayment = require('../models/TrainerPTPayment');
const { toMinorUnits, fromMinorUnits } = require('../utils/currency');
const { netPaymentMinor, packageBalance } = require('../utils/trainerFinance');

const validId = id => mongoose.Types.ObjectId.isValid(id);
const paymentMethods = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'];
const packageTypes = [
  'Monthly',
  'Quarterly',
  'Half-Yearly',
  'Yearly',
  'One-Time Package',
  'Custom Duration'
];
const paymentFrequencies = ['One-Time', 'Monthly', 'Quarterly', 'Custom'];

const parseDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    ? null
    : date;
};

const writeError = (res, error, fallback) => {
  if (error.statusCode) {
    return res.status(error.statusCode).json({ success: false, message: error.message });
  }
  console.error(fallback, error);
  return res.status(500).json({ success: false, message: fallback });
};

const loadPackagePayments = async (ptPackage, session) => {
  let query = TrainerPTPayment.find({
    tenantId: ptPackage.tenantId,
    businessId: ptPackage.businessId,
    packageId: ptPackage._id
  }).sort({ paymentDate: -1 });
  if (session) query = query.session(session);
  return query.lean();
};

const packageResponse = async (ptPackage, session) => {
  const payments = await loadPackagePayments(ptPackage, session);
  const balance = packageBalance(ptPackage.totalFeeMinor, payments);
  return {
    ...ptPackage.toObject ? ptPackage.toObject() : ptPackage,
    totalFee: fromMinorUnits(balance.expectedMinor),
    collectedAmount: fromMinorUnits(balance.collectedMinor),
    pendingAmount: fromMinorUnits(balance.pendingMinor),
    paymentStatus: balance.paymentStatus,
    payments: payments.map(payment => ({
      ...payment,
      amount: fromMinorUnits(payment.amountMinor),
      refundedAmount: fromMinorUnits(
        (payment.refunds || []).reduce((total, refund) => total + refund.amountMinor, 0)
      ),
      netCollectedAmount: fromMinorUnits(netPaymentMinor(payment))
    }))
  };
};

const paymentMatchesRequest = (payment, request) =>
  String(payment.packageId) === String(request.packageId)
  && payment.amountMinor === request.amountMinor
  && payment.paymentMethod === request.paymentMethod
  && payment.transactionReference === request.transactionReference
  && new Date(payment.paymentDate).getTime() === request.paymentDate.getTime()
  && payment.notes === request.notes;

exports.listTrainerPTPackages = async (req, res) => {
  try {
    if (!validId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid trainer ID' });
    }
    const trainer = await TrainerStaff.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
      role: 'Trainer'
    }).select('_id').lean();
    if (!trainer) return res.status(404).json({ success: false, message: 'Trainer not found' });

    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    const filter = {
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      trainerId: trainer._id
    };
    if (['Active', 'Expired', 'Cancelled'].includes(req.query.status)) filter.status = req.query.status;
    const [packages, total] = await Promise.all([
      TrainerPTPackage.find(filter)
        .populate('memberId', 'fullName phone')
        .sort({ startDate: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      TrainerPTPackage.countDocuments(filter)
    ]);

    const rows = await Promise.all(packages.map(ptPackage => packageResponse(ptPackage)));
    return res.json({
      success: true,
      packages: rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  } catch (error) {
    return writeError(res, error, 'Unable to load personal training packages');
  }
};

exports.createTrainerPTPackage = async (req, res) => {
  try {
    const trainerId = req.params.id;
    const {
      memberId,
      packageName,
      packageType,
      startDate,
      endDate,
      totalFee,
      paymentFrequency
    } = req.body || {};
    if (!validId(trainerId) || !validId(memberId)) {
      return res.status(400).json({ success: false, message: 'Valid trainer and member IDs are required' });
    }
    if (!String(packageName || '').trim() || String(packageName).trim().length > 120) {
      return res.status(400).json({ success: false, message: 'Package name is required and must be 120 characters or fewer' });
    }
    if (!packageTypes.includes(packageType) || !paymentFrequencies.includes(paymentFrequency)) {
      return res.status(400).json({ success: false, message: 'Select a valid package type and payment frequency' });
    }
    const start = parseDate(startDate);
    const end = parseDate(endDate);
    if (!start || !end || end < start) {
      return res.status(400).json({ success: false, message: 'Enter a valid PT package date range' });
    }
    const feeMinor = toMinorUnits(totalFee);
    if (feeMinor === null || feeMinor <= 0) {
      return res.status(400).json({ success: false, message: 'Enter a positive package fee with no more than two decimal places' });
    }

    const [trainer, member, assignment] = await Promise.all([
      TrainerStaff.findOne({
        _id: trainerId,
        tenantId: req.tenantId,
        role: 'Trainer',
        status: 'Active'
      }).select('_id').lean(),
      Member.findOne({
        _id: memberId,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        deletedAt: null
      }).select('_id assignedTrainerId additionalTrainerIds').lean(),
      TrainerAssignment.findOne({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        memberId,
        trainerId,
        status: 'Active'
      }).sort({ assignedAt: -1 }).lean()
    ]);
    if (!trainer) return res.status(404).json({ success: false, message: 'Active trainer not found' });
    if (!member) return res.status(404).json({ success: false, message: 'Member not found in this business' });

    const legacyAssignment = String(member.assignedTrainerId || '') === String(trainerId)
      || (member.additionalTrainerIds || []).some(id => String(id) === String(trainerId));
    if (!assignment && !legacyAssignment) {
      return res.status(409).json({ success: false, message: 'Assign this member to the trainer before creating a PT package' });
    }

    const ptPackage = await TrainerPTPackage.create({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      memberId: member._id,
      trainerId: trainer._id,
      assignmentId: assignment?._id || null,
      packageName: String(packageName).trim(),
      packageType,
      startDate: start,
      endDate: end,
      totalFeeMinor: feeMinor,
      collectedAmountMinor: 0,
      paymentFrequency,
      status: end < new Date(new Date().toISOString().slice(0, 10)) ? 'Expired' : 'Active',
      createdBy: req.owner._id
    });
    return res.status(201).json({
      success: true,
      package: await packageResponse(ptPackage)
    });
  } catch (error) {
    return writeError(res, error, 'Unable to create personal training package');
  }
};

exports.recordTrainerPTPayment = async (req, res) => {
  let session;
  try {
    const { packageId } = req.params;
    const {
      amount,
      paymentMethod,
      transactionReference = '',
      paymentDate,
      notes = '',
      requestId = ''
    } = req.body || {};
    if (!validId(packageId)) {
      return res.status(400).json({ success: false, message: 'Invalid PT package ID' });
    }
    const amountMinor = toMinorUnits(amount);
    if (amountMinor === null || amountMinor <= 0 || !paymentMethods.includes(paymentMethod)) {
      return res.status(400).json({ success: false, message: 'Enter a valid payment amount and method' });
    }
    const date = paymentDate ? new Date(paymentDate) : new Date();
    if (Number.isNaN(date.getTime())) {
      return res.status(400).json({ success: false, message: 'Enter a valid payment date' });
    }
    const normalizedRequestId = String(requestId || '').trim();
    const externalReference = String(transactionReference).trim();
    const paymentNotes = String(notes).trim();
    if (
      externalReference.length > 120
      || normalizedRequestId.length > 120
      || paymentNotes.length > 1000
    ) {
      return res.status(400).json({ success: false, message: 'Payment reference or notes exceed the allowed length' });
    }

    session = await mongoose.startSession();
    let created;
    let duplicate = false;
    const paymentRequest = {
      packageId,
      amountMinor,
      paymentMethod,
      transactionReference: externalReference,
      paymentDate: date,
      notes: paymentNotes
    };
    await session.withTransaction(async () => {
      const filter = {
        _id: packageId,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        status: { $ne: 'Cancelled' }
      };
      const ptPackage = await TrainerPTPackage.findOne(filter).session(session);
      if (!ptPackage) {
        const error = new Error('PT package not found');
        error.statusCode = 404;
        throw error;
      }

      if (normalizedRequestId) {
        const existing = await TrainerPTPayment.findOne({
          tenantId: req.tenantId,
          businessId: req.owner.businessId,
          requestId: normalizedRequestId
        }).session(session);
        if (existing) {
          if (!paymentMatchesRequest(existing, paymentRequest)) {
            const error = new Error('This payment request ID was already used for different payment details');
            error.statusCode = 409;
            throw error;
          }
          created = existing;
          duplicate = true;
          return;
        }
      }

      if (externalReference && await TrainerPTPayment.exists({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        transactionReference: externalReference
      }).session(session)) {
        const error = new Error('This transaction reference is already recorded');
        error.statusCode = 409;
        throw error;
      }

      const updated = await TrainerPTPackage.updateOne({
        ...filter,
        collectedAmountMinor: { $lte: ptPackage.totalFeeMinor - amountMinor }
      }, {
        $inc: { collectedAmountMinor: amountMinor }
      }, { session });
      if (!updated.matchedCount) {
        const error = new Error('Payment exceeds the PT package outstanding balance');
        error.statusCode = 409;
        throw error;
      }

      [created] = await TrainerPTPayment.create([{
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        packageId: ptPackage._id,
        assignmentId: ptPackage.assignmentId,
        memberId: ptPackage.memberId,
        trainerId: ptPackage.trainerId,
        amountMinor,
        paymentMethod,
        transactionReference: externalReference,
        requestId: normalizedRequestId,
        paymentDate: date,
        status: 'Success',
        notes: paymentNotes,
        createdBy: req.owner._id
      }], { session });
    });

    const ptPackage = await TrainerPTPackage.findOne({
      _id: packageId,
      tenantId: req.tenantId,
      businessId: req.owner.businessId
    });
    return res.status(duplicate ? 200 : 201).json({
      success: true,
      duplicate,
      payment: created,
      package: await packageResponse(ptPackage)
    });
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.transactionReference) {
      return res.status(409).json({
        success: false,
        message: 'This transaction reference is already recorded'
      });
    }
    if (error.code === 11000 && error.keyPattern?.requestId && req.body?.requestId) {
      try {
        const existing = await TrainerPTPayment.findOne({
          tenantId: req.tenantId,
          businessId: req.owner.businessId,
          requestId: String(req.body.requestId).trim()
        }).lean();
        const amountMinor = toMinorUnits(req.body.amount);
        const date = req.body.paymentDate ? new Date(req.body.paymentDate) : new Date();
        const request = {
          packageId: req.params.packageId,
          amountMinor,
          paymentMethod: req.body.paymentMethod,
          transactionReference: String(req.body.transactionReference || '').trim(),
          paymentDate: date,
          notes: String(req.body.notes || '')
        };
        if (existing && paymentMatchesRequest(existing, request)) {
          const ptPackage = await TrainerPTPackage.findOne({
            _id: req.params.packageId,
            tenantId: req.tenantId,
            businessId: req.owner.businessId
          });
          if (!ptPackage) return res.status(404).json({ success: false, message: 'PT package not found' });
          return res.json({
            success: true,
            duplicate: true,
            payment: existing,
            package: await packageResponse(ptPackage)
          });
        }
      } catch (replayError) {
        console.error('Unable to resolve duplicate PT payment request:', replayError);
        return res.status(500).json({ success: false, message: 'Unable to record personal training payment' });
      }
    }
    return writeError(res, error, 'Unable to record personal training payment');
  } finally {
    if (session) await session.endSession();
  }
};

exports.refundTrainerPTPayment = async (req, res) => {
  let session;
  try {
    const { paymentId } = req.params;
    const { amount, refundReference, reason, confirmRefund } = req.body || {};
    if (!validId(paymentId)) {
      return res.status(400).json({ success: false, message: 'Invalid PT payment ID' });
    }
    if (confirmRefund !== true || !String(reason || '').trim()) {
      return res.status(400).json({ success: false, message: 'Confirm the completed refund and provide a reason' });
    }
    const refundMinor = toMinorUnits(amount);
    const reference = String(refundReference || '').trim();
    if (refundMinor === null || refundMinor <= 0 || !reference || reference.length > 120 || reason.length > 500) {
      return res.status(400).json({ success: false, message: 'Enter a valid refund amount, unique reference, and reason' });
    }

    session = await mongoose.startSession();
    let payment;
    await session.withTransaction(async () => {
      payment = await TrainerPTPayment.findOne({
        _id: paymentId,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        status: { $in: ['Success', 'Refunded'] }
      }).session(session);
      if (!payment) {
        const error = new Error('Successful PT payment not found');
        error.statusCode = 404;
        throw error;
      }
      const duplicateReference = await TrainerPTPayment.exists({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        'refunds.reference': reference
      }).session(session);
      if (duplicateReference) {
        const error = new Error('This refund reference is already recorded');
        error.statusCode = 409;
        throw error;
      }
      const alreadyRefunded = payment.refunds.reduce(
        (total, refund) => total + refund.amountMinor,
        0
      );
      if (refundMinor > payment.amountMinor - alreadyRefunded) {
        const error = new Error('Refund exceeds the unrefunded payment amount');
        error.statusCode = 409;
        throw error;
      }

      const ptPackage = await TrainerPTPackage.findOneAndUpdate({
        _id: payment.packageId,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        collectedAmountMinor: { $gte: refundMinor }
      }, {
        $inc: { collectedAmountMinor: -refundMinor }
      }, { returnDocument: 'after', session });
      if (!ptPackage) {
        const error = new Error('PT package collection balance could not be verified');
        error.statusCode = 409;
        throw error;
      }

      payment.refunds.push({
        amountMinor: refundMinor,
        reference,
        reason: String(reason).trim(),
        refundedAt: new Date(),
        recordedBy: req.owner._id
      });
      const refundedTotal = alreadyRefunded + refundMinor;
      if (refundedTotal === payment.amountMinor) payment.status = 'Refunded';
      await payment.save({ session });
    });

    const ptPackage = await TrainerPTPackage.findOne({
      _id: payment.packageId,
      tenantId: req.tenantId,
      businessId: req.owner.businessId
    });
    return res.json({
      success: true,
      payment,
      package: await packageResponse(ptPackage)
    });
  } catch (error) {
    return writeError(res, error, 'Unable to record PT payment refund');
  } finally {
    if (session) await session.endSession();
  }
};
