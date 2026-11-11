const express = require('express');
const { protectOwner } = require('../middleware/authMiddleware');
const controller = require('../controllers/globalMessageController');

const router = express.Router();
router.use(protectOwner);

router.get('/summary', controller.getSummary);
router.get('/members', controller.getEligible);
router.post('/campaigns', controller.createCampaign);
router.get('/campaigns', controller.listCampaigns);
router.get('/campaigns/:campaignId', controller.getCampaign);
router.patch('/campaigns/:campaignId/status', controller.updateCampaignStatus);
router.patch('/campaigns/:campaignId/advance', controller.advanceCampaign);
router.patch('/campaigns/:campaignId/recipients/:memberId', controller.updateRecipient);

module.exports = router;
