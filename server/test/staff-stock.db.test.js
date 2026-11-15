'use strict';

// ── What warehouse staff see and do with stock, against a REAL database (final check, 15 Nov 2026) ─────────
// ui-ad00 / reps-01 / ui-ad01: staff got stock valued at its buying price under plain names (`value`,
// heldStockValue, recommendedValue …) that no key-name strip catches — a value divided by its boxes was the
// buying price. reps-02: staff could add stock with Adjust, and a double tap added it twice. reps-03: "Reset data"
// on a rep still holding boxes deleted his ledger rows, so the boxes left stock with no record.
//
//   REPS_TEST_DATABASE_URL=postgresql://localhost/<throwaway copy> node --test --test-concurrency=1 test/staff-stock.db.test.js
//
// Never point it at production: it creates a test rep, moves boxes to him and back, and adds and takes off boxes in
// the warehouse (they come back to what they were).

const test = require('node:test');
const assert = require('node:assert');

const url = process.env.REPS_TEST_DATABASE_URL;
if (!url) {
  test('staff stock (real database)', { skip: 'set REPS_TEST_DATABASE_URL to a throwaway database' }, () => {});
  return;
}
process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only';

const prisma = require('../src/config/prisma');
const inventory = require('../src/services/inventory.service');
const reps = require('../src/controllers/salesReps.controller');
const reorder = require('../src/controllers/reorder.controller');
const inv = require('../src/controllers/inventory.controller');
const warehouses = require('../src/controllers/warehouses.controller');

const ctx = {};
// Run an Express handler and hand back its status and body, or the error it raised.
const call = (handler, req) => new Promise((resolve) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
  handler({ params: {}, query: {}, body: {}, headers: {}, ip: '::1', ...req }, res, (err) => resolve({ status: err?.statusCode || 500, error: err }));
});
// Every key of these names, at any depth.
const keysNamed = (o, re, out = []) => {
  if (Array.isArray(o)) o.forEach((v) => keysNamed(v, re, out));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (re.test(k)) out.push(k); keysNamed(v, re, out); }
  return out;
};
const COSTLY = /^(value|heldStockValue|recommendedValue|estimatedReorderValue|urgentValue|missingValue|stockValue)$/;
const productTotal = async (productId) => (await prisma.inventoryTransaction.aggregate({ where: { productId }, _sum: { baseQuantity: true } }))._sum.baseQuantity || 0;
const move = (from, to, boxes) => prisma.$transaction((tx) => inventory.transferStock(tx, {
  productId: ctx.product.id, packagingUnitId: ctx.unitId, quantity: boxes, baseQuantity: boxes, from, to, userId: ctx.admin.id, notes: 'staff-stock test',
}));

test.before(async () => {
  const stamp = Date.now();
  const adminUser = await prisma.user.findFirst({ where: { role: { name: 'ADMIN' }, isActive: true } });
  const staffUser = await prisma.user.findFirst({ where: { role: { name: 'WAREHOUSE_STAFF' } } });
  ctx.admin = { id: adminUser.id, name: adminUser.name, role: 'ADMIN' };
  ctx.staff = { id: (staffUser || adminUser).id, name: 'Staff', role: 'WAREHOUSE_STAFF' };
  ctx.warehouseId = (await prisma.warehouse.findFirst({ where: { isActive: true }, orderBy: { isPrimary: 'desc' } })).id;
  ctx.product = await prisma.product.findFirst({ where: { name: 'Civlily Ndogo (Brown) Bila Filter', isActive: true } });
  assert.ok(ctx.product && Number(ctx.product.purchasePrice) > 0, 'needs the Civlily product with a buying price');
  ctx.unitId = (await prisma.productPackaging.findFirst({ where: { productId: ctx.product.id, isBaseUnit: true } })).packagingUnitId;
  const role = await prisma.role.findFirst({ where: { name: 'SALES_REP' } });
  const user = await prisma.user.create({ data: { name: `Stock Test Rep ${stamp}`, email: `staff-stock-${stamp}@test.local`, passwordHash: 'not-a-login', roleId: role.id } });
  ctx.rep = await prisma.salesRepresentative.create({ data: { userId: user.id, code: `ST-${stamp}` } });
  ctx.wh = { type: 'WAREHOUSE', warehouseId: ctx.warehouseId };
  ctx.repPlace = { type: 'SALES_REP', salesRepId: ctx.rep.id };
  await move(ctx.wh, ctx.repPlace, 2); // the rep holds 2 boxes
});

