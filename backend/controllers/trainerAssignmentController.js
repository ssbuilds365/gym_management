const mongoose = require('mongoose');
const Member = require('../models/Member');
const TrainerStaff = require('../models/TrainerStaff');
const TrainerAssignment = require('../models/TrainerAssignment');

const validId = id => mongoose.Types.ObjectId.isValid(id);

const assignmentError = (res, error, fallback) => {
  if (error.statusCode) {
    return res.status(error.statusCode).json({
      success: false,
      ...(error.code ? { code: error.code } : {}),
      ...(error.capacity ? { capacity: error.capacity } : {}),
      message: error.message
    });
  }
  console.error(fallback, error);
  return res.status(500).json({ success: false, message: fallback });
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

    const [members, history] = await Promise.all([
      Member.find({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        deletedAt: null,
        $or: [
          { assignedTrainerId: trainer._id },
          { additionalTrainerIds: trainer._id }
        ]
      }).select('_id fullName phone email status assignedTrainerId additionalTrainerIds').sort({ fullName: 1 }).lean(),
      TrainerAssignment.find({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        trainerId: trainer._id
      }).sort({ assignedAt: -1 }).lean()
    ]);

    return res.json({
      success: true,
      trainer,
      members: members.map(member => ({
        ...member,
        assignmentRole: String(member.assignedTrainerId) === String(trainer._id)
          ? 'Primary'
          : 'Additional'
      })),
      history
    });
  } catch (error) {
    return assignmentError(res, error, 'Unable to load trainer assignments');
  }
};

exports.assignMemberToTrainer = async (req, res) => {
  let session;
  try {
    const { memberId } = req.body || {};
    const assignmentRole = req.body?.assignmentRole || 'Primary';
    const trainingType = req.body?.trainingType || 'General';
    if (!validId(req.params.id) || !validId(memberId)) {
      return res.status(400).json({ success: false, message: 'Valid trainer and member IDs are required' });
    }
    if (!['Primary', 'Additional'].includes(assignmentRole)) {
      return res.status(400).json({ success: false, message: 'Invalid assignment role' });
    }
    if (!['General', 'Personal Training'].includes(trainingType)) {
      return res.status(400).json({ success: false, message: 'Invalid training type' });
    }

    session = await mongoose.startSession();
    let updatedMember;
    await session.withTransaction(async () => {
      const trainer = await TrainerStaff.findOne({
        _id: req.params.id,
        tenantId: req.tenantId,
        role: 'Trainer',
        status: 'Active'
      }).select('_id maxClientCapacity name').session(session).lean();
      if (!trainer) {
        const error = new Error('Only an active trainer can be assigned members');
        error.statusCode = 409;
        throw error;
      }

      const member = await Member.findOne({
        _id: memberId,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        deletedAt: null,
        status: 'Active'
      }).session(session);
      if (!member) {
        const error = new Error('Member not found in this business');
        error.statusCode = 404;
        throw error;
      }

      const alreadyAssigned = String(member.assignedTrainerId || '') === String(trainer._id) ||
        (member.additionalTrainerIds || []).some(id => String(id) === String(trainer._id));
      const capacity = Number(trainer.maxClientCapacity);
      if (!alreadyAssigned && Number.isInteger(capacity) && capacity > 0) {
        const assignedCount = await Member.countDocuments({
          tenantId: req.tenantId,
          businessId: req.owner.businessId,
          deletedAt: null,
          $or: [
            { assignedTrainerId: trainer._id },
            { additionalTrainerIds: trainer._id }
          ]
        }).session(session);
        if (assignedCount >= capacity && req.body?.capacityOverrideConfirmed !== true) {
          const error = new Error(`${trainer.name} is at the configured capacity of ${capacity} clients`);
          error.statusCode = 409;
          error.code = 'TRAINER_CAPACITY_EXCEEDED';
          error.capacity = { current: assignedCount, maximum: capacity };
          throw error;
        }
      }

      const now = new Date();
      if (assignmentRole === 'Primary') {
        let current = await TrainerAssignment.findOne({
          tenantId: req.tenantId,
          businessId: req.owner.businessId,
          memberId: member._id,
          assignmentRole: 'Primary',
          status: 'Active'
        }).session(session);
        const previousTrainerId = current?.trainerId || member.assignedTrainerId;

        if (previousTrainerId && String(previousTrainerId) !== String(trainer._id)) {
          if (current) {
            current.status = 'Ended';
            current.endedAt = now;
            await current.save({ session });
          } else {
            const previousTrainer = await TrainerStaff.findOne({
              _id: previousTrainerId,
              tenantId: req.tenantId,
              role: 'Trainer'
            }).select('_id').session(session).lean();
            if (previousTrainer) {
              await TrainerAssignment.create([{
                tenantId: req.tenantId,
                businessId: req.owner.businessId,
                memberId: member._id,
                trainerId: previousTrainer._id,
                assignmentRole: 'Primary',
                trainingType: 'General',
                assignedAt: member.updatedAt || member.createdAt || now,
                endedAt: now,
                status: 'Ended',
                createdBy: req.owner._id
              }], { session });
            }
          }
          current = null;
        }

        if (!current) {
          await TrainerAssignment.create([{
            tenantId: req.tenantId,
            businessId: req.owner.businessId,
            memberId: member._id,
            trainerId: trainer._id,
            assignmentRole: 'Primary',
            trainingType,
            assignedAt: now,
            status: 'Active',
            createdBy: req.owner._id
          }], { session });
        }
        member.assignedTrainerId = trainer._id;
      } else {
        const additionalIds = member.additionalTrainerIds || [];
        if (additionalIds.some(id => String(id) === String(trainer._id))) {
          const error = new Error('This trainer is already assigned as an additional trainer');
          error.statusCode = 409;
          throw error;
        }
        await TrainerAssignment.create([{
          tenantId: req.tenantId,
          businessId: req.owner.businessId,
          memberId: member._id,
          trainerId: trainer._id,
          assignmentRole: 'Additional',
          trainingType,
          assignedAt: now,
          status: 'Active',
          createdBy: req.owner._id
        }], { session });
        member.additionalTrainerIds = [...additionalIds, trainer._id];
      }

      await member.save({ session });
      updatedMember = member;
    });

    return res.json({ success: true, member: updatedMember });
  } catch (error) {
    return assignmentError(res, error, 'Unable to assign member to trainer');
  } finally {
    if (session) await session.endSession();
  }
};

