'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requireRoles, ROLES } = require('../middleware/authorize');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/purchases.controller');
const { supplierCreate, supplierUpdate, supplierQuery } = require('../validators/phase2.validator');
const { idParam } = require('../validators/common.validator');

const router = express.Router();
const staff = requireRoles(ROLES.WAREHOUSE_STAFF);
// Suppliers are bought from and paid by the owner only (cash-only purchasing, 15 Nov 2026), so only he adds,
// edits, switches off or deletes one (audit perm03). Staff may still read the list, as the order pages do.
const owner = requireRoles(ROLES.ADMIN);

router.use(authenticate, staff);
router.get('/', validate(supplierQuery), ctrl.listSuppliers);
router.post('/', owner, validate(supplierCreate), ctrl.createSupplier);
router.put('/:id', owner, validate({ ...idParam, ...supplierUpdate }), ctrl.updateSupplier);
router.delete('/:id', owner, validate(idParam), ctrl.removeSupplier);

module.exports = router;
