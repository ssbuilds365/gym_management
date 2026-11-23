const mongoose = require('mongoose');
const crypto = require('node:crypto');
const XLSX = require('@e965/xlsx');
const ExcelJS = require('exceljs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const Member = require('../models/Member');
const MemberImportBatch = require('../models/MemberImportBatch');
const MemberMembership = require('../models/MemberMembership');
const MembershipPlan = require('../models/MembershipPlan');
const Business = require('../models/Business');
const Attendance = require('../models/Attendance');
const Payment = require('../models/Payment');
const BiometricEnrollment = require('../models/BiometricEnrollment');
const {
  addMembershipDuration,
  isValidTimeZone,
  parseMembershipStartDate,
  DEFAULT_TIME_ZONE
} = require('../utils/membershipExpiry');
const { toMinorUnits, fromMinorUnits } = require('../utils/currency');
const { calculateGst } = require('../utils/gst');
const {
  MEMBER_IMPORT_COLUMNS,
  APPLICATION_FIELDS,
  normalizeHeader,
  suggestMapping
} = require('../utils/memberImportColumns');

const parseExcelDate = value => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
    }
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(trimmed);
    if (iso) {
      const date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const dot = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(trimmed);
    if (dot) {
      const date = new Date(Date.UTC(Number(dot[3]), Number(dot[2]) - 1, Number(dot[1])));
      return Number.isNaN(date.getTime()) ? null : date;
    }
  }
  return null;
};

const normalizePhone = value => {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits.length === 10 ? digits : '';
};

const normalizePaymentMethod = value => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return '';
  if (['cash'].includes(normalized)) return 'Cash';
  if (['upi'].includes(normalized)) return 'UPI';
  if (['card', 'credit card', 'debit card'].includes(normalized)) return 'Card';
  if (['bank', 'bank transfer', 'neft', 'imps', 'rtgs'].includes(normalized)) return 'Bank Transfer';
  if (['razorpay'].includes(normalized)) return 'Razorpay';
  return '';
};

const parsePaymentAmount = value => {
  if (value === '' || value === null || value === undefined) return 0;
  const amount = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
};

const escapeCsv = value => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const decodeCsv = buffer => {
  let text;
  try {
    if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
      text = new TextDecoder('utf-16le', { fatal: true }).decode(buffer);
    } else if (buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
      text = new TextDecoder('utf-16be', { fatal: true }).decode(buffer);
    } else {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        text = new TextDecoder('windows-1252', { fatal: true }).decode(buffer);
      }
    }
  } catch {
    throw new Error('Invalid CSV file. The file must contain readable text.');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw new Error('Invalid CSV file. The file must contain readable text.');
  }
  return text;
};

