const Attendance = require('../models/Attendance');
const Member = require('../models/Member');
const Business = require('../models/Business');
const mongoose = require('mongoose');
const crypto = require('crypto');
const {
  DEFAULT_TIME_ZONE,
  isValidTimeZone
} = require('../utils/membershipExpiry');
const {
  getAttendanceDayBounds,
  getAttendanceDateBounds
} = require('../utils/attendanceDates');
const { reconcileOpenAttendance } = require('../services/attendanceAutoCheckout');

const getTenantTimeZone = async tenantId => {
  const business = await Business.findById(tenantId).select('timeZone').lean();
  return business && isValidTimeZone(business.timeZone)
    ? business.timeZone
    : DEFAULT_TIME_ZONE;
};

// Member Check-in
const checkIn = async (req, res) => {
  try {
    const { memberId, attendanceType, notes } = req.body;

    if (!memberId) {
      return res.status(400).json({
        success: false,
        message: 'Member ID is required'
      });
    }

    if (!mongoose.Types.ObjectId.isValid(memberId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid member ID'
      });
    }

    const member = await Member.findOne({
      _id: memberId,
      tenantId: req.tenantId,
      deletedAt: null,
      status: 'Active'
    });

    if (!member) {
      return res.status(404).json({
        success: false,
        message: 'Active member not found'
      });
    }

    await reconcileOpenAttendance({ tenantId: req.tenantId });
    const timeZone = await getTenantTimeZone(req.tenantId);
    const checkInAt = new Date();
    const dayStart = getAttendanceDayBounds(checkInAt, timeZone).start;
    const existingAttendance = await Attendance.findOne({
      tenantId: req.tenantId,
      memberId,
      checkOut: null
    }).sort({ checkIn: -1 });

    if (existingAttendance) {
      return res.status(409).json({
        success: false,
        message: 'Member already has an open check-in',
        attendance: existingAttendance
      });
    }

    const allowedTypes = ['Manual'];
    const type = attendanceType || 'Manual';

    if (!allowedTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid attendance type'
      });
    }

    const recentAttendance = await Attendance.findOne({
      tenantId: req.tenantId,
      memberId,
      checkIn: { $gte: new Date(checkInAt.getTime() - 30_000) }
    }).sort({ checkIn: -1 });

    if (recentAttendance) {
      return res.status(409).json({
        success: false,
        message: 'Please wait before recording another attendance scan'
      });
    }

    const attendance = await Attendance.create({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      memberId,
      attendanceDate: dayStart,
      checkIn: checkInAt,
      attendanceType: type,
      status: 'Present',
      notes: notes || '',
      createdBy: req.owner._id
    });

    return res.status(201).json({
      success: true,
      message: 'Member check-in successful',
      attendance
    });

  } catch (error) {
    console.error('Check-in error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to mark attendance'
    });
  }
};


// Member Check-out
const checkOut = async (req, res) => {
  try {
    const { memberId } = req.body;

    if (!memberId) {
      return res.status(400).json({
        success: false,
        message: 'Member ID is required'
      });
    }

    if (!mongoose.Types.ObjectId.isValid(memberId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid member ID'
      });
    }

    await reconcileOpenAttendance({ tenantId: req.tenantId });
    const attendance = await Attendance.findOne({
      tenantId: req.tenantId,
      memberId,
      checkOut: null
    }).sort({ checkIn: -1 });

    if (!attendance) {
      return res.status(404).json({
        success: false,
        message: 'No open check-in found for this member'
      });
    }

    const checkOutAt = new Date(Math.max(Date.now(), attendance.checkIn.getTime()));
    const durationMinutes = Math.max(
      0,
      Math.floor((checkOutAt.getTime() - attendance.checkIn.getTime()) / 60000)
    );
    const updateResult = await Attendance.updateOne({
      _id: attendance._id,
      tenantId: req.tenantId,
      checkOut: null
    }, {
      $set: {
        checkOut: checkOutAt,
        checkoutType: 'MANUAL',
        durationMinutes
      }
    });

    if (updateResult.modifiedCount !== 1) {
      return res.status(409).json({
        success: false,
        message: 'Attendance was already checked out'
      });
    }

    attendance.checkOut = checkOutAt;
    attendance.checkoutType = 'MANUAL';
    attendance.durationMinutes = durationMinutes;

    return res.status(200).json({
      success: true,
      message: 'Member check-out successful',
      attendance
    });

  } catch (error) {
    console.error('Check-out error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to mark check-out'
    });
  }
};


