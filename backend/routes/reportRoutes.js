const express = require('express');
const { protectOwner } = require('../middleware/authMiddleware');
const { getOperationalReport } = require('../controllers/reportController');

const router = express.Router();
router.use(protectOwner);
router.get('/', getOperationalReport);

module.exports = router;
