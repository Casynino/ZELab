'use strict';

// ── Purchases and stock, audit round (15 Nov 2026) ─────────────────────────────────────────────────
// Pinned:
//  - Reorder takes off what is already bought and on the way, and a product it fully covers is not a reorder
//    (purc02);
//  - no route deletes a stock ledger row, and the cache rebuild runs in one transaction behind a ledger lock
//    (purc03);
//  - a cancelled order's products, prices, supplier and dates are frozen; only its notes change (purc04);
//  - opening stock is the admin's, STOCK_IN only, with a reason, once per press, never for a switched-off
//    product (purc05);
//  - a switched-off supplier or product gets no new order and no payment (purc08);
//  - price history lists bought lines only, with or without dates (purc09);
//  - a product edit never writes a stale buying price over the average cost receiving set (purc10).

const test = require('node:test');
const assert = require('node:assert/strict');

const install = (path, exports) => {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

// One database stand-in for the whole file; each test sets the tables it reads.
const db = {
  $transaction: async (fn) => fn(db),
  $queryRaw: async () => [{ id: 'locked' }],
};
install('../src/config/prisma', db);
install('../src/config/env', { business: { reorderLookbackDays: 30, currency: 'TZS' } });
install('../src/services/audit.service', { record: async () => {} });

const reorder = require('../src/services/reorder.service');
const purchase = require('../src/services/purchase.service');
const products = require('../src/services/products.service');
const inventory = require('../src/services/inventory.service');

// ── purc02: Reorder and stock on the way ─────────────────────────────────────────────────────────────
// Pepa: out of stock, selling 2 a day (60 in 30 days), carton of 50 as the pack size, minimum 10.
function reorderDb({ coming }) {
  db.product = {
    findMany: async () => [
      { id: 'pepa', name: 'Pepa Ndogo', sku: 'P1', minStockLevel: 10, reorderQuantity: 50, purchasePrice: 1000, baseUnitName: 'Box', isActive: true },
    ],
  };
  db.inventoryTransaction = {
    groupBy: async ({ where = {} }) => {
      if (where.type) return [{ productId: 'pepa', _sum: { baseQuantity: -60 } }];
      return [{ productId: 'pepa', _sum: { baseQuantity: 0 } }];
    },
  };
  db.purchaseOrderItem = {
    findMany: async ({ where }) => {
      assert.deepEqual(where.purchaseOrder.status.in, ['ORDERED', 'PURCHASED', 'IN_TRANSIT', 'PARTLY_RECEIVED'], 'drafts, cancelled and completed orders bring nothing');
      return coming;
    },
  };
}

test('reorder: nothing on the way asks for the full gap, as before', async () => {
  reorderDb({ coming: [] });
  const r = await reorder.reorderAnalysis();
  const pepa = r.items.find((i) => i.productId === 'pepa');
  assert.equal(pepa.onTheWay, 0);
  assert.equal(pepa.recommendedQty, 60, '30 days at 2 a day');
  assert.equal(r.summary.reorderCount, 1);
});

test('reorder: cargo bought and on the way comes off what to buy', async () => {
  // 1 carton (50) bought on one order, 30 more on another, 20 of which were received and 5 marked missing.
  reorderDb({ coming: [{ productId: 'pepa', baseQuantity: 50, receivedBase: 0, missingBase: 0 }, { productId: 'pepa', baseQuantity: 30, receivedBase: 20, missingBase: 5 }] });
  const r = await reorder.reorderAnalysis();
  const pepa = r.items.find((i) => i.productId === 'pepa');
  assert.equal(pepa.onTheWay, 55, 'what was bought, less received and missing');
  assert.equal(pepa.recommendedQty, 50, 'gap 60 - 55 = 5, rounded up to the 50 pack only because something is still short');
  assert.match(pepa.reason, /55 already bought and on the way/);
  assert.equal(pepa.urgency, 'CRITICAL', 'the shelf is still empty today');
});

test('reorder: fully covered is not a reorder, and is counted as covered', async () => {
  reorderDb({ coming: [{ productId: 'pepa', baseQuantity: 100, receivedBase: 0, missingBase: 0 }] });
  const r = await reorder.reorderAnalysis();
  const pepa = r.items.find((i) => i.productId === 'pepa');
  assert.equal(pepa.recommendedQty, 0, 'never the 50 pack size on top of a covered gap');
  assert.equal(pepa.needsReorder, false);
  assert.equal(r.recommendations.length, 0, 'no reorder row, so no reorder alert');
  assert.equal(r.summary.coveredCount, 1);
  assert.match(pepa.message, /100 more already bought and on the way/);
});

// A product that has never had a box in (Pepa still being made, 19 Nov 2026) is NEW: not out of stock, not
// below the minimum, nothing on the order, in no count — while a sold-out product with history still is.
test('reorder: never stocked is NEW, not out of stock, and puts nothing on the order', async () => {
  db.product = {
    findMany: async () => [
      { id: 'newp', name: 'Pepa Ndogo Kubwa', sku: 'P2', minStockLevel: 50, reorderQuantity: 50, purchasePrice: 14000, baseUnitName: 'Box', isActive: true },
      { id: 'gone', name: 'OHIS Ndogo', sku: 'O1', minStockLevel: 50, reorderQuantity: 50, purchasePrice: 10000, baseUnitName: 'Box', isActive: true },
    ],
  };
  db.inventoryTransaction = {
    groupBy: async ({ where = {} }) => {
      // Only OHIS was ever received or sold; the new product only has a +1 / -1 test adjustment, which is not stock.
      if (where.type?.in?.includes('PURCHASE_RECEIPT')) return [{ productId: 'gone' }];
      return []; // nothing sold in the window, nothing on hand anywhere
    },
  };
  db.purchaseOrderItem = { findMany: async () => [] };
  const r = await reorder.reorderAnalysis();
  const fresh = r.items.find((i) => i.productId === 'newp');
  const gone = r.items.find((i) => i.productId === 'gone');
  assert.equal(fresh.urgency, 'NEW');
  assert.equal(fresh.neverStocked, true);
  assert.equal(fresh.recommendedQty, 0);
  assert.equal(fresh.needsReorder, false);
  assert.equal(fresh.belowMin, false, 'not "below the minimum" either');
  assert.match(fresh.reason, /not stocked yet/);
  assert.equal(gone.urgency, 'MEDIUM', 'sold out with history: still out of stock');
  assert.equal(gone.recommendedQty, 50);
  assert.deepEqual(r.recommendations.map((i) => i.productId), ['gone']);
  assert.equal(r.summary.newCount, 1);
  assert.equal(r.summary.belowMinCount, 1);
  assert.equal(r.summary.noVelocityCount, 1, 'the new product is not counted as "sold nothing"');
  assert.equal(r.summary.estimatedReorderValue, 500000, 'only the sold-out product is on the order');
});

// ── purc03: ledger rows are never deleted; the cache rebuild is one locked transaction ────────────────
test('no route deletes a stock ledger row', () => {
  const router = require('../src/routes/inventory.routes');
  const deletes = router.stack.filter((l) => l.route && l.route.methods.delete);
  assert.deepEqual(deletes.map((l) => l.route.path), []);
  assert.equal(require('../src/controllers/inventory.controller').deleteMovement, undefined);
});

test('the cache rebuild locks the ledger first and runs in one transaction', async () => {
  const calls = [];
  const tx = {
    $executeRawUnsafe: async (sql) => { calls.push(sql); },
    inventoryTransaction: {
      groupBy: async ({ by }) => (by.includes('warehouseId')
        ? [{ productId: 'p1', warehouseId: 'w1', _sum: { baseQuantity: 7 } }]
        : [{ productId: 'p1', salesRepId: 'r1', _sum: { baseQuantity: 3 } }]),
    },
    warehouseStock: { updateMany: async () => { calls.push('zero warehouse'); }, upsert: async ({ update }) => { calls.push(`warehouse ${update.baseQuantity}`); } },
    repStock: { updateMany: async () => { calls.push('zero rep'); }, upsert: async ({ update }) => { calls.push(`rep ${update.baseQuantity}`); } },
  };
  let opened = 0;
  const client = { $transaction: async (fn, opts) => { opened += 1; assert.ok(opts.timeout >= 30000); return fn(tx); } };
  const out = await inventory.recomputeAllCaches(client);
  assert.equal(opened, 1);
  assert.deepEqual(calls, ['LOCK TABLE "inventory_transactions" IN EXCLUSIVE MODE', 'zero warehouse', 'zero rep', 'warehouse 7', 'rep 3']);
  assert.deepEqual(out, { warehouseRows: 1, repRows: 1 });
});

// ── purc04: a cancelled order is frozen ──────────────────────────────────────────────────────────────
test('a cancelled order\'s lines, supplier, costs and dates cannot change; its notes can', async () => {
  const updates = [];
  db.purchaseOrder = {
    findUnique: async () => ({ id: 'po1', poNumber: 'PO-1', status: 'CANCELLED', supplierId: 's1', goodsCost: 500000, totalCost: 500000 }),
    update: async ({ data }) => { updates.push(data); return { id: 'po1', ...data }; },
  };
  db.purchaseOrderItem = { findMany: async () => [], deleteMany: async () => { throw new Error('lines replaced'); } };
  const line = [{ productId: 'p2', packagingUnitId: 'u1', quantity: 7, unitCost: 33000 }];
  for (const change of [{ items: line }, { supplierId: 's2' }, { shippingCost: 1000 }, { orderedAt: '2026-11-01' }, { expectedArrival: '2026-12-01' }, { warehouseId: 'w2' }, { currency: 'USD' }]) {
    await assert.rejects(purchase.updatePurchaseOrder('po1', change), (e) => e.statusCode === 400 && /PO-1 is cancelled/.test(e.message), JSON.stringify(change));
  }
  assert.equal(updates.length, 0);
  await purchase.updatePurchaseOrder('po1', { notes: 'supplier closed' });
  assert.deepEqual(updates, [{ notes: 'supplier closed' }]);
});

test('removing a product held only by a cancelled order says to switch it off, not to take it off the order', async () => {
  const zero = { count: async () => 0 };
  Object.assign(db, {
    inventoryTransaction: zero, saleItem: zero, stockTransferItem: zero, returnItem: zero, stockCountItem: zero, settlementSubmission: zero,
    stockRequestItem: { findMany: async () => [] },
  });
  db.product = { findUnique: async () => ({ id: 'p1', name: 'Pepa', isActive: true }), delete: async () => { throw new Error('deleted'); } };
  db.purchaseOrderItem = { findMany: async () => [{ purchaseOrder: { poNumber: 'PO-9', status: 'CANCELLED' } }] };
  await assert.rejects(products.deleteProduct('p1'), (e) => e.statusCode === 400 && /cancelled purchase order PO-9/.test(e.message) && /Switch the product off/.test(e.message) && !/Take it off/.test(e.message));
  db.purchaseOrderItem = { findMany: async () => [{ purchaseOrder: { poNumber: 'PO-8', status: 'DRAFT' } }, { purchaseOrder: { poNumber: 'PO-9', status: 'CANCELLED' } }] };
  await assert.rejects(products.deleteProduct('p1'), (e) => /purchase order PO-8, so it cannot be removed\. Take it off that first/.test(e.message));
});

// ── purc05: opening stock ────────────────────────────────────────────────────────────────────────────
test('opening stock is admin only, STOCK_IN only, with a reason', () => {
  const router = require('../src/routes/inventory.routes');
  const { requireAdmin } = require('../src/middleware/authorize');
  const route = router.stack.find((l) => l.route && l.route.path === '/stock-in').route;
  assert.ok(route.stack.some((l) => l.handle === requireAdmin), 'requireAdmin guards it');
  const { stockIn } = require('../src/validators/inventory.validator');
  const body = { warehouseId: 'ckwarehouse00000000000001', items: [{ productId: 'ckproduct000000000000001', packagingUnitId: 'ckunit000000000000000001', quantity: 1 }], clientKey: 'key-12345678' };
  const bad = stockIn.body.safeParse({ ...body, type: 'PURCHASE_RECEIPT', notes: 'cargo' });
  assert.equal(bad.success, false);
  assert.match(bad.error.issues[0].message, /receiving its purchase order/);
  assert.equal(stockIn.body.safeParse({ ...body, notes: '   ' }).success, false, 'a reason is needed');
  assert.equal(stockIn.body.safeParse({ ...body }).success, false, 'a reason is needed');
  assert.equal(stockIn.body.safeParse({ ...body, notes: 'Opening stock' }).success, true);
});

// asyncHandler does not hand back its promise, so the call is awaited until it answers or fails.
const call = (handler, body) => new Promise((resolve) => {
  const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code || 200, body: b }); } };
  handler({ body, user: { id: 'admin' }, headers: {}, ip: '::1' }, res, (err) => resolve({ error: err }));
});

