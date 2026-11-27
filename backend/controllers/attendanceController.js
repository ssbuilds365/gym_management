const Attendance = require('../models/Attendance');
const Member = require('../models/Member');
const TrainerStaff = require('../models/TrainerStaff');
const Business = require('../models/Business');
const mongoose = require('mongoose');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const {
  DEFAULT_TIME_ZONE,
  isValidTimeZone
} = require('../utils/membershipExpiry');
const {
  getAttendanceDayBounds,
  getAttendanceDateBounds
} = require('../utils/attendanceDates');
const { getLocalDateParts } = require('../utils/dashboardPeriods');
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
      subjectType: 'Member',
      subjectId: member._id,
      subjectRef: 'Member',
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
        {
          attendanceDate: { $exists: false },
          checkIn: { $gte: bounds.start, $lt: bounds.nextStart }
        },
        {
          attendanceDate: null,
          checkIn: { $gte: bounds.start, $lt: bounds.nextStart }
        },
        {
          attendanceDate: { $gte: bounds.legacyStart, $lt: bounds.legacyNextStart },
          checkIn: { $gte: bounds.start, $lt: bounds.nextStart }
        }
      ],
      $and: [
        {
          $or: [
            { memberId: { $ne: null } },
            { subjectType: { $in: [null, 'Member'] } }
          ]
        }
      ]
    })
      .populate('memberId', 'fullName phone')
      .sort({ checkIn: -1 });

    const deduplicatedMap = new Map();
    for (const row of attendance) {
      const key = String(row.memberId?._id || row.memberId || row._id);
      const existing = deduplicatedMap.get(key);
      if (!existing) {
        deduplicatedMap.set(key, row);
      } else if (row.checkIn && existing.checkIn && row.checkIn < existing.checkIn) {
        deduplicatedMap.set(key, row);
      }
    }
    const dailyAttendance = Array.from(deduplicatedMap.values());

    const presentMemberIds = new Set(
      dailyAttendance
        .map(row => row.memberId?._id || row.memberId)
        .filter(Boolean)
        .map(String)
    );
    const now = new Date();
    const localTodayParts = getLocalDateParts(now, timeZone);
    const selectedKey = req.query.date;
    const dateKey = typeof selectedKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(selectedKey)
      ? selectedKey
      : `${localTodayParts.year}-${String(localTodayParts.month).padStart(2, '0')}-${String(localTodayParts.day).padStart(2, '0')}`;
    const eligibleMembers = dateKey <= `${localTodayParts.year}-${String(localTodayParts.month).padStart(2, '0')}-${String(localTodayParts.day).padStart(2, '0')}`
      ? await Member.find({
          tenantId: req.tenantId,
          businessId: req.owner.businessId,
          deletedAt: null,
          status: 'Active',
          joiningDate: { $lte: bounds.nextStart }
        }).select('_id').lean()
      : [];
    const totalAbsent = eligibleMembers.filter(member => !presentMemberIds.has(String(member._id))).length;

    return res.status(200).json({
      success: true,
      total: dailyAttendance.length,
      totalPresent: presentMemberIds.size,
      totalAbsent,
      attendance: dailyAttendance
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

const normalizeIdentifierPhone = value =>
  String(value || '').trim().replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');

const buildMonthKey = (year, month) =>
  `${year}-${String(month).padStart(2, '0')}`;

const getMonthBounds = (year, month, timeZone) => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  const first = getAttendanceDateBounds(`${year}-${String(month).padStart(2, '0')}-01`, timeZone);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const next = getAttendanceDateBounds(
    `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`,
    timeZone
  );
  return first && next ? { start: first.start, nextStart: next.start } : null;
};

exports.searchAttendancePerson = async (req, res) => {
  try {
    const type = String(req.query.type || '').trim();
    const query = String(req.query.query || '').trim();
    if (!['Member', 'Staff', 'Trainer'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid person type' });
    }
    if (!query) {
      return res.status(400).json({ success: false, message: 'Search identifier is required' });
    }

    let person = null;
    if (type === 'Member') {
      if (mongoose.Types.ObjectId.isValid(query)) {
        person = await Member.findOne({
          _id: query,
          tenantId: req.tenantId,
          deletedAt: null
        }).select('_id fullName phone legacyMemberId joiningDate status').lean();
      }
      if (!person) {
        const phone = normalizeIdentifierPhone(query);
        const phoneMatches = phone ? await Member.find({
          tenantId: req.tenantId,
          deletedAt: null,
          phone: { $regex: '(?:^|[^0-9])' + phone + '(?:[^0-9]|$)' }
        }).select('_id fullName phone legacyMemberId joiningDate status').lean() : [];
        person = phoneMatches.find(row =>
          normalizeIdentifierPhone(row.phone) === phone
        ) || await Member.findOne({
          tenantId: req.tenantId,
          deletedAt: null,
          legacyMemberId: query.toUpperCase()
        }).select('_id fullName phone legacyMemberId joiningDate status').lean();
      }
      if (person) {
        return res.json({
          success: true,
          person: {
            id: String(person._id),
            name: person.fullName,
            type,
            publicId: person.legacyMemberId || String(person._id),
            contactNumber: person.phone || '',
            joiningDate: person.joiningDate,
            status: person.status
          }
        });
      }
    } else {
      await require('./trainerStaffController').ensureTrainerStaffPublicIds(req.tenantId);
      const role = type;
      const idField = role === 'Trainer' ? 'trainerId' : 'staffId';
      const phone = normalizeIdentifierPhone(query);
      person = await TrainerStaff.findOne({
        tenantId: req.tenantId,
        role,
        [idField]: query.toUpperCase()
      }).select(`_id name phone ${idField} joiningDate status`).lean();
      if (!person && phone) {
        const phoneMatches = await TrainerStaff.find({
          tenantId: req.tenantId,
          role,
          phone: { $regex: '(?:^|[^0-9])' + phone + '(?:[^0-9]|$)' }
        }).select(`_id name phone ${idField} joiningDate status`).lean();
        person = phoneMatches.find(row =>
          normalizeIdentifierPhone(row.phone) === phone
        ) || null;
      }
      if (person) {
        return res.json({
          success: true,
          person: {
            id: String(person._id),
            name: person.name,
            type,
            publicId: person[idField] || '',
            contactNumber: person.phone || '',
            joiningDate: person.joiningDate,
            status: person.status
          }
        });
      }
    }

    return res.status(404).json({ success: false, message: 'No matching person found' });
  } catch (error) {
    console.error('Attendance person search error:', error);
    return res.status(500).json({ success: false, message: 'Unable to search person' });
  }
};

const resolveMonthlyPerson = async (req, personId, type) => {
  if (type === 'Member') {
    if (!mongoose.Types.ObjectId.isValid(personId)) return null;
    return Member.findOne({
      _id: personId,
      tenantId: req.tenantId,
      deletedAt: null
    }).lean();
  }
  if (!mongoose.Types.ObjectId.isValid(personId)) return null;
  return TrainerStaff.findOne({
    _id: personId,
    tenantId: req.tenantId,
    role: type
  }).lean();
};

exports.getMonthlyAttendanceReport = async (req, res) => {
  try {
    const type = String(req.query.type || '').trim();
    const personId = String(req.query.personId || '').trim();
    const year = Number.parseInt(req.query.year, 10);
    const month = Number.parseInt(req.query.month, 10);
    if (!['Member', 'Staff', 'Trainer'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Invalid person type' });
    }
    const bounds = getMonthBounds(year, month, await getTenantTimeZone(req.tenantId));
    if (!personId || !bounds) {
      return res.status(400).json({ success: false, message: 'Invalid monthly report parameters' });
    }
    const person = await resolveMonthlyPerson(req, personId, type);
    if (!person) return res.status(404).json({ success: false, message: 'Person not found' });

    const timeZone = await getTenantTimeZone(req.tenantId);
    const recordsFilter = type === 'Member'
      ? { tenantId: req.tenantId, memberId: person._id }
      : {
          tenantId: req.tenantId,
          subjectType: type,
          subjectId: person._id
        };
    const attendance = await Attendance.find({
      ...recordsFilter,
      $or: [
        { attendanceDate: { $gte: bounds.start, $lt: bounds.nextStart } },
        { attendanceDate: { $exists: false }, checkIn: { $gte: bounds.start, $lt: bounds.nextStart } },
        { attendanceDate: null, checkIn: { $gte: bounds.start, $lt: bounds.nextStart } }
      ]
    }).sort({ checkIn: 1 }).lean();

    const byDate = new Map();
    for (const row of attendance) {
      const checkIn = row.checkIn ? new Date(row.checkIn) : null;
      if (!checkIn) continue;
      const parts = getLocalDateParts(checkIn, timeZone);
      const key = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
      const existing = byDate.get(key);
      if (!existing || (row.checkIn && existing.checkIn && new Date(row.checkIn) < new Date(existing.checkIn))) {
        byDate.set(key, row);
      }
    }

    const nowParts = getLocalDateParts(new Date(), timeZone);
    const todayKey = `${nowParts.year}-${String(nowParts.month).padStart(2, '0')}-${String(nowParts.day).padStart(2, '0')}`;
    const joiningDate = person.joiningDate ? getLocalDateParts(person.joiningDate, timeZone) : null;
    const joiningKey = joiningDate
      ? `${joiningDate.year}-${String(joiningDate.month).padStart(2, '0')}-${String(joiningDate.day).padStart(2, '0')}`
      : null;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const daily = [];
    let presentDays = 0;
    let absentDays = 0;
    let halfDays = 0;
    let lateArrivals = 0;
    let approvedLeaves = 0;
    let weeklyOffDays = 0;
    let publicHolidays = 0;
    let eligibleWorkingDays = 0;
    let presentEquivalent = 0;
    let totalWorkingMinutes = 0;
    for (let day = 1; day <= daysInMonth; day++) {
      const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const future = key > todayKey;
      const beforeJoining = joiningKey && key < joiningKey;
      const record = byDate.get(key);
      let status = 'Not Scheduled/Future';
      let leaveInformation = '';
      let workingMinutes = 0;
      if (record) {
        const statusValue = String(record.status || 'Present');
        if (statusValue === 'Half Day') status = 'Half Day';
        else if (statusValue === 'Leave') status = 'Approved Leave';
        else status = 'Present';
      } else if (!future && !beforeJoining && String(person.status || 'Active') === 'Active') {
        status = 'Absent';
      } else if (future) {
        status = 'Not Scheduled/Future';
      } else {
        status = 'Not Scheduled/Future';
      }

      let lateDuration = 0;
      if (record?.checkIn) {
        const checkIn = new Date(record.checkIn);
        const checkOut = record.checkOut ? new Date(record.checkOut) : null;
        if (checkOut && checkOut >= checkIn) {
          workingMinutes = Math.floor((checkOut - checkIn) / 60000);
          totalWorkingMinutes += workingMinutes;
        }
      }

      if (!future && !beforeJoining && String(person.status || 'Active') === 'Active') {
        if (status === 'Present' || status === 'Half Day') {
          eligibleWorkingDays++;
          if (status === 'Present') {
            presentDays++;
            presentEquivalent += 1;
          } else {
            halfDays++;
            presentEquivalent += 0.5;
          }
          if (record?.status === 'Late') lateArrivals++;
        } else if (status === 'Absent') {
          eligibleWorkingDays++;
          absentDays++;
        } else if (status === 'Approved Leave') {
          approvedLeaves++;
        }
      }

      daily.push({
        date: key,
        status,
        checkIn: record?.checkIn || null,
        checkOut: record?.checkOut || null,
        lateDuration,
        workingMinutes,
        leaveInformation,
        attendanceSource: record?.attendanceType || null
      });
    }

    const attendancePercentage = eligibleWorkingDays
      ? Number(((presentEquivalent / eligibleWorkingDays) * 100).toFixed(2))
      : 0;
    const publicId = type === 'Member'
      ? (person.legacyMemberId || String(person._id))
      : (type === 'Trainer' ? person.trainerId : person.staffId);
    const name = type === 'Member' ? person.fullName : person.name;
    const business = await Business.findById(req.tenantId)
      .select('businessName address phone email logoUrl')
      .lean();
    const summary = {
      presentDays,
      absentDays,
      halfDays,
      lateArrivals,
      approvedLeaveDays: approvedLeaves,
      weeklyOffDays,
      publicHolidays,
      totalWorkingDays: eligibleWorkingDays,
      attendancePercentage,
      totalWorkingHours: totalWorkingMinutes
        ? Number((totalWorkingMinutes / 60).toFixed(2))
        : null
    };
    const report = {
      success: true,
      businessName: business?.businessName || '',
      gymDetails: {
        address: business?.address || '',
        phone: business?.phone || '',
        email: business?.email || '',
        logoUrl: business?.logoUrl || ''
      },
      person: {
        id: String(person._id),
        name,
        type,
        publicId: publicId || '',
        contactNumber: person.phone || '',
        joiningDate: person.joiningDate || null,
        designation: person.designation || '',
        specialization: person.specialization || ''
      },
      month,
      year,
      timeZone,
      formula: 'Attendance Percentage = (Present Equivalent Days / Eligible Working Days) x 100; Full Present = 1, Half Day = 0.5, approved full-day leave is excluded from eligible working days.',
      missingConfiguration: 'No configured weekly offs, official holidays, leave records, shift start/grace period, or half-day rules are available in the existing project.',
      summary,
      daily
    };
    return res.json(report);
  } catch (error) {
    console.error('Monthly attendance report error:', error);
    return res.status(500).json({ success: false, message: 'Unable to generate monthly attendance report' });
  }
};

const pdfEscape = value => String(value || '')
  .replace(/([\\()])/g, '\\$1')
  .replace(/[^\x20-\x7E]/g, '?');

const createSimplePdf = lines => {
  const stream = lines.map((line, index) =>
    `BT /F1 ${index < 2 ? 16 : 10} Tf 40 ${790 - index * 14} Td (${pdfEscape(line).slice(0, 130)}) Tj ET`
  ).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'binary'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index++) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'binary');
};

exports.downloadMonthlyAttendanceReport = async (req, res) => {
  try {
    const internalResponse = await new Promise(resolve => {
      const reqLike = { tenantId: req.tenantId, owner: req.owner, query: req.query };
      exports.getMonthlyAttendanceReport(reqLike, {
        json: payload => resolve(payload),
        status: code => ({ json: payload => resolve({ ...payload, _status: code }) })
      });
    });
    if (!internalResponse?.success) {
      return res.status(internalResponse?._status || 400).json(internalResponse);
    }
    const format = String(req.params.format || 'csv').toLowerCase();
    const report = internalResponse;
    const monthName = new Intl.DateTimeFormat('en-IN', { month: 'long' })
      .format(new Date(report.year, report.month - 1, 1));
    const filenameBase = `SSFitness_Attendance_${report.person.type}_${report.person.publicId || 'person'}_${monthName}_${report.year}`;
    if (format === 'csv') {
      const header = ['Date','Status','Check-in','Check-out','Late Duration','Working Minutes','Leave Information','Attendance Source'];
      const rows = report.daily.map(row => [
        row.date,row.status,row.checkIn ? new Date(row.checkIn).toISOString() : '',
        row.checkOut ? new Date(row.checkOut).toISOString() : '',row.lateDuration,
        row.workingMinutes,row.leaveInformation,row.attendanceSource || ''
      ]);
      const csv = [header, ...rows].map(row => row.map(value =>
        `"${String(value ?? '').replace(/"/g, '""')}"`
      ).join(',')).join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
      return res.send(csv);
    }
    if (format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Monthly Attendance');
      sheet.addRows([
        ['Gym/Business Name', report.businessName],
        ['Person Name', report.person.name],
        ['Person Type', report.person.type],
        ['Public ID', report.person.publicId],
        ['Contact Number', report.person.contactNumber],
        ['Month/Year', `${report.month}/${report.year}`],
        ['Report Generation Date', new Date().toISOString()],
        [],
        ['Summary', 'Value'],
        ...Object.entries(report.summary).map(([key, value]) => [key, value]),
        [],
        ['Date','Status','Check-in','Check-out','Late Duration','Working Minutes','Leave Information','Attendance Source']
      ]);
      report.daily.forEach(row => sheet.addRow([
        row.date,row.status,row.checkIn ? new Date(row.checkIn).toISOString() : '',
        row.checkOut ? new Date(row.checkOut).toISOString() : '',row.lateDuration,
        row.workingMinutes,row.leaveInformation,row.attendanceSource || ''
      ]));
      sheet.getRow(1).font = { bold: true };
      sheet.columns.forEach(column => { column.width = 24; });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);
      await workbook.xlsx.write(res);
      return res.end();
    }
    const firstWeekday = (new Date(report.year, report.month - 1, 1).getDay() + 6) % 7;
    const calendarCells = [
      ...Array(firstWeekday).fill(null),
      ...report.daily
    ];
    while (calendarCells.length % 7 !== 0) calendarCells.push(null);
    const gym = report.gymDetails || {};
    const lines = [
      'SS FITNESS  |  MANAGER PRO',
      'MONTHLY ATTENDANCE REPORT',
      `${monthName} ${report.year}`,
      '',
      `Gym/Business: ${report.businessName}`,
      ...(gym.address ? [`Address: ${gym.address}`] : []),
      ...(gym.phone ? [`Phone: ${gym.phone}`] : []),
      ...(gym.email ? [`Email: ${gym.email}`] : []),
      '',
      `Person: ${report.person.name}`,
      `Person Type: ${report.person.type}`,
      `Person ID: ${report.person.publicId || 'Unavailable'}`,
      `Contact: ${report.person.contactNumber || 'Unavailable'}`,
      ...(report.person.designation ? [`Designation: ${report.person.designation}`] : []),
      ...(report.person.specialization ? [`Specialization: ${report.person.specialization}`] : []),
      '',
      `Present Days: ${report.summary.presentDays}`,
      `Absent Days: ${report.summary.absentDays}`,
      `Total Working Days: ${report.summary.totalWorkingDays}`,
      `Attendance Percentage: ${report.summary.attendancePercentage}%`,
      `Total Working Hours: ${report.summary.totalWorkingHours ?? 'Unavailable'}`,
      '',
      `Formula: ${report.formula}`,
      '',
      'Mon | Tue | Wed | Thu | Fri | Sat | Sun',
      ...calendarCells.reduce((rows, _cell, index) => {
        if (index % 7 === 0) rows.push([]);
        const cell = calendarCells[index];
        rows[rows.length - 1].push(cell
          ? `${cell.date.slice(-2)} ${cell.status === 'Present' ? 'P' : cell.status === 'Absent' ? 'A' : '—'}`
          : '  ');
        return rows;
      }, []).map(row => row.join(' | ')),
      '',
      'Report Details',
      `Selected Month: ${monthName} ${report.year}`,
      `Person Type: ${report.person.type}`,
      `Person ID: ${report.person.publicId || 'Unavailable'}`,
      `Total Days: ${new Date(report.year, report.month, 0).getUTCDate()}`,
      `Total Working Days: ${report.summary.totalWorkingDays}`,
      `Present Days: ${report.summary.presentDays}`,
      `Absent Days: ${report.summary.absentDays}`,
      `Attendance Percentage: ${report.summary.attendancePercentage}%`,
      `Total Working Hours: ${report.summary.totalWorkingHours ?? 'Unavailable'}`,
      '',
      'Notes',
      'Attendance is based on recorded attendance data.',
      'Existing attendance sources may include Manual, QR and Biometric.',
      'Working hours are calculated only when valid check-in/check-out records exist.',
      `Generated: ${new Date().toISOString()}`,
      'SS Fitness Manager Pro'
    ];
    const pdf = createSimplePdf(lines);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.pdf"`);
    return res.send(pdf);
  } catch (error) {
    console.error('Monthly attendance export error:', error);
    return res.status(500).json({ success: false, message: 'Unable to download attendance report' });
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
      subjectType: 'Member',
      subjectId: member._id,
      subjectRef: 'Member',
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
  searchAttendancePerson: exports.searchAttendancePerson,
  getMonthlyAttendanceReport: exports.getMonthlyAttendanceReport,
  downloadMonthlyAttendanceReport: exports.downloadMonthlyAttendanceReport,
  checkInWithQR: exports.checkInWithQR
};