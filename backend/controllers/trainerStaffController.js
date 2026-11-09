const mongoose = require('mongoose');
const TrainerStaff = require('../models/TrainerStaff');
const Member = require('../models/Member');
const TrainerAssignment = require('../models/TrainerAssignment');
const TrainerPTPackage = require('../models/TrainerPTPackage');
const MemberMembership = require('../models/MemberMembership');
const Payment = require('../models/Payment');

const fields = [
  'name',
  'phone',
  'email',
  'role',
  'specialization',
  'maxClientCapacity',
  'designation',
  'department',
  'joiningDate',
  'salaryAmount',
  'compensationType',
  'status'
];

const buildRecord = (body, isCreate) => {
  const data = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) data[field] = body[field];
  }

  if (isCreate || data.name !== undefined) {
    data.name = String(data.name || '').trim();
    if (!data.name) return { error: 'Full name is required' };
  }
  if (isCreate || data.phone !== undefined) {
    data.phone = String(data.phone || '').trim();
    if (!/^\+?[0-9\s()-]{7,20}$/.test(data.phone)) {
      return { error: 'Enter a valid phone number' };
    }
  }
  if (data.email !== undefined) {
    data.email = String(data.email).trim().toLowerCase();
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      return { error: 'Enter a valid email address' };
    }
  }
  if (data.role !== undefined && !['Trainer', 'Staff'].includes(data.role)) {
    return { error: 'Role must be Trainer or Staff' };
  }
  if (data.status !== undefined && !['Active', 'Inactive'].includes(data.status)) {
    return { error: 'Status must be Active or Inactive' };
  }
  if (data.compensationType !== undefined &&
      !['Salary', 'Commission'].includes(data.compensationType)) {
    return { error: 'Compensation type must be Salary or Commission' };
  }
  if (data.salaryAmount !== undefined && data.salaryAmount !== '' &&
      (!Number.isFinite(Number(data.salaryAmount)) || Number(data.salaryAmount) < 0)) {
    return { error: 'Salary or commission must be a non-negative amount' };
  }
  if (data.salaryAmount === '') data.salaryAmount = null;
  else if (data.salaryAmount !== undefined && data.salaryAmount !== null) {
    data.salaryAmount = Number(data.salaryAmount);
  }
  if (data.maxClientCapacity === '') data.maxClientCapacity = null;
  else if (data.maxClientCapacity !== undefined && data.maxClientCapacity !== null) {
    const capacity = Number(data.maxClientCapacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) {
      return { error: 'Maximum client capacity must be a positive whole number' };
    }
    data.maxClientCapacity = capacity;
  }
  if (data.joiningDate !== undefined) {
    const date = new Date(data.joiningDate);
    if (Number.isNaN(date.getTime())) return { error: 'Enter a valid joining date' };
    data.joiningDate = date;
  }

  for (const field of ['specialization', 'designation', 'department']) {
    if (data[field] !== undefined) data[field] = String(data[field] || '').trim();
  }
  return { data };
};

const validId = id => mongoose.Types.ObjectId.isValid(id);
exports.validateTrainerStaffRecord = buildRecord;

const assignedCounts = async (tenantId, businessId, trainerIds) => {
  if (!trainerIds.length) return new Map();
  const groups = await Member.aggregate([
    {
      $match: {
        tenantId,
        businessId,
        deletedAt: null,
        $or: [
          { assignedTrainerId: { $in: trainerIds } },
          { additionalTrainerIds: { $in: trainerIds } }
        ]
      }
    },
    {
      $project: {
        trainerIds: {
          $setUnion: [
            { $ifNull: ['$additionalTrainerIds', []] },
            { $cond: [{ $ifNull: ['$assignedTrainerId', false] }, ['$assignedTrainerId'], []] }
          ]
        }
      }
    },
    { $unwind: '$trainerIds' },
    { $match: { trainerIds: { $in: trainerIds } } },
    { $group: { _id: '$trainerIds', count: { $sum: 1 } } }
  ]);
  return new Map(groups.map(row => [String(row._id), row.count]));
};