test('opening stock: one entry per press, never for a switched-off product, always STOCK_IN', async () => {
  const ctrl = require('../src/controllers/inventory.controller');
  const written = [];
  const locks = [];
  db.$executeRaw = async (_strings, ...values) => { locks.push(values[0]); };
  db.warehouse = { findUnique: async () => ({ id: 'w1' }) };
  let done = null;
  db.inventoryTransaction = { findFirst: async ({ where }) => { assert.deepEqual(where, { referenceType: 'MANUAL', referenceId: 'key-12345678' }); return done; } };
  const pepa = { id: 'p1', name: 'Pepa', isActive: true, purchasePrice: 1000 };
  db.product = { findMany: async () => [pepa] };
  inventory.convertToBase = async () => ({ baseQuantity: 50 });
  inventory.increaseStock = async (_tx, e) => { written.push(e); return e; };
  const body = { warehouseId: 'w1', items: [{ productId: 'p1', packagingUnitId: 'u1', quantity: 1 }], notes: 'Opening stock', clientKey: 'key-12345678' };

  const { error: noKey } = await call(ctrl.stockIn, { ...body, clientKey: undefined });
  assert.equal(noKey.statusCode, 400);

  const ok = await call(ctrl.stockIn, body);
  assert.equal(ok.code, 201);
  assert.deepEqual(locks, ['stock-in:key-12345678'], 'two presses of one key wait for each other');
  assert.equal(written.length, 1);
  assert.equal(written[0].type, 'STOCK_IN');
  assert.equal(written[0].referenceType, 'MANUAL');
  assert.equal(written[0].referenceId, 'key-12345678');
  assert.equal(written[0].notes, 'Opening stock');

  done = { id: 'row1' }; // the same press again (a retry after a lost answer)
  const { error: again } = await call(ctrl.stockIn, body);
  assert.equal(again.statusCode, 409);
  assert.equal(written.length, 1, 'nothing added twice');

  done = null;
  pepa.isActive = false;
  const { error: off } = await call(ctrl.stockIn, body);
  assert.equal(off.statusCode, 400);
  assert.match(off.message, /Pepa is switched off/);
  assert.equal(written.length, 1);
  delete db.$executeRaw;
});