exports.removeTrainerAssignment = async (req, res) => {
  let session;
  try {
    const { id: trainerId, memberId } = req.params;
    if (!validId(trainerId) || !validId(memberId)) {
      return res.status(400).json({ success: false, message: 'Valid trainer and member IDs are required' });
    }

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const member = await Member.findOne({
        _id: memberId,
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        deletedAt: null
      }).session(session);
      if (!member) {
        const error = new Error('Trainer assignment not found');
        error.statusCode = 404;
        throw error;
      }

      const isPrimary = String(member.assignedTrainerId || '') === String(trainerId);
      const isAdditional = (member.additionalTrainerIds || [])
        .some(id => String(id) === String(trainerId));
      if (!isPrimary && !isAdditional) {
        const error = new Error('Trainer assignment not found');
        error.statusCode = 404;
        throw error;
      }

      const role = isPrimary ? 'Primary' : 'Additional';
      const now = new Date();
      const current = await TrainerAssignment.findOne({
        tenantId: req.tenantId,
        businessId: req.owner.businessId,
        memberId: member._id,
        trainerId,
        assignmentRole: role,
        status: 'Active'
      }).session(session);
      if (current) {
        current.status = 'Ended';
        current.endedAt = now;
        await current.save({ session });
      } else {
        await TrainerAssignment.create([{
          tenantId: req.tenantId,
          businessId: req.owner.businessId,
          memberId: member._id,
          trainerId,
          assignmentRole: role,
          trainingType: 'General',
          assignedAt: member.updatedAt || member.createdAt || now,
          endedAt: now,
          status: 'Ended',
          createdBy: req.owner._id
        }], { session });
      }

      if (isPrimary) member.assignedTrainerId = null;
      else member.additionalTrainerIds = member.additionalTrainerIds.filter(
        id => String(id) !== String(trainerId)
      );
      await member.save({ session });
    });

    return res.json({ success: true });
  } catch (error) {
    return assignmentError(res, error, 'Unable to remove trainer assignment');
  } finally {
    if (session) await session.endSession();
  }
};