exports.listTrainerStaff = async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const filter = { tenantId };
    if (['Trainer', 'Staff'].includes(req.query.role)) filter.role = req.query.role;
    if (['Active', 'Inactive'].includes(req.query.status)) filter.status = req.query.status;
    const search = String(req.query.search || '').trim();
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: new RegExp(escaped, 'i') },
        { phone: new RegExp(escaped, 'i') },
        { email: new RegExp(escaped, 'i') },
        { specialization: new RegExp(escaped, 'i') },
        { designation: new RegExp(escaped, 'i') },
        { department: new RegExp(escaped, 'i') }
      ];
    }

    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 10));
    const [staff, total, summary] = await Promise.all([
      TrainerStaff.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      TrainerStaff.countDocuments(filter),
      TrainerStaff.aggregate([
        { $match: { tenantId } },
        {
          $group: {
            _id: '$role',
            total: { $sum: 1 },
            active: { $sum: { $cond: [{ $eq: ['$status', 'Active'] }, 1, 0] } }
          }
        }
      ])
    ]);
    const counts = await assignedCounts(
      tenantId,
      req.owner.businessId,
      staff.filter(row => row.role === 'Trainer').map(row => row._id)
    );
    const summaryByRole = Object.fromEntries(summary.map(row => [row._id, {
      total: row.total,
      active: row.active,
      inactive: row.total - row.active
    }]));
    const records = staff.map(row => ({
      ...row,
      assignedMemberCount: counts.get(String(row._id)) || 0
    }));

    return res.json({
      success: true,
      staff: records,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      summary: {
        trainers: summaryByRole.Trainer || { total: 0, active: 0, inactive: 0 },
        staff: summaryByRole.Staff || { total: 0, active: 0, inactive: 0 }
      }
    });
  } catch (error) {
    console.error('List trainer/staff error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load trainers and staff' });
  }
};

exports.createTrainerStaff = async (req, res) => {
  try {
    const { data, error } = buildRecord(req.body, true);
    if (error || !['Trainer', 'Staff'].includes(data?.role)) {
      return res.status(400).json({ success: false, message: error || 'Role is required' });
    }
    const duplicate = await TrainerStaff.findOne({
      tenantId: req.tenantId,
      role: data.role,
      $or: [
        { phone: data.phone },
        ...(data.email ? [{ email: data.email }] : [])
      ]
    }).select('_id').lean();
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: 'A trainer or staff member with this phone or email already exists'
      });
    }

    const staff = await TrainerStaff.create({
      ...data,
      tenantId: req.tenantId,
      createdBy: req.owner._id
    });
    return res.status(201).json({ success: true, staff });
  } catch (error) {
    console.error('Create trainer/staff error:', error);
    return res.status(500).json({ success: false, message: 'Unable to create trainer or staff record' });
  }
};

exports.updateTrainerStaff = async (req, res) => {
  try {
    if (!validId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid staff ID' });
    }
    const { data, error } = buildRecord(req.body, false);
    if (error) return res.status(400).json({ success: false, message: error });

    const existing = await TrainerStaff.findOne({ _id: req.params.id, tenantId: req.tenantId });
    if (!existing) return res.status(404).json({ success: false, message: 'Record not found' });
    if (data.role && data.role !== existing.role) {
      const assignedCount = existing.role === 'Trainer'
        ? await Member.countDocuments({
          tenantId: req.tenantId,
          businessId: req.owner.businessId,
          deletedAt: null,
          $or: [
            { assignedTrainerId: existing._id },
            { additionalTrainerIds: existing._id }
          ]
        })
        : 0;
      if (assignedCount) {
        return res.status(409).json({
          success: false,
          message: 'Remove or reassign this trainer’s members before changing their role'
        });
      }
    }
    if (data.status === 'Inactive' && existing.role === 'Trainer') {
      const assignedCount = await Member.countDocuments({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        deletedAt: null,
        $or: [
          { assignedTrainerId: existing._id },
          { additionalTrainerIds: existing._id }
        ]
      });
      if (assignedCount) {
        return res.status(409).json({
          success: false,
          message: 'Reassign or remove this trainer’s members before deactivation'
        });
      }
    }
    if (data.phone || data.email) {
      const duplicateFilter = {
        tenantId: req.tenantId,
        role: data.role || existing.role,
        _id: { $ne: existing._id },
        $or: [{ phone: data.phone || existing.phone }]
      };
      const email = data.email !== undefined ? data.email : existing.email;
      if (email) duplicateFilter.$or.push({ email });
      if (await TrainerStaff.exists(duplicateFilter)) {
        return res.status(409).json({
          success: false,
          message: 'A trainer or staff member with this phone or email already exists'
        });
      }
    }
    Object.assign(existing, data);
    await existing.save();
    return res.json({ success: true, staff: existing });
  } catch (error) {
    console.error('Update trainer/staff error:', error);
    return res.status(500).json({ success: false, message: 'Unable to update trainer or staff record' });
  }
};