// ── purc08: switched-off supplier or product ─────────────────────────────────────────────────────────
test('a new order for a switched-off supplier or product is refused before anything is written', async () => {
  let created = 0;
  db.purchaseOrder = { create: async () => { created += 1; return { id: 'po1' }; }, findUnique: async () => ({ id: 'po1' }), findFirst: async () => null };
  inventory.convertToBase = async (_c, _p, _u, quantity) => ({ baseQuantity: quantity });
  const order = { supplierId: 's1', items: [{ productId: 'p1', packagingUnitId: 'u1', quantity: 1, unitCost: 1000 }] };

  db.supplier = { findUnique: async () => ({ name: 'Bonge', isActive: false }) };
  db.product = { findMany: async () => [] };
  await assert.rejects(purchase.createPurchaseOrder(order), (e) => e.statusCode === 400 && /Bonge is switched off/.test(e.message));

  db.supplier = { findUnique: async () => ({ name: 'OHIS yiwu', isActive: true }) };
  db.product = { findMany: async ({ where }) => (where.isActive === false ? [{ name: 'Old Pepa' }] : []) };
  await assert.rejects(purchase.createPurchaseOrder(order), (e) => e.statusCode === 400 && /Old Pepa is switched off/.test(e.message));
  assert.equal(created, 0);
});

