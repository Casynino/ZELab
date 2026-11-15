'use strict';

const express = require('express');
const { authenticate } = require('../middleware/auth');
const { requireRoles, ROLES } = require('../middleware/authorize');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/purchases.controller');
const {
  poCreate, poUpdate, poReceive, poQuery,
  poConfirmPurchase, poUndoPurchase, poReceiveCargo, poLinesQuery, poAddCost,
} = require('../validators/phase2.validator');
const { idParam } = require('../validators/common.validator');

const router = express.Router();
const staff = requireRoles(ROLES.WAREHOUSE_STAFF);
// Buying and receiving are the admin's (cash-only, 15 Nov 2026: the admin is also the warehouse). Other staff
// can still look at the orders, without prices; reps never reach this router.
const owner = requireRoles(ROLES.ADMIN);

router.use(authenticate, staff);
router.get('/', validate(poQuery), ctrl.listPOs);
router.get('/lines', owner, validate(poLinesQuery), ctrl.listLines); // purchase history by product
router.get('/:id', validate(idParam), ctrl.getPO);
router.post('/', owner, validate(poCreate), ctrl.createPO);
router.put('/:id', owner, validate({ ...idParam, ...poUpdate }), ctrl.updatePO);
router.post('/:id/receive', owner, validate({ ...idParam, ...poReceive }), ctrl.receivePO); // orders from before the cash-only flow
router.delete('/:id', owner, validate(idParam), ctrl.deletePO); // only a draft
router.post('/:id/purchase', owner, validate({ ...idParam, ...poConfirmPurchase }), ctrl.confirmPurchase);
router.post('/:id/undo-purchase', owner, validate({ ...idParam, ...poUndoPurchase }), ctrl.undoPurchase);
router.post('/:id/costs', owner, validate({ ...idParam, ...poAddCost }), ctrl.addCost);
router.post('/:id/receive-cargo', owner, validate({ ...idParam, ...poReceiveCargo }), ctrl.receiveCargo);

module.exports = router;
