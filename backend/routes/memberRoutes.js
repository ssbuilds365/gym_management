const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('node:path');

const {
  createMember,
  getAllMembers,
  updateMember,
  deleteMember,
  generateMemberQR
} = require('../controllers/memberController');
const memberImport = require('../controllers/memberImportController');

const { protectOwner } = require('../middleware/authMiddleware');

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!['.xlsx', '.xls', '.csv'].includes(extension)) {
      const error = new Error('Unsupported file extension.');
      error.code = 'UNSUPPORTED_FILE_EXTENSION';
      return callback(error);
    }
    callback(null, true);
  }
});

const handleImportUpload = (req, res, next) =>
  importUpload.single('file')(req, res, error => {
    if (error) {
      console.error('Member import upload middleware error:', {
        code: error.code || 'UPLOAD_ERROR',
        message: error.message
      });
      let message = 'Unable to process the uploaded file.';
      if (error.code === 'LIMIT_FILE_SIZE') {
        message = 'The file exceeds the 10 MB size limit.';
      } else if (error.code === 'UNSUPPORTED_FILE_EXTENSION') {
        message = 'Unsupported file extension. Please select an XLSX, XLS or CSV file.';
      } else if (error.code === 'LIMIT_UNEXPECTED_FILE') {
        message = 'Upload the spreadsheet using the file field.';
      }
      return res.status(400).json({
        success: false,
        message
      });
    }
    next();
  });

router.post('/import/preview', protectOwner, handleImportUpload, memberImport.previewMemberImport);
router.post('/import/confirm', protectOwner, memberImport.confirmMemberImport);
router.get('/import/template', protectOwner, memberImport.downloadMemberImportTemplate);
router.get('/import/history', protectOwner, memberImport.getMemberImportHistory);
router.get('/import/history/:batchId', protectOwner, memberImport.getMemberImportBatch);
router.get('/import/history/:batchId/report', protectOwner, memberImport.downloadMemberImportReport);
router.get('/import/history/:batchId/delete-preview', protectOwner, memberImport.previewMemberImportDeletion);
router.post('/import/history/:batchId/delete', protectOwner, memberImport.deleteImportedMembers);

router.post('/', protectOwner, createMember);

router.get('/', protectOwner, getAllMembers);

router.put('/:id', protectOwner, updateMember);

router.delete('/:id', protectOwner, deleteMember);

router.post('/:id/generate-qr', protectOwner, generateMemberQR);

router.handleImportUpload = handleImportUpload;

module.exports = router;