// Get Daily Attendance
const getDailyAttendance = async (req, res) => {
  try {
    const timeZone = await getTenantTimeZone(req.tenantId);
    const bounds = getAttendanceDateBounds(req.query.date, timeZone);
    if (!bounds) {
      return res.status(400).json({
        success: false,
        message: 'Invalid attendance date'
      });
    }

    const attendance = await Attendance.find({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      $or: [
        { attendanceDate: { $gte: bounds.start, $lt: bounds.nextStart } },
        { attendanceDate: { $gte: bounds.legacyStart, $lt: bounds.legacyNextStart } },
        { checkOut: null, checkIn: { $lt: bounds.nextStart } }
      ]
    })
      .populate('memberId', 'fullName phone')
      .sort({ checkIn: -1 });

    return res.status(200).json({
      success: true,
      total: attendance.length,
      attendance
    });

  } catch (error) {
    console.error('Daily attendance error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to fetch attendance'
    });
  }
};


// Get Member Attendance History
const getMemberAttendance = async (req, res) => {
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

    const attendance = await Attendance.find({
      tenantId: req.tenantId,
      memberId
    }).sort({ attendanceDate: -1, checkIn: -1 });

    return res.status(200).json({
      success: true,
      total: attendance.length,
      attendance
    });

  } catch (error) {
    console.error('Member attendance history error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to fetch member attendance history'
    });
  }
};

// QR Code Attendance Check-in
exports.checkInWithQR = async (req, res) => {
  try {
    const { qrToken } = req.body;

    if (!qrToken) {
      return res.status(400).json({
        success: false,
        message: 'QR token is required'
      });
    }

    // Hash the received QR token
    const tokenHash = crypto
      .createHash('sha256')
      .update(qrToken)
      .digest('hex');

    // Find member using tenant ID and QR token hash
    const member = await Member.findOne({
      tenantId: req.tenantId,
      qrTokenHash: tokenHash,
      deletedAt: null,
      status: 'Active'
    });

    if (!member) {
      return res.status(404).json({
        success: false,
        message: 'Invalid QR code or inactive member'
      });
    }

    await reconcileOpenAttendance({ tenantId: req.tenantId });
    const existingAttendance = await Attendance.findOne({
      tenantId: req.tenantId,
      memberId: member._id,
      checkOut: null
    }).sort({ checkIn: -1 });

    if (existingAttendance) {
      return res.status(409).json({
        success: false,
        message: 'Member already has an open check-in'
      });
    }

    const timeZone = await getTenantTimeZone(req.tenantId);
    const checkInAt = new Date();
    const dayStart = getAttendanceDayBounds(checkInAt, timeZone).start;
    const recentAttendance = await Attendance.findOne({
      tenantId: req.tenantId,
      memberId: member._id,
      checkIn: { $gte: new Date(checkInAt.getTime() - 30_000) }
    }).sort({ checkIn: -1 });

    if (recentAttendance) {
      return res.status(409).json({
        success: false,
        message: 'Please wait before recording another attendance scan'
      });
    }

    // Create QR attendance
    const attendance = await Attendance.create({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      memberId: member._id,
      attendanceDate: dayStart,
      checkIn: checkInAt,
      attendanceType: 'QR',
      status: 'Present',
      notes: 'QR Code Check-in',
      createdBy: req.owner._id
    });

    return res.status(201).json({
      success: true,
      message: 'QR attendance marked successfully',
      member: {
        id: member._id,
        fullName: member.fullName,
        phone: member.phone
      },
      attendance
    });

  } catch (error) {
    console.error('QR Check-in Error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to mark QR attendance'
    });
  }
};


module.exports = {
  checkIn,
  checkOut,
  getDailyAttendance,
  getMemberAttendance,
  checkInWithQR: exports.checkInWithQR
};