exports.deleteTrainerStaff = async (req, res) => {
  try {
    if (!validId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid staff ID' });
    }
    const assigned = await Member.exists({
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      deletedAt: null,
      $or: [
        { assignedTrainerId: req.params.id },
        { additionalTrainerIds: req.params.id }
      ]
    });
    if (assigned) {
      return res.status(409).json({
        success: false,
        message: 'Reassign or remove this trainer’s members before removing the record'
      });
    }
    if (await TrainerStaff.exists({ _id: req.params.id, tenantId: req.tenantId, role: 'Trainer' })) {
      const historicalReferences = await Promise.all([
        TrainerAssignment.exists({ tenantId: req.tenantId, businessId: req.owner.businessId, trainerId: req.params.id }),
        TrainerPTPackage.exists({ tenantId: req.tenantId, businessId: req.owner.businessId, trainerId: req.params.id }),
        MemberMembership.exists({ tenantId: req.tenantId, businessId: req.owner.businessId, attributedTrainerId: req.params.id }),
        Payment.exists({ tenantId: req.tenantId, businessId: req.owner.businessId, attributedTrainerId: req.params.id })
      ]);
      if (historicalReferences.some(Boolean)) {
        return res.status(409).json({
          success: false,
          message: 'This trainer has assignment or financial history and cannot be deleted. Deactivate the trainer instead.'
        });
      }
    }
    const staff = await TrainerStaff.findOneAndDelete({
      _id: req.params.id,
      tenantId: req.tenantId
    });
    if (!staff) return res.status(404).json({ success: false, message: 'Record not found' });
    return res.json({ success: true, message: 'Record deleted' });
  } catch (error) {
    console.error('Delete trainer/staff error:', error);
    return res.status(500).json({ success: false, message: 'Unable to delete trainer or staff record' });
  }
};

exports.getTrainerAssignments = async (req, res) => {
  try {
    if (!validId(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid trainer ID' });
    }
    const trainer = await TrainerStaff.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
      role: 'Trainer'
    }).select('_id name status').lean();
    if (!trainer) return res.status(404).json({ success: false, message: 'Trainer not found' });
    const members = await Member.find({
      tenantId: req.tenantId,
      deletedAt: null,
      assignedTrainerId: trainer._id
    }).select('_id fullName phone email status').sort({ fullName: 1 }).lean();
    return res.json({ success: true, trainer, members });
  } catch (error) {
    console.error('Trainer assignment list error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load trainer assignments' });
  }
};

exports.assignMemberToTrainer = async (req, res) => {
  try {
    const { memberId } = req.body;
    if (!validId(req.params.id) || !validId(memberId)) {
      return res.status(400).json({ success: false, message: 'Valid trainer and member IDs are required' });
    }
    const trainer = await TrainerStaff.findOne({
      _id: req.params.id,
      tenantId: req.tenantId,
      role: 'Trainer',
      status: 'Active'
    }).select('_id').lean();
    if (!trainer) {
      return res.status(409).json({ success: false, message: 'Only an active trainer can be assigned members' });
    }
    const member = await Member.findOneAndUpdate(
      {
        _id: memberId,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        deletedAt: null,
        status: 'Active'
      },
      { $set: { assignedTrainerId: trainer._id } },
      { new: true }
    ).select('_id fullName phone assignedTrainerId').lean();
    if (!member) return res.status(404).json({ success: false, message: 'Member not found in this business' });
    return res.json({ success: true, member });
  } catch (error) {
    console.error('Assign member to trainer error:', error);
    return res.status(500).json({ success: false, message: 'Unable to assign member to trainer' });
  }
};

exports.removeTrainerAssignment = async (req, res) => {
  try {
    if (!validId(req.params.id) || !validId(req.params.memberId)) {
      return res.status(400).json({ success: false, message: 'Valid trainer and member IDs are required' });
    }
    const result = await Member.updateOne(
      {
        _id: req.params.memberId,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        deletedAt: null,
        assignedTrainerId: req.params.id
      },
      { $set: { assignedTrainerId: null } }
    );
    if (!result.matchedCount) {
      return res.status(404).json({ success: false, message: 'Trainer assignment not found' });
    }
    return res.json({ success: true });
  } catch (error) {
    console.error('Remove trainer assignment error:', error);
    return res.status(500).json({ success: false, message: 'Unable to remove trainer assignment' });
  }
};

