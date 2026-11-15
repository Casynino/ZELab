'use strict';

const express = require('express');
const { z } = require('zod');
const { authenticate } = require('../middleware/auth');
const { requireRoles, ROLES } = require('../middleware/authorize');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/invoices.controller');

const router = express.Router();
// The invoice tool: Sales > Invoice for the admin and the warehouse, and Invoice in a rep's own menu (reps have
// no Sales page and make invoices for their customers). Every number comes from the one shared counter, so a
// rep's invoice never repeats anyone's number, and each number is audit-logged with who asked for it (ui-re00:
// limiting this to staff left the rep's menu item failing with 403 on every press).
const issuers = requireRoles(ROLES.WAREHOUSE_STAFF, ROLES.SALES_REP);

const numberBody = {
  body: z.object({
    // The highest number this device handed out on its own before numbers came from the server.
    after: z.coerce.number().int().min(0).max(1_000_000).optional(),
    customer: z.string().trim().max(200).optional().nullable(),
    total: z.coerce.number().min(0).max(1e13).optional().nullable(),
    lines: z.coerce.number().int().min(0).max(500).optional().nullable(),
  }),
};

router.use(authenticate);
router.post('/number', issuers, validate(numberBody), ctrl.number);

module.exports = router;
