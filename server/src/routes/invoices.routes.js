'use strict';

const express = require('express');
const { z } = require('zod');
const { authenticate } = require('../middleware/auth');
const { requireRoles, ROLES } = require('../middleware/authorize');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/invoices.controller');

const router = express.Router();
// The invoice tool is a staff tool (Sales > Invoice): the admin and the warehouse, never a rep.
const issuers = requireRoles(ROLES.WAREHOUSE_STAFF);

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