const readWorkbook = (buffer, filename) => {
  const extension = path.extname(String(filename)).toLowerCase();
  if (!['.xlsx', '.xls', '.csv'].includes(extension)) {
    throw new Error('Unsupported file extension. Please select an XLSX, XLS or CSV file.');
  }
  if (!buffer?.length) throw new Error('The uploaded file is empty.');

  let workbook;
  if (extension === '.csv') {
    const text = decodeCsv(buffer);
    if (!text.trim()) throw new Error('The uploaded file is empty.');
    try {
      workbook = XLSX.read(text, { type: 'string', cellDates: true, raw: false });
    } catch (error) {
      console.error('Member import CSV parsing error:', {
        name: error.name,
        message: error.message
      });
      throw new Error('CSV parsing failed. Please check the file contents.');
    }
  } else {
    const zipSignature = buffer.subarray(0, 4).toString('hex');
    const isXlsx = ['504b0304', '504b0506', '504b0708'].includes(zipSignature);
    const isXls = buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    if ((extension === '.xlsx' && !isXlsx) || (extension === '.xls' && !isXls)) {
      throw new Error('Invalid Excel file. The file contents do not match its extension.');
    }
    try {
      workbook = XLSX.read(buffer, {
        type: 'buffer',
        cellDates: true,
        raw: false,
        WTF: true
      });
    } catch (error) {
      console.error('Member import Excel parsing error:', {
        name: error.name,
        message: error.message
      });
      throw new Error('Excel parsing failed. Please upload a valid Excel workbook.');
    }
    if (!workbook.Workbook?.Sheets?.length) {
      throw new Error('Invalid Excel file. The workbook structure could not be read.');
    }
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error(extension === '.csv'
      ? 'CSV parsing failed. No rows could be read from the file.'
      : 'Invalid Excel file. The workbook does not contain a worksheet.');
  }
  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: false,
    dateNF: 'yyyy-mm-dd'
  });
  const hasHeaderRow = matrix.some(row =>
    row.some(value => String(value ?? '').trim() !== '')
  );
  if (!hasHeaderRow) throw new Error('The uploaded file is empty.');
  const duplicateHeaders = [];
  if (matrix.length) {
    const seen = new Set();
    for (const value of matrix[0]) {
      const header = String(value ?? '').trim();
      if (!header) continue;
      const normalized = normalizeHeader(header);
      if (seen.has(normalized)) duplicateHeaders.push(header);
      seen.add(normalized);
    }
  }
  if (duplicateHeaders.length) {
    throw new Error(`Duplicate spreadsheet headers are not allowed: ${[...new Set(duplicateHeaders)].join(', ')}`);
  }
  const rows = XLSX.utils.sheet_to_json(sheet, {
    defval: '',
    raw: false,
    dateNF: 'yyyy-mm-dd'
  });
  if (!rows.length) throw new Error('The spreadsheet contains headers but no member rows.');
  return { headers: Object.keys(rows[0]), rows };
};

exports.previewMemberImport = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please select an Excel or CSV file.' });
    }
    if (req.file.size > 10 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: 'The file exceeds the 10 MB size limit.' });
    }

    let workbook;
    try {
      workbook = readWorkbook(req.file.buffer, req.file.originalname);
    } catch (error) {
      console.error('Member import file validation error:', error.message);
      return res.status(400).json({ success: false, message: error.message || 'Malformed or invalid spreadsheet.' });
    }

    const mappings = suggestMapping(workbook.headers);
    const sourceHeaders = mappings.map(item => normalizeHeader(item.header));
    if (new Set(sourceHeaders).size !== sourceHeaders.length) {
      return res.status(400).json({ success: false, message: 'Duplicate spreadsheet headers cannot be mapped.' });
    }
    const mappedFields = mappings.map(item => item.field).filter(Boolean);
    if (new Set(mappedFields).size !== mappedFields.length) {
      return res.status(400).json({ success: false, message: 'A spreadsheet column cannot be mapped to multiple fields.' });
    }
    if (!mappedFields.includes('fullName') || !mappedFields.includes('phone')) {
      const missing = [
        !mappedFields.includes('fullName') ? 'Member Name' : '',
        !mappedFields.includes('phone') ? 'Phone' : ''
      ].filter(Boolean);
      return res.status(400).json({
        success: false,
        message: `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(' and ')}.`
      });
    }

    const fieldToHeader = new Map(
      mappings.filter(item => item.field).map(item => [item.field, item.header])
    );
    const existingMembers = await Member.find({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      deletedAt: null
    }).select('phone fullName').lean();
    const existingPhones = new Set(existingMembers.map(member => normalizePhone(member.phone)).filter(Boolean));

    const withinFile = new Set();
    const records = workbook.rows.map((row, index) => {
      const record = { rowNumber: index + 2 };
      for (const [field, header] of fieldToHeader.entries()) {
        record[field] = row[header] ?? '';
      }
      record.fullName = String(record.fullName || '').trim();
      record.phone = normalizePhone(record.phone);
      record.email = String(record.email || '').trim().toLowerCase();
      record.gender = ['male', 'm'].includes(String(record.gender || '').toLowerCase()) ? 'Male'
        : ['female', 'f'].includes(String(record.gender || '').toLowerCase()) ? 'Female'
        : 'Other';

      const errors = [];
      if (!record.fullName) errors.push('Member name is missing');
      if (!record.phone) errors.push('Invalid phone number');
      if (record.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email)) {
        errors.push('Invalid email address');
      }

      let duplicateReason = '';
      if (record.phone && existingPhones.has(record.phone)) {
        duplicateReason = 'Phone number already exists in this gym';
      } else if (record.phone && withinFile.has(record.phone)) {
        duplicateReason = 'Duplicate phone number within the uploaded file';
      } else if (record.phone) {
        withinFile.add(record.phone);
      }

      record.errors = errors;
      record.status = errors.length ? 'INVALID'
        : duplicateReason ? 'DUPLICATE'
        : 'VALID';
      record.reason = [...errors, duplicateReason].filter(Boolean).join('; ');
      return record;
    });

    const counts = records.reduce((summary, record) => {
      summary.totalRows++;
      if (record.status === 'VALID') summary.validRecords++;
      else if (record.status === 'DUPLICATE') summary.duplicateRecords++;
      else summary.invalidRecords++;
      return summary;
    }, {
      totalRows: 0,
      validRecords: 0,
      duplicateRecords: 0,
      invalidRecords: 0
    });

    return res.json({
      success: true,
      filename: req.file.originalname,
      headers: workbook.headers,
      suggestedMappings: suggestMapping(workbook.headers),
      mappings,
      ...counts,
      records
    });
  } catch (error) {
    console.error('Member import preview error:', error);
    return res.status(500).json({ success: false, message: 'Unable to preview the uploaded file.' });
  }
};

