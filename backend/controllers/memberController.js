const Member = require('../models/Member');
const MemberMembership = require('../models/MemberMembership');
const Attendance = require('../models/Attendance');
const Payment = require('../models/Payment');
const BiometricEnrollment = require('../models/BiometricEnrollment');
const MemberDeletionAudit = require('../models/MemberDeletionAudit');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { parseMemberDateRange } = require('../utils/memberDateRange');
// Add New Member
exports.createMember = async (req, res) => {
  try {
    const {
      fullName,
      phone,
      email,
      gender,
      dateOfBirth,
      address,
      emergencyContact,
      joiningDate,
      notes
    } = req.body;

    // Required field validation
    if (!fullName || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Member name and phone number are required'
      });
    }

    // Normalize phone number
    const cleanPhone = String(phone).trim();

    // Check duplicate phone within the logged-in business
    const existingMember = await Member.findOne({
      tenantId: req.tenantId,
      phone: cleanPhone,
      deletedAt: null
    });

    if (existingMember) {
      return res.status(409).json({
        success: false,
        message: 'This phone number is already registered'
      });
    }

    // Create member
    const member = await Member.create({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      fullName: fullName.trim(),
      phone: cleanPhone,
      email,
      gender,
      dateOfBirth: dateOfBirth || null,
      address,
      emergencyContact,
      joiningDate: joiningDate || Date.now(),
      notes,
      createdBy: req.owner._id
    });

    return res.status(201).json({
      success: true,
      message: 'Member registered successfully',
      member
    });

  } catch (error) {
    console.error('Create Member Error:', error);

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'This phone number is already registered'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Unable to register member'
    });
  }
};

// Get All Members with Search, Filter and Pagination

// Get All Members with Membership Details, Search, Filter and Pagination
exports.getAllMembers = async (req, res) => {
  try {
    const {
      search = '',
      status = '',
      from,
      to,
      page = 1,
      limit = 10
    } = req.query;

    const currentPage = Math.max(1, parseInt(page, 10) || 1);

    const pageLimit = Math.min(
      100,
      Math.max(1, parseInt(limit, 10) || 10)
    );

    const skip = (currentPage - 1) * pageLimit;

    // Tenant filter
    const filter = {
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      deletedAt: null
    };

    const dateRange = parseMemberDateRange(from, to);
    if (dateRange.error) {
      return res.status(400).json({
        success: false,
        message: dateRange.error
      });
    }
    if (dateRange.range) {
      filter.joiningDate = dateRange.range;
    }

    // Search by name or phone
    if (search.trim()) {
      const safeSearch = search.trim().replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      );

      filter.$or = [
        { fullName: { $regex: safeSearch, $options: 'i' } },
        { phone: { $regex: safeSearch, $options: 'i' } }
      ];
    }

    // Member status filter
    if (status && ['Active', 'Inactive', 'On Hold'].includes(status)) {
      filter.status = status;
    }

    // Fetch members and total count
    const [members, totalMembers] = await Promise.all([
      Member.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageLimit)
        .lean(),

      Member.countDocuments(filter)
    ]);

    // Fetch latest membership for each member
    const memberIds = members.map(member => member._id);

    const memberships = await MemberMembership.find({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      memberId: { $in: memberIds }
    })
      .populate('planId', 'planName duration durationType price')
      .sort({ createdAt: -1 })
      .lean();

    const membershipIds = memberships.map(membership => membership._id);
    const paymentTotals = membershipIds.length
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
      paymentTotals.map(item => [String(item._id), item.paidAmount])
    );

    // Attach latest membership to each member
    const membershipMap = new Map();

    memberships.forEach(membership => {
      const memberId = membership.memberId.toString();

      if (!membershipMap.has(memberId)) {
        const paidAmount = Number(paidByMembership.get(String(membership._id)) || 0);
        membershipMap.set(memberId, {
          ...membership,
          paidAmount,
          paymentStatus: paidAmount >= Number(membership.planPrice)
            ? 'Paid'
            : paidAmount > 0
              ? 'Partial'
              : 'Pending'
        });
      }
    });

    const membersWithMembership = members.map(member => ({
      ...member,
      membership: membershipMap.get(member._id.toString()) || null
    }));

    return res.status(200).json({
      success: true,
      message: 'Members fetched successfully',
      members: membersWithMembership,
      pagination: {
        totalMembers,
        currentPage,
        totalPages: Math.ceil(totalMembers / pageLimit),
        pageLimit,
        hasNextPage: currentPage * pageLimit < totalMembers,
        hasPrevPage: currentPage > 1
      }
    });

  } catch (error) {
    console.error('Get Members Error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to fetch members'
    });
  }
};


// Update Member
exports.updateMember = async (req, res) => {
  try {
    const { id } = req.params;

    const allowedFields = [
      'fullName',
      'phone',
      'email',
      'gender',
      'dateOfBirth',
      'address',
      'emergencyContact',
      'joiningDate',
      'status',
      'notes'
    ];

    const updates = {};

    allowedFields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        updates[field] = req.body[field];
      }
    });

    if (updates.fullName !== undefined) {
      updates.fullName = String(updates.fullName).trim();

      if (!updates.fullName) {
        return res.status(400).json({
          success: false,
          message: 'Member name cannot be empty'
        });
      }
    }

    if (updates.phone !== undefined) {
      updates.phone = String(updates.phone).trim();

      if (!updates.phone) {
        return res.status(400).json({
          success: false,
          message: 'Phone number cannot be empty'
        });
      }
    }

    if (updates.gender !== undefined &&
        !['Male', 'Female', 'Other'].includes(updates.gender)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid gender'
      });
    }

    if (updates.status !== undefined &&
        !['Active', 'Inactive', 'On Hold'].includes(updates.status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid member status'
      });
    }

    if (updates.email !== undefined) {
      updates.email = String(updates.email).trim().toLowerCase();
    }

    const member = await Member.findOneAndUpdate(
      {
        _id: id,
        tenantId: req.tenantId,
        deletedAt: null
      },
      { $set: updates },
      {
        returnDocument: 'after',
        runValidators: true
      }
    );

    if (!member) {
      return res.status(404).json({
        success: false,
        message: 'Member not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Member updated successfully',
      member
    });

  } catch (error) {
    console.error('Update Member Error:', error);

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'This phone number is already registered'
      });
    }

    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid member ID'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Unable to update member'
    });
  }
};

