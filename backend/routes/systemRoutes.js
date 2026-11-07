const express = require('express');
const { protectOwner } = require('../middleware/authMiddleware');
const {
  getDatabaseStatus,
  getDatabaseStorage,
  getCollections,
  getCollectionStats,
  refreshDatabaseStorage,
  getManagementRecords,
  getDeletePreview,
  deleteSelectedRecords,
  getDataManagementHistory
} = require('../controllers/systemController');
const config = require('../config/env');

const router = express.Router();

router.use(protectOwner, (req, res, next) => {
  if (!req.owner || req.owner.role !== 'owner' || !req.tenantId) {
    return res.status(403).json({
      success: false,
      message: 'An authenticated business owner is required.'
    });
  }
  req.isPlatformAdmin = config.platformAdminOwnerIds.includes(String(req.owner._id));
  return next();
});

router.get('/database-status', getDatabaseStatus);
router.get('/database-storage', getDatabaseStorage);
router.get('/collections', getCollections);
router.get('/collections/:collectionName/stats', getCollectionStats);
router.post('/database-storage/refresh', refreshDatabaseStorage);
router.get('/data-management/records', getManagementRecords);
router.post('/data-management/preview', getDeletePreview);
router.post('/data-management/delete', deleteSelectedRecords);
router.get('/data-management/history', getDataManagementHistory);

module.exports = router;