exports.downloadMemberImportTemplate = async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'SS Fitness Manager';
  const sheet = workbook.addWorksheet('Members');
  sheet.addRow(MEMBER_IMPORT_COLUMNS.map(column => column.header));
  sheet.addRow(['Example Member', '9876543210', 'member@example.com', 'Male']);
  sheet.columns.forEach(column => { column.width = 22; });
  sheet.getRow(1).font = { bold: true };
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="member-import-template.xlsx"'
  );
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  await workbook.xlsx.write(res);
  res.end();
};

exports.confirmMemberImport = async (req, res) => {
  const idempotencyKey = String(req.headers['idempotency-key'] || req.body?.idempotencyKey || '').trim();
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(idempotencyKey)) {
    return res.status(400).json({ success: false, message: 'A valid import idempotency key is required.' });
  }
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  if (!records.length || records.length > 5000) {
    return res.status(400).json({ success: false, message: 'Provide between 1 and 5000 member records.' });
  }

  try {
    const existingBatch = await MemberImportBatch.findOne({
      tenantId: req.tenantId,
      idempotencyKey
    }).lean();
    if (existingBatch) {
      return res.json({ success: true, idempotent: true, batch: existingBatch });
    }

    let batch;
    try {
      batch = await MemberImportBatch.create({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        idempotencyKey,
        filename: String(req.body.filename || 'member-import.xlsx').slice(0, 255),
        importedBy: req.owner._id,
        status: 'PENDING',
        totalRows: records.length,
        report: []
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      const racedBatch = await MemberImportBatch.findOne({
        tenantId: req.tenantId,
        idempotencyKey
      }).lean();
      if (racedBatch) {
        return res.json({ success: true, idempotent: true, batch: racedBatch });
      }
      throw error;
    }

    const existingMembers = await Member.find({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      deletedAt: null
    }).select('phone').lean();
    const existingPhones = new Set(existingMembers.map(member => normalizePhone(member.phone)).filter(Boolean));
    const [plans, business] = await Promise.all([
      MembershipPlan.find({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        status: 'Active'
      }).lean(),
      Business.findById(req.tenantId).lean()
    ]);
    const plansById = new Map(plans.map(plan => [String(plan._id), plan]));
    const plansByName = new Map();
    for (const plan of plans) {
      const key = normalizeHeader(plan.planName);
      if (!plansByName.has(key)) plansByName.set(key, []);
      plansByName.get(key).push(plan);
    }
    const timeZone = business && isValidTimeZone(business.timeZone)
      ? business.timeZone
      : DEFAULT_TIME_ZONE;
    const filePhones = new Set();
    const report = [];
    let importedCount = 0;
    let duplicateCount = 0;
    let failedCount = 0;
    let membershipImportedCount = 0;
    let paymentImportedCount = 0;

    for (const record of records) {
      const rowNumber = Number(record.rowNumber) || 0;
      const fullName = String(record.fullName || '').trim();
      const phone = normalizePhone(record.phone);
      const legacyMemberId = String(record.legacyMemberId || '').trim();
      if (record.status === 'DUPLICATE') {
        duplicateCount++;
        report.push({
          rowNumber,
          legacyMemberId,
          fullName,
          phone,
          status: 'DUPLICATE',
          reason: String(record.reason || 'Duplicate phone number')
        });
        continue;
      }
      if (record.status === 'INVALID') {
        failedCount++;
        report.push({
          rowNumber,
          legacyMemberId,
          fullName,
          phone,
          status: 'INVALID',
          reason: String(record.reason || 'Invalid member record')
        });
        continue;
      }
      if (!fullName || !phone) {
        failedCount++;
        report.push({
          rowNumber,
          legacyMemberId,
          fullName,
          phone,
          status: 'INVALID',
          reason: 'Member name or valid phone number is missing'
        });
        continue;
      }
      if (existingPhones.has(phone) || filePhones.has(phone)) {
        duplicateCount++;
        report.push({
          rowNumber,
          legacyMemberId,
          fullName,
          phone,
          status: 'DUPLICATE',
          reason: 'Phone number already exists or is duplicated in this import'
        });
        continue;
      }

      let member = null;
      let membership = null;
      try {
        member = await Member.create({
          tenantId: req.tenantId,
          businessId: req.owner.businessId,
          fullName,
          phone,
          email: String(record.email || '').trim().toLowerCase(),
          gender: ['Male', 'Female'].includes(record.gender) ? record.gender : 'Other',
          dateOfBirth: parseExcelDate(record.dateOfBirth),
          joiningDate: parseExcelDate(record.joiningDate) || new Date(),
          address: String(record.address || '').trim(),
          emergencyContact: String(record.emergencyContact || '').trim(),
          notes: String(record.notes || '').trim(),
          legacyMemberId,
          importBatchId: batch._id,
          importedAt: new Date(),
          importedBy: req.owner._id,
          createdBy: req.owner._id,
          status: 'Active'
        });
        const selectedPlanId = String(record.planId || '').trim();
        const selectedPlanName = String(record.planName || '').trim();
        const selectedPlan = plansById.get(selectedPlanId) ||
          (selectedPlanName ? (plansByName.get(normalizeHeader(selectedPlanName)) || []).find(() => true) : null);
        const singleNamedPlan = selectedPlanName
          ? plansByName.get(normalizeHeader(selectedPlanName))
          : null;
        if (selectedPlanName && singleNamedPlan?.length > 1) {
          throw new Error('Ambiguous membership plan');
        }

        if (selectedPlan) {
          const startDate = parseMembershipStartDate(
            record.membershipStartDate || record.joiningDate || new Date(),
            timeZone
          );
          if (!startDate) throw new Error('Invalid membership start date');
          const endDate = addMembershipDuration(
            startDate,
            selectedPlan.duration,
            selectedPlan.durationType,
            timeZone
          );

          let planPrice = Number(selectedPlan.price);
          let gstSnapshot = null;
          if (business?.gstEnabled) {
            const planPriceCents = toMinorUnits(selectedPlan.price);
            if (planPriceCents === null) throw new Error('Invalid membership plan price');
            const tax = calculateGst({
              configuredPrice: planPriceCents,
              rate: business.gstPercentage,
              inclusive: business.taxInclusive,
              businessStateCode: business.stateCode,
              placeOfSupplyStateCode: business.stateCode
            });
            planPrice = fromMinorUnits(tax.totalAmount);
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
              configuredPrice: selectedPlan.price,
              taxableAmount: selectedPlan.price,
              gstPercentage: 0,
              totalTax: 0,
              totalAmount: selectedPlan.price,
              taxInclusive: true
            };
          }

          const paymentAmount = parsePaymentAmount(record.paymentAmount);
          if (paymentAmount === null || paymentAmount > planPrice) {
            throw new Error('Invalid imported payment amount');
          }
          const paymentStatus = paymentAmount >= planPrice
            ? 'Paid'
            : paymentAmount > 0
              ? 'Partial'
              : 'Pending';

          membership = await MemberMembership.create({
            tenantId: req.tenantId,
            businessId: req.owner.businessId,
            memberId: member._id,
            planId: selectedPlan._id,
            startDate,
            endDate,
            planPrice,
            paidAmount: 0,
            paymentStatus,
            gstSnapshot,
            status: 'Active',
            createdBy: req.owner._id
          });
          membershipImportedCount++;

          if (paymentAmount > 0) {
            const paymentMethod = normalizePaymentMethod(record.paymentMethod);
            const selectedDate = record.paymentDate
              ? parseExcelDate(record.paymentDate)
              : new Date();
            const transactionReference = String(record.transactionReference || '').trim();
            if (!paymentMethod) throw new Error('A valid payment method is required');
            if (!selectedDate) throw new Error('Invalid payment date');

            if (transactionReference) {
              const duplicatePayment = await Payment.findOne({
                tenantId: req.tenantId,
                businessId: req.owner.businessId,
                transactionId: transactionReference
              }).lean();
              if (duplicatePayment) throw new Error('Duplicate transaction reference');
            }

            await Payment.create({
              tenantId: req.tenantId,
              businessId: req.owner.businessId,
              memberId: member._id,
              membershipId: membership._id,
              amount: paymentAmount,
              paymentMethod,
              paymentType: 'Membership Fee',
              transactionId: transactionReference,
              paymentDate: selectedDate,
              status: 'Success',
              notes: String(record.paymentNotes || '').trim(),
              receiptNumber: `SS-R-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
              createdBy: req.owner._id
            });
            paymentImportedCount++;
          }
        }
        filePhones.add(phone);
        existingPhones.add(phone);
        importedCount++;
        report.push({
          rowNumber,
          legacyMemberId,
          fullName,
          phone,
          status: 'IMPORTED',
          reason: '',
          memberId: member._id
        });
      } catch (error) {
        console.error('Member import row error:', {
          rowNumber,
          message: error.message
        });
        if (membership?._id) {
          await Payment.deleteMany({
            tenantId: req.tenantId,
            businessId: req.owner.businessId,
            membershipId: membership._id
          });
          await MemberMembership.deleteOne({
            _id: membership._id,
            tenantId: req.tenantId,
            businessId: req.owner.businessId
          });
          membershipImportedCount = Math.max(0, membershipImportedCount - 1);
          paymentImportedCount = Math.max(0, paymentImportedCount - 1);
        }
        if (member?._id) {
          await Member.deleteOne({
            _id: member._id,
            tenantId: req.tenantId,
            businessId: req.owner.businessId
          });
        }
        failedCount++;
        report.push({
          rowNumber,
          legacyMemberId,
          fullName,
          phone,
          status: 'FAILED',
          reason: error.code === 11000
            ? 'Phone number already exists in this gym'
            : 'Unable to create member'
        });
      }
    }

    batch.importedCount = importedCount;
    batch.duplicateCount = duplicateCount;
    batch.failedCount = failedCount;
    batch.membershipImportedCount = membershipImportedCount;
    batch.paymentImportedCount = paymentImportedCount;
    batch.report = report;
    batch.status = importedCount === records.length
      ? 'COMPLETED'
      : importedCount > 0
        ? 'PARTIALLY_COMPLETED'
        : failedCount > 0
          ? 'FAILED'
          : 'COMPLETED';
    await batch.save();

    return res.status(201).json({
      success: true,
      idempotent: false,
      batch
    });
  } catch (error) {
    console.error('Member import confirm error:', error);
    return res.status(500).json({ success: false, message: 'Unable to complete the member import.' });
  }
};

exports.getMemberImportHistory = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const filter = { tenantId: req.tenantId, businessId: req.owner.businessId };
  const [batches, total] = await Promise.all([
    MemberImportBatch.find(filter)
      .populate('importedBy', 'name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    MemberImportBatch.countDocuments(filter)
  ]);
  return res.json({
    success: true,
    batches,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  });
};

exports.getMemberImportBatch = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.batchId)) {
    return res.status(400).json({ success: false, message: 'Invalid import batch ID.' });
  }
  const batch = await MemberImportBatch.findOne({
    _id: req.params.batchId,
    tenantId: req.tenantId,
    businessId: req.owner.businessId
  }).populate('importedBy', 'name').lean();
  if (!batch) return res.status(404).json({ success: false, message: 'Import batch not found.' });
  return res.json({ success: true, batch });
};

exports.downloadMemberImportReport = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.batchId)) {
    return res.status(400).json({ success: false, message: 'Invalid import batch ID.' });
  }
  const batch = await MemberImportBatch.findOne({
    _id: req.params.batchId,
    tenantId: req.tenantId,
    businessId: req.owner.businessId
  }).lean();
  if (!batch) return res.status(404).json({ success: false, message: 'Import batch not found.' });

  const format = String(req.query.format || 'csv').toLowerCase();
  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Import Report');
    sheet.addRow(['Row', 'Legacy Member ID', 'Member Name', 'Phone', 'Status', 'Reason', 'Member ID']);
    batch.report.forEach(row => sheet.addRow([
      row.rowNumber,
      row.legacyMemberId,
      row.fullName,
      row.phone,
      row.status,
      row.reason,
      row.memberId ? String(row.memberId) : ''
    ]));
    sheet.columns.forEach(column => { column.width = 22; });
    res.setHeader('Content-Disposition', `attachment; filename="import-${batch._id}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    return res.end();
  }

  const lines = [
    ['Row', 'Legacy Member ID', 'Member Name', 'Phone', 'Status', 'Reason', 'Member ID']
      .map(escapeCsv).join(','),
    ...batch.report.map(row => [
      row.rowNumber,
      row.legacyMemberId,
      row.fullName,
      row.phone,
      row.status,
      row.reason,
      row.memberId ? String(row.memberId) : ''
    ].map(escapeCsv).join(','))
  ];
  res.setHeader('Content-Disposition', `attachment; filename="import-${batch._id}.csv"`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  return res.send(lines.join('\r\n'));
};

exports.previewMemberImportDeletion = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.batchId)) {
    return res.status(400).json({ success: false, message: 'Invalid import batch ID.' });
  }
  const batch = await MemberImportBatch.findOne({
    _id: req.params.batchId,
    tenantId: req.tenantId,
    businessId: req.owner.businessId
  }).lean();
  if (!batch) return res.status(404).json({ success: false, message: 'Import batch not found.' });

  const members = await Member.find({
    tenantId: req.tenantId,
    businessId: req.owner.businessId,
    importBatchId: batch._id,
    deletedAt: null
  }).select('_id fullName phone createdAt updatedAt sourceEnquiryId assignedTrainerId additionalTrainerIds').lean();
  const memberIds = members.map(member => member._id);
  const [paymentRows, membershipRows, attendanceRows, biometricRows] = await Promise.all([
    Payment.aggregate([
      { $match: { tenantId: req.tenantId, memberId: { $in: memberIds } } },
      { $group: { _id: '$memberId', count: { $sum: 1 } } }
    ]),
    MemberMembership.aggregate([
      { $match: { tenantId: req.tenantId, memberId: { $in: memberIds } } },
      { $group: { _id: '$memberId', count: { $sum: 1 } } }
    ]),
    Attendance.aggregate([
      { $match: { tenantId: req.tenantId, memberId: { $in: memberIds } } },
      { $group: { _id: '$memberId', count: { $sum: 1 } } }
    ]),
    BiometricEnrollment.aggregate([
      { $match: { tenantId: req.tenantId, memberId: { $in: memberIds } } },
      { $group: { _id: '$memberId', count: { $sum: 1 } } }
    ])
  ]);
  const dependencyCount = id => {
    const key = String(id);
    return [paymentRows, membershipRows, attendanceRows, biometricRows]
      .reduce((count, rows) => count + (rows.find(row => String(row._id) === key)?.count || 0), 0);
  };
  let eligibleCount = 0;
  let requiringReviewCount = 0;
  for (const member of members) {
    const hasRelationship = !!member.sourceEnquiryId
      || !!member.assignedTrainerId
      || (Array.isArray(member.additionalTrainerIds) && member.additionalTrainerIds.length > 0);
    if (dependencyCount(member._id) === 0 && !hasRelationship) eligibleCount++;
    else requiringReviewCount++;
  }
  return res.json({
    success: true,
    filename: batch.filename,
    createdAt: batch.createdAt,
    totalImported: batch.importedCount,
    eligibleCount,
    requiringReviewCount,
    cannotSafelyDeleteCount: 0,
    memberCount: members.length
  });
};

exports.deleteImportedMembers = async (req, res) => {
  if (req.body?.confirmation !== 'DELETE') {
    return res.status(400).json({ success: false, message: 'Type DELETE to confirm batch deletion.' });
  }
  if (!mongoose.Types.ObjectId.isValid(req.params.batchId)) {
    return res.status(400).json({ success: false, message: 'Invalid import batch ID.' });
  }
  const batch = await MemberImportBatch.findOne({
    _id: req.params.batchId,
    tenantId: req.tenantId,
    businessId: req.owner.businessId
  });
  if (!batch) return res.status(404).json({ success: false, message: 'Import batch not found.' });

  const members = await Member.find({
    tenantId: req.tenantId,
    businessId: req.owner.businessId,
    importBatchId: batch._id,
    deletedAt: null
  }).select('_id fullName phone sourceEnquiryId assignedTrainerId additionalTrainerIds').lean();
  let movedToRecycleBin = 0;
  let requiresReview = 0;
  for (const member of members) {
    const [payments, memberships, attendance, biometrics] = await Promise.all([
      Payment.exists({ tenantId: req.tenantId, memberId: member._id }),
      MemberMembership.exists({ tenantId: req.tenantId, memberId: member._id }),
      Attendance.exists({ tenantId: req.tenantId, memberId: member._id }),
      BiometricEnrollment.exists({ tenantId: req.tenantId, memberId: member._id })
    ]);
    if (payments || memberships || attendance || biometrics) {
      requiresReview++;
      continue;
    }
    if (member.sourceEnquiryId || member.assignedTrainerId
      || (Array.isArray(member.additionalTrainerIds) && member.additionalTrainerIds.length > 0)) {
      requiresReview++;
      continue;
    }
    await Member.updateOne(
      {
        _id: member._id,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        importBatchId: batch._id,
        deletedAt: null
      },
      {
        $set: {
          deletedAt: new Date(),
          status: 'Inactive'
        }
      }
    );
    movedToRecycleBin++;
  }
  return res.json({
    success: true,
    movedToRecycleBin,
    requiresReview,
    failedRecords: 0,
    cannotSafelyDelete: 0
  });
};