exports.getTrainerStaffReport = async (req, res) => {
  try {
    const { role, status } = req.query;
    if (role && !['Trainer', 'Staff'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Invalid team role filter' });
    }
    if (status && !['Active', 'Inactive'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status filter' });
    }
    const parseDate = value => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
      const date = new Date(`${value}T00:00:00.000Z`);
      return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
        ? null
        : date;
    };
    let from = null;
    let to = null;
    if (req.query.from || req.query.to) {
      from = parseDate(req.query.from);
      to = parseDate(req.query.to);
      if (!from || !to || from > to || to.getTime() - from.getTime() > 365 * 86400000) {
        return res.status(400).json({
          success: false,
          message: 'Choose a valid joining-date range no longer than 366 days'
        });
      }
      to.setUTCDate(to.getUTCDate() + 1);
    }

    const filter = { tenantId: req.tenantId };
    if (role) filter.role = role;
    if (status) filter.status = status;
    if (from) filter.joiningDate = { $gte: from, $lt: to };

    const rows = await TrainerStaff.find(filter).sort({ role: 1, name: 1 }).lean();
    const trainers = rows.filter(row => row.role === 'Trainer');
    const counts = await assignedCounts(
      req.tenantId,
      req.owner.businessId,
      trainers.map(row => row._id)
    );
    const assignedMembers = trainers.length
      ? await Member.find({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        deletedAt: null,
        $or: [
          { assignedTrainerId: { $in: trainers.map(row => row._id) } },
          { additionalTrainerIds: { $in: trainers.map(row => row._id) } }
        ]
      }).select('_id fullName phone assignedTrainerId additionalTrainerIds').sort({ fullName: 1 }).lean()
      : [];
    const membersByTrainer = new Map();
    for (const member of assignedMembers) {
      const trainerIds = new Set([
        ...(member.assignedTrainerId ? [String(member.assignedTrainerId)] : []),
        ...(member.additionalTrainerIds || []).map(String)
      ]);
      for (const trainerId of trainerIds) {
        if (!trainers.some(trainer => String(trainer._id) === trainerId)) continue;
        if (!membersByTrainer.has(trainerId)) membersByTrainer.set(trainerId, []);
        membersByTrainer.get(trainerId).push({
          _id: member._id,
          fullName: member.fullName,
          phone: member.phone
        });
      }
    }
    const reportRows = rows.map(row => ({
      ...row,
      assignedMemberCount: row.role === 'Trainer' ? counts.get(String(row._id)) || 0 : 0,
      assignedMembers: row.role === 'Trainer' ? membersByTrainer.get(String(row._id)) || [] : []
    }));
    const summary = reportRows.reduce((result, row) => {
      const key = row.role === 'Trainer' ? 'trainers' : 'staff';
      result[key].total += 1;
      if (row.status === 'Active') result[key].active += 1;
      else result[key].inactive += 1;
      return result;
    }, {
      trainers: { total: 0, active: 0, inactive: 0 },
      staff: { total: 0, active: 0, inactive: 0 }
    });
    const staffByDesignation = Object.values(reportRows
      .filter(row => row.role === 'Staff')
      .reduce((groups, row) => {
        const designation = row.designation || 'Unspecified';
        const department = row.department || 'Unspecified';
        const key = `${designation}\u0000${department}`;
        groups[key] ||= {
          designation,
          department,
          total: 0,
          active: 0,
          inactive: 0
        };
        groups[key].total += 1;
        groups[key][row.status === 'Active' ? 'active' : 'inactive'] += 1;
        return groups;
      }, {}));
    return res.json({
      success: true,
      summary,
      staffByDesignation,
      records: reportRows,
      capabilities: {
        trainerAttendance: false,
        staffAttendance: false,
        batchAssignments: false,
        salaryTransactions: false
      }
    });
  } catch (error) {
    console.error('Trainer/staff report error:', error);
    return res.status(500).json({ success: false, message: 'Unable to generate trainer and staff report' });
  }
};
