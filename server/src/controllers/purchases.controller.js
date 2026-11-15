'use strict';

const asyncHandler = require('../utils/asyncHandler');
const { ok, created, paginated } = require('../utils/response');
const { parsePagination } = require('../utils/pagination');
const purchase = require('../services/purchase.service');
const audit = require('../services/audit.service');
const { ROLES } = require('../middleware/authorize');

// The warehouse counts cargo; what it cost is the owner's (cash-only, 15 Nov 2026). Prices, totals and the
// payments are taken off every order a non-owner is sent.
// `toPay` is the order's price still to pay (audit purc07): it carried the full total to staff.
const MONEY_KEYS = ['goodsCost', 'shippingCost', 'clearingCost', 'otherCost', 'totalCost', 'payments', 'toPay'];
function forViewer(po, user) {
  if (!po || user?.role === ROLES.ADMIN) return po;
  const out = { ...po };
  MONEY_KEYS.forEach((k) => delete out[k]);
  out.items = (po.items || []).map(({ unitCost, landedUnitCost, ...rest }) => rest); // eslint-disable-line no-unused-vars
  return out;
}

// --- Suppliers -------------------------------------------------------------
const listSuppliers = asyncHandler(async (req, res) => {
  const q = req.validatedQuery || req.query;
  const pagination = parsePagination(q, { defaultSortBy: 'name', defaultSortDir: 'asc', allowedSortFields: ['name', 'createdAt'] });
  const { items, total } = await purchase.listSuppliers(q, pagination);
  return paginated(res, items, { page: pagination.page, limit: pagination.limit, total });
});

const createSupplier = asyncHandler(async (req, res) => {
  const body = { ...req.body };
  if (body.email === '') body.email = null;
  const supplier = await purchase.createSupplier(body);
  await audit.record(req, { action: 'CREATE', entityType: 'Supplier', entityId: supplier.id, newValues: { name: supplier.name } });
  return created(res, supplier);
});

const updateSupplier = asyncHandler(async (req, res) => {
  const supplier = await purchase.updateSupplier(req.params.id, req.body);
  await audit.record(req, { action: 'UPDATE', entityType: 'Supplier', entityId: supplier.id });
  return ok(res, supplier);
});

const removeSupplier = asyncHandler(async (req, res) => {
  const result = await purchase.removeSupplier(req.params.id);
  // The log says what really happened: a supplier with history is switched off, not deleted.
  await audit.record(req, { action: result.deactivated ? 'DEACTIVATE' : 'DELETE', entityType: 'Supplier', entityId: req.params.id });
  return ok(res, result);
});

// --- Purchase orders -------------------------------------------------------
const listPOs = asyncHandler(async (req, res) => {
  const q = req.validatedQuery || req.query;
  const pagination = parsePagination(q, { defaultSortBy: 'createdAt', defaultSortDir: 'desc' });
  const { items, total, onTheWay, counts } = await purchase.listPurchaseOrders(q, pagination);
  const owner = req.user?.role === ROLES.ADMIN;
  const way = owner ? onTheWay : { ...onTheWay, value: undefined, orders_: onTheWay.orders_.map(({ totalCost, ...o }) => o) }; // eslint-disable-line no-unused-vars
  return paginated(res, items.map((po) => forViewer(po, req.user)), { page: pagination.page, limit: pagination.limit, total, onTheWay: way, counts });
});

const getPO = asyncHandler(async (req, res) => ok(res, forViewer(await purchase.getPurchaseOrder(req.params.id), req.user)));

const deletePO = asyncHandler(async (req, res) => {
  const po = await purchase.deletePurchaseOrder(req.params.id);
  await audit.record(req, {
    action: 'DELETE',
    entityType: 'PurchaseOrder',
    entityId: req.params.id,
    oldValues: { poNumber: po.poNumber, supplierId: po.supplierId, totalCost: po.totalCost, status: po.status },
  });
  return ok(res, { deleted: true, poNumber: po.poNumber });
});

const createPO = asyncHandler(async (req, res) => {
  const po = await purchase.createPurchaseOrder(req.body, req.user);
  await audit.record(req, { action: 'CREATE', entityType: 'PurchaseOrder', entityId: po.id, newValues: { poNumber: po.poNumber, totalCost: po.totalCost } });
  return created(res, po);
});

const updatePO = asyncHandler(async (req, res) => {
  const po = await purchase.updatePurchaseOrder(req.params.id, req.body);
  await audit.record(req, { action: 'UPDATE', entityType: 'PurchaseOrder', entityId: po.id });
  return ok(res, po);
});

const receivePO = asyncHandler(async (req, res) => {
  const po = await purchase.receivePurchaseOrder(req.params.id, req.user, req.body);
  await audit.record(req, { action: 'RECEIVE', entityType: 'PurchaseOrder', entityId: po.id, newValues: { poNumber: po.poNumber } });
  return ok(res, po);
});

// --- Cash-only purchasing steps (15 Nov 2026) ------------------------------
const confirmPurchase = asyncHandler(async (req, res) => {
  const po = await purchase.confirmPurchase(req.params.id, req.body, req.user);
  await audit.record(req, { action: 'PURCHASE_CONFIRMED', entityType: 'PurchaseOrder', entityId: po.id, newValues: { poNumber: po.poNumber, totalCost: po.totalCost, accountId: req.body.accountId || null } });
  return ok(res, po);
});

const undoPurchase = asyncHandler(async (req, res) => {
  const po = await purchase.undoPurchase(req.params.id, req.body, req.user);
  await audit.record(req, { action: 'PURCHASE_UNDONE', entityType: 'PurchaseOrder', entityId: po.id, newValues: { poNumber: po.poNumber, reason: req.body.reason } });
  return ok(res, po);
});

const addCost = asyncHandler(async (req, res) => {
  const po = await purchase.addOrderCost(req.params.id, req.body, req.user);
  await audit.record(req, { action: 'COST_ADDED', entityType: 'PurchaseOrder', entityId: po.id, newValues: { poNumber: po.poNumber, kind: req.body.kind, amount: req.body.amount, accountId: req.body.accountId } });
  return ok(res, po);
});

const receiveCargo = asyncHandler(async (req, res) => {
  const { order, receipt } = await purchase.receiveCargo(req.params.id, req.body, req.user);
  await audit.record(req, {
    action: 'CARGO_RECEIVED',
    entityType: 'PurchaseOrder',
    entityId: order.id,
    newValues: {
      poNumber: order.poNumber, receiptId: receipt.id, status: order.status,
      lines: req.body.items.filter((i) => i.received || i.damaged || i.missing)
        .map((i) => ({ itemId: i.itemId, received: i.received || 0, damaged: i.damaged || 0, missing: i.missing || 0 })),
    },
  });
  return ok(res, order);
});

const listLines = asyncHandler(async (req, res) => ok(res, await purchase.listPurchaseLines(req.validatedQuery || req.query)));

module.exports = {
  listSuppliers, createSupplier, updateSupplier, removeSupplier, listPOs, getPO, deletePO, createPO, updatePO, receivePO,
  confirmPurchase, undoPurchase, addCost, receiveCargo, listLines,
};
