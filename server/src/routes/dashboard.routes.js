'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requireRoles, ROLES } = require('../middleware/authorize');
const ctrl = require('../controllers/dashboard.controller');

const router = express.Router();

router.use(authenticate);
// The old all-in-one overview (no screen reads it any more): stock and missing boxes valued at cost, profit and
// customer debt, so the owner's only (15 Nov 2026, audit perm05).
router.get('/', requireRoles(ROLES.ADMIN), ctrl.overview);
router.get('/activity', requireRoles(ROLES.WAREHOUSE_STAFF), ctrl.activity);
router.get('/brands', requireRoles(ROLES.WAREHOUSE_STAFF), ctrl.brands);
router.get('/pending-actions', requireRoles(ROLES.WAREHOUSE_STAFF), ctrl.pendingActions);
router.get('/command', requireRoles(ROLES.WAREHOUSE_STAFF), ctrl.command);
// Margins, expenses and money in and out month by month: the owner's (15 Nov 2026, audit ui-r03).
router.get('/analysis', requireRoles(ROLES.ADMIN), ctrl.analysis);
router.get('/me', ctrl.myOverview);
router.get('/me/stats', ctrl.myStats);

module.exports = router;