test('editing a draft: a switched-off supplier or a newly added switched-off product is refused; one already on it may stay', async () => {
  const stored = { id: 'po1', poNumber: 'PO-1', status: 'DRAFT', supplierId: 's1', goodsCost: 1000, totalCost: 1000, shippingCost: 0, clearingCost: 0, otherCost: 0 };
  db.purchaseOrder = { findUnique: async () => stored, update: async ({ data }) => ({ ...stored, ...data }) };
  db.financeTransaction = { aggregate: async () => ({ _sum: { amount: 0 } }) };
  db.purchaseOrderItem = { findMany: async () => [{ productId: 'old' }], deleteMany: async () => {} };
  db.supplier = { findUnique: async ({ where }) => ({ name: where.id === 'off' ? 'Bonge' : 'OHIS yiwu', isActive: where.id !== 'off' }) };
  db.product = { findMany: async ({ where }) => (where.id.in.includes('old') ? [{ name: 'Old Pepa' }] : []) };
  await assert.rejects(purchase.updatePurchaseOrder('po1', { supplierId: 'off' }), /Bonge is switched off/);
  // 'old' is already on the order, so it is not checked; a new active product passes.
  const line = (productId) => ({ productId, packagingUnitId: 'u1', quantity: 1, unitCost: 1000 });
  await purchase.updatePurchaseOrder('po1', { items: [line('old'), line('new')] });
  db.purchaseOrderItem.findMany = async () => [];
  await assert.rejects(purchase.updatePurchaseOrder('po1', { items: [line('old')] }), /Old Pepa is switched off/);
});

