'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requireRoles, requireAdmin, ROLES } = require('../middleware/authorize');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/inventory.controller');
const { stockIn, adjustment, damage, balanceQuery, movementQuery } = require('../validators/inventory.validator');

const router = express.Router();
const warehouseStaff = requireRoles(ROLES.WAREHOUSE_STAFF);

router.use(authenticate);

// Staff only: warehouse levels, every rep's holdings and costs.
router.get('/balances', warehouseStaff, validate(balanceQuery), ctrl.balances);
router.get('/movements', warehouseStaff, validate(movementQuery), ctrl.movements);

// Opening stock is the admin's: stock enters through a purchase order or an explained entry by the admin (audit purc05).
router.post('/stock-in', requireAdmin, validate(stockIn), ctrl.stockIn);
router.post('/adjustments', warehouseStaff, validate(adjustment), ctrl.adjust);
router.post('/damage', warehouseStaff, validate(damage), ctrl.damage);
router.post('/recompute-caches', requireAdmin, ctrl.recomputeCaches);
// No route deletes a ledger row (audit purc03, 15 Nov 2026): deleting one half of a transfer or a PO receipt made
// or destroyed stock while its document stayed complete. A mistaken entry is put right with a new one — an
// Adjust in the other direction, with its reason — and both stay in the ledger.

module.exports = router;