test.after(async () => { await prisma.$disconnect(); });

test('ui-ad00 / reps-01: a rep\'s stock reaches staff as boxes only; the owner still gets its value at cost', async () => {
  const id = ctx.rep.id;
  for (const [name, handler, req] of [
    ['profile', reps.getProfile, { params: { id } }],
    ['detail', reps.get, { params: { id } }],
    ['stock', reps.getStock, { params: { id } }],
    ['reconciliation', reps.getReconciliation, { params: { id } }],
    ['list', reps.list, { query: { limit: 100 } }],
  ]) {
    const staff = await call(handler, { ...req, user: ctx.staff });
    assert.equal(staff.status, 200, name);
    const data = name === 'profile' ? staff.body.data.stock : staff.body.data;
    assert.deepEqual(keysNamed(data, COSTLY), [], `${name}: no stock value for staff`);
  }
  const staffStock = (await call(reps.getStock, { params: { id }, user: ctx.staff })).body.data.stock;
  assert.deepEqual(staffStock.map((s) => [s.productId, s.baseQuantity]), [[ctx.product.id, 2]], 'staff still see the boxes');

  const admin = await call(reps.getProfile, { params: { id }, user: ctx.admin });
  const cost = 2 * Number(ctx.product.purchasePrice);
  assert.equal(admin.body.data.stock.value, cost, 'the owner keeps the value at cost');
  assert.equal(admin.body.data.stock.items[0].value, cost);
  const adminDetail = await call(reps.get, { params: { id }, user: ctx.admin });
  assert.equal(adminDetail.body.data.heldStockValue, cost);
  const adminList = await call(reps.list, { query: { limit: 100 }, user: ctx.admin });
  assert.equal(adminList.body.data.find((r) => r.id === id).heldStockValue, cost);
});

test('ui-ad01 / reps-01: the reorder list reaches staff without what it costs; the owner keeps it', async () => {
  const staff = await call(reorder.analysis, { user: ctx.staff });
  assert.equal(staff.status, 200);
  assert.deepEqual(keysNamed(staff.body.data, COSTLY), []);
  assert.ok(staff.body.data.items.length > 0 && 'recommendedQty' in staff.body.data.items[0], 'the boxes to order are still there');
  const admin = await call(reorder.analysis, { user: ctx.admin });
  assert.ok('estimatedReorderValue' in admin.body.data.summary && 'urgentValue' in admin.body.data.summary);
  assert.ok(admin.body.data.items.every((i) => 'recommendedValue' in i));
});

test('a warehouse\'s stock reaches anyone but the owner as boxes only', async () => {
  const staff = await call(warehouses.get, { params: { id: ctx.warehouseId }, user: ctx.staff });
  assert.equal(staff.status, 200);
  assert.deepEqual(keysNamed(staff.body.data, COSTLY), []);
  const admin = await call(warehouses.get, { params: { id: ctx.warehouseId }, user: ctx.admin });
  assert.ok('stockValue' in admin.body.data && admin.body.data.stock.every((s) => 'value' in s));
});