// ── purc09: price history ────────────────────────────────────────────────────────────────────────────
test('price history: drafts and cancelled orders never, with or without dates; old orders by the day they were made', async () => {
  const seen = [];
  db.purchaseOrderItem = { findMany: async ({ where }) => { seen.push(where.purchaseOrder); return []; } };
  await purchase.listPurchaseLines({ productId: 'p1' });
  await purchase.listPurchaseLines({ productId: 'p1', from: '2026-11-01', to: '2026-11-15' });
  for (const w of seen) assert.deepEqual(w.status, { notIn: ['DRAFT', 'CANCELLED'] });
  assert.equal(seen[0].OR, undefined);
  const [bought, older] = seen[1].OR;
  assert.ok(bought.purchasedAt.gte instanceof Date && bought.purchasedAt.lte instanceof Date);
  assert.equal(older.purchasedAt, null);
  assert.deepEqual(older.createdAt, bought.purchasedAt);
});

// ── purc10: a product edit and the average cost ──────────────────────────────────────────────────────
test('a product edit refuses a buying price when the stored one moved since the form was opened', async () => {
  const writes = [];
  db.product = {
    findUnique: async () => ({ id: 'p1', name: 'Pepa', isActive: true, purchasePrice: '22707.91' }),
    update: async ({ data }) => { writes.push(data); return data; },
  };
  // The form loaded 22,508.79; a receipt since then made it 22,707.91.
  await assert.rejects(products.updateProduct('p1', { purchasePrice: 23000, expectedPurchasePrice: 22508.79, minStockLevel: 5 }),
    (e) => e.statusCode === 409 && /buying price of Pepa is now/.test(e.message));
  assert.equal(writes.length, 0);
  // The form changed something else only: the price is not sent, so the average cost stays.
  await products.updateProduct('p1', { minStockLevel: 5 });
  assert.deepEqual(writes.pop(), { minStockLevel: 5 });
  // A real change on an up-to-date form goes through (and the expected price is not a column).
  await products.updateProduct('p1', { purchasePrice: 23000, expectedPurchasePrice: 22707.91 });
  assert.deepEqual(writes.pop(), { purchasePrice: 23000 });
});
