const TrainerPTPackage = require('../models/TrainerPTPackage');
const TrainerStaff = require('../models/TrainerStaff');
const Business = require('../models/Business');
const {
  isValidTimeZone,
  DEFAULT_TIME_ZONE
} = require('../utils/membershipExpiry');
const {
  getExpiringPTWindow,
  getRemainingDays
} = require('../utils/expiringPTClients');

exports.listExpiringPTClients = async (req, res) => {
  try {
    const business = await Business.findById(req.tenantId).select('timeZone').lean();
    const timeZone = isValidTimeZone(business?.timeZone)
      ? business.timeZone
      : DEFAULT_TIME_ZONE;
    const window = getExpiringPTWindow(new Date(), timeZone);
    const filter = {
      tenantId: req.tenantId,
      businessId: req.owner.businessId,
      status: 'Active',
      endDate: { $gte: window.start, $lt: window.endExclusive }
    };

    if (req.params.trainerId) filter.trainerId = req.params.trainerId;

    const packages = await TrainerPTPackage.find(filter)
      .populate('memberId', 'fullName phone memberId')
      .populate('trainerId', 'name trainerId')
      .sort({ endDate: 1, createdAt: -1 })
      .lean();

    const search = String(req.query.search || '').trim().toLowerCase();
    const trainerFilter = String(req.query.trainerId || '').trim();
    const byMember = new Map();

    for (const ptPackage of packages) {
      if (!ptPackage.memberId) continue;
      const memberId = String(ptPackage.memberId._id || ptPackage.memberId);
      if (trainerFilter && String(ptPackage.trainerId?._id || '') !== trainerFilter) continue;

      const searchable = [
        ptPackage.memberId.fullName,
        ptPackage.memberId.phone,
        ptPackage.memberId.memberId
      ].join(' ').toLowerCase();
      if (search && !searchable.includes(search)) continue;
      if (byMember.has(memberId)) continue;

      byMember.set(memberId, {
        packageId: ptPackage._id,
        member: {
          _id: ptPackage.memberId._id,
          fullName: ptPackage.memberId.fullName,
          phone: ptPackage.memberId.phone,
          memberId: ptPackage.memberId.memberId
        },
        trainer: ptPackage.trainerId
          ? { _id: ptPackage.trainerId._id, name: ptPackage.trainerId.name, trainerId: ptPackage.trainerId.trainerId }
          : null,
        packageName: ptPackage.packageName,
        startDate: ptPackage.startDate,
        expiryDate: ptPackage.endDate,
        remainingDays: getRemainingDays(ptPackage.endDate, new Date(), timeZone),
        status: 'Active'
      });
    }

    const records = Array.from(byMember.values())
      .sort((a, b) => a.remainingDays - b.remainingDays);

    return res.json({
      success: true,
      timeZone,
      window: 'Next 5 Days',
      total: records.length,
      records
    });
  } catch (error) {
    console.error('Expiring PT clients error:', error);
    return res.status(500).json({
      success: false,
      message: 'Unable to load expiring personal training clients'
    });
  }
};