test('reps-02: only the owner adds boxes with Adjust, each press once; staff still take boxes off, each press once', async () => {
  const before = await productTotal(ctx.product.id);
  const line = { productId: ctx.product.id, packagingUnitId: ctx.unitId, quantity: 2 };
  const up = { location: ctx.wh, direction: 'INCREASE', reason: 'staff-stock test', ...line };

  const staffUp = await call(inv.adjust, { body: { ...up, clientKey: `st-up-${Date.now()}` }, user: ctx.staff });
  assert.equal(staffUp.status, 403);
  const staffUpRep = await call(inv.adjust, { body: { ...up, location: ctx.repPlace, clientKey: `st-up-rep-${Date.now()}` }, user: ctx.staff });
  assert.equal(staffUpRep.status, 403, 'nor into a rep\'s stock');
  assert.equal((await call(inv.adjust, { body: up, user: ctx.admin })).status, 400, 'the owner\'s press needs its key');
  assert.equal(await productTotal(ctx.product.id), before, 'nothing moved yet');

  // Two presses of the owner's form at the same instant: one adds, the other is told it is already in.
  const key = `ad-up-${Date.now()}`;
  const [a, b] = await Promise.all([call(inv.adjust, { body: { ...up, clientKey: key }, user: ctx.admin }), call(inv.adjust, { body: { ...up, clientKey: key }, user: ctx.admin })]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal([a, b].find((r) => r.status === 409).error.details.alreadySaved, true);
  assert.equal(await productTotal(ctx.product.id), before + 2, 'added once');
  assert.equal(await prisma.inventoryTransaction.count({ where: { referenceType: 'ADJUSTMENT', referenceId: key } }), 1);

  // Staff take them off again, with a double tap.
  const offKey = `st-off-${Date.now()}`;
  const off = { location: ctx.wh, direction: 'DECREASE', reason: 'staff-stock test', ...line, clientKey: offKey };
  const [c, d] = await Promise.all([call(inv.adjust, { body: off, user: ctx.staff }), call(inv.adjust, { body: off, user: ctx.staff })]);
  assert.deepEqual([c.status, d.status].sort(), [201, 409]);
  assert.equal(await productTotal(ctx.product.id), before, 'taken off once: back where it started');
  // Damage by staff still works, and still without a key from an old screen.
  const dmg = await call(inv.damage, { body: { location: ctx.wh, reason: 'staff-stock test', ...line, quantity: 1 }, user: ctx.staff });
  assert.equal(dmg.status, 201);
  const back = `ad-back-${Date.now()}`;
  assert.equal((await call(inv.adjust, { body: { ...up, quantity: 1, clientKey: back }, user: ctx.admin })).status, 201);
  assert.equal(await productTotal(ctx.product.id), before);
});

test('reps-03: Reset data refuses while the rep holds boxes, and the boxes stay on the books; once back, it resets', async () => {
  const before = await productTotal(ctx.product.id);
  const confirm = { confirm: ctx.rep.code };
  const refused = await call(reps.resetData, { params: { id: ctx.rep.id }, body: confirm, user: ctx.admin });
  assert.equal(refused.status, 400);
  assert.match(refused.error.message, /still holding 2 boxes\. Take the boxes back first/);
  assert.equal(await productTotal(ctx.product.id), before, 'no box left the books');
  assert.equal(await inventory.getBalance(prisma, { productId: ctx.product.id, type: 'SALES_REP', salesRepId: ctx.rep.id }), 2);
  // The purge (delete for good) goes through the same wipe.
  const purge = await call(reps.remove, { params: { id: ctx.rep.id }, body: { purge: true, confirm: ctx.rep.code }, user: ctx.admin });
  assert.equal(purge.status, 400);

  await move(ctx.repPlace, ctx.wh, 2); // the boxes come back
  const done = await call(reps.resetData, { params: { id: ctx.rep.id }, body: confirm, user: ctx.admin });
  assert.equal(done.status, 200);
  assert.equal(await productTotal(ctx.product.id), before, 'the reset moved no box in or out of the books');
  assert.equal(await prisma.inventoryTransaction.count({ where: { salesRepId: ctx.rep.id } }), 0);
});