// Delete Member
exports.deleteMember = async (req, res) => {
  let session;

  try {
    const { id } = req.params;

    if (!req.owner || req.owner.role !== 'owner') {
      return res.status(403).json({
        success: false,
        message: 'Only the authenticated business owner can delete a member'
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid member ID'
      });
    }

    session = await mongoose.startSession();

    let deletionSummary;

    await session.withTransaction(async () => {
      const member = await Member.findOne({
        _id: id,
        tenantId: req.tenantId,
        deletedAt: null
      }).session(session);

      if (!member) {
        const error = new Error('Member not found');
        error.code = 'MEMBER_NOT_FOUND';
        throw error;
      }

      const payments = await Payment.find({
        tenantId: req.tenantId,
        memberId: member._id
      })
        .select('membershipId')
        .session(session)
        .lean();

      const membershipRecords = await MemberMembership.find({
        tenantId: req.tenantId,
        memberId: member._id
      })
        .select('_id paidAmount')
        .session(session)
        .lean();

      const membershipIds = new Set(
        membershipRecords.map((membership) => membership._id.toString())
      );
      const retainedMembershipIdSet = new Set(
        payments
          .map((payment) => payment.membershipId?.toString())
          .filter((membershipId) => membershipId && membershipIds.has(membershipId))
      );
      membershipRecords.forEach((membership) => {
        if (Number(membership.paidAmount || 0) > 0) {
          retainedMembershipIdSet.add(membership._id.toString());
        }
      });
      const retainedMembershipIds = [...retainedMembershipIdSet];

      const attendanceResult = await Attendance.deleteMany({
        tenantId: req.tenantId,
        memberId: member._id
      }).session(session);

      const biometricResult = await BiometricEnrollment.deleteMany({
        tenantId: req.tenantId,
        memberId: member._id
      }).session(session);

      const membershipFilter = {
        tenantId: req.tenantId,
        memberId: member._id
      };

      if (retainedMembershipIds.length > 0) {
        membershipFilter._id = {
          $nin: retainedMembershipIds.map(
            (membershipId) => new mongoose.Types.ObjectId(membershipId)
          )
        };
      }

      const membershipResult = await MemberMembership.deleteMany(
        membershipFilter
      ).session(session);

      member.fullName = 'Deleted member';
      member.phone = `DELETED-${member._id}`;
      member.email = '';
      member.gender = 'Other';
      member.dateOfBirth = null;
      member.address = '';
      member.emergencyContact = '';
      member.status = 'Inactive';
      member.notes = '';
      member.qrTokenHash = null;
      member.deletedAt = new Date();
      await member.save({ session });

      await MemberDeletionAudit.create(
        [{
          tenantId: req.tenantId,
          deletedMemberId: member._id,
          actorId: req.owner._id,
          retainedPaymentCount: payments.length,
          retainedMembershipCount: retainedMembershipIds.length,
          deletedAttendanceCount: attendanceResult.deletedCount || 0,
          deletedBiometricEnrollmentCount: biometricResult.deletedCount || 0,
          deletedMembershipCount: membershipResult.deletedCount || 0
        }],
        { session }
      );

      deletionSummary = {
        retainedPaymentCount: payments.length,
        retainedMembershipCount: retainedMembershipIds.length,
        deletedAttendanceCount: attendanceResult.deletedCount || 0,
        deletedBiometricEnrollmentCount: biometricResult.deletedCount || 0
      };
    });

    return res.status(200).json({
      success: true,
      message: 'Member profile and eligible operational data were deleted',
      retainedFinancialRecords: {
        payments: deletionSummary.retainedPaymentCount,
        memberships: deletionSummary.retainedMembershipCount
      }
    });

  } catch (error) {
    console.error('Delete Member Error:', error);

    if (error.code === 'MEMBER_NOT_FOUND') {
      return res.status(404).json({
        success: false,
        message: 'Member not found'
      });
    }

    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid member ID'
      });
    }

    if (
      error.code === 20 ||
      error.codeName === 'IllegalOperation' ||
      error.message?.includes('Transaction numbers are only allowed')
    ) {
      return res.status(503).json({
        success: false,
        message: 'Safe member deletion requires MongoDB transaction support'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Unable to delete member'
    });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
};

// Generate Member QR Token
exports.generateMemberQR = async (req, res) => {
  try {
    const { id } = req.params;

    // Find member within logged-in owner's business
    const member = await Member.findOne({
      _id: id,
      tenantId: req.tenantId,
      deletedAt: null
    });

    if (!member) {
      return res.status(404).json({
        success: false,
        message: 'Member not found'
      });
    }

    // Generate secure random token
    const qrToken = crypto.randomBytes(32).toString('hex');

    // Store only SHA-256 hash in database
    member.qrTokenHash = crypto
      .createHash('sha256')
      .update(qrToken)
      .digest('hex');

    await member.save();

    // Return original token only once
    return res.status(200).json({
      success: true,
      message: 'Member QR token generated successfully',
      qrToken
    });

  } catch (error) {
    console.error('Generate QR Error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to generate QR token'
    });
  }
};