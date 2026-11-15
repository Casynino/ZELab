'use strict';

// ── Purchases and stock audit fixes (15 Nov 2026), against a REAL database ─────────────────────────
// The queries and locks these fixes added (the ledger lock of the cache rebuild, the on-the-way lines of Reorder,
// the price-history date filter) only prove themselves on Postgres, so this runs only against a throwaway copy:
//
//   PO_TEST_DATABASE_URL=postgresql://localhost/zelab_po node --test test/purchases-stock-audit.db.test.js
//
// Never point it at production: it writes orders, payments and stock.

const test = require('node:test');
const assert = require('node:assert');

const url = process.env.PO_TEST_DATABASE_URL;
if (!url) {
  test('purchases and stock audit fixes (real database)', { skip: 'set PO_TEST_DATABASE_URL to a throwaway database' }, () => {});
  return;
}
process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;

const prisma = require('../src/config/prisma');
const purchase = require('../src/services/purchase.service');
const reorder = require('../src/services/reorder.service');
const inventory = require('../src/services/inventory.service');

const ctx = {};
const rejectsWith = (p, code, re) => assert.rejects(p, (e) => e.statusCode === code && (!re || re.test(e.message)));

test.before(async () => {
  const boxUnit = await prisma.packagingUnit.findFirst({ where: { shortCode: 'BX' } });
  ctx.boxUnitId = boxUnit.id;
  // From the end of the list: po-cash-flow.db.test.js takes the first two, and the two files may run side by side.
  ctx.product = await prisma.product.findFirst({ where: { isActive: true, packagings: { some: { packagingUnitId: boxUnit.id, isActive: true } } }, orderBy: { name: 'desc' } });
  assert.ok(ctx.product, 'needs an active product sold by the box');
  ctx.admin = await prisma.user.findFirst({ where: { role: { name: 'ADMIN' } } });
  ctx.supplier = await prisma.supplier.create({ data: { name: `Audit fix supplier ${Date.now()}`, country: 'China' } });
  ctx.accountId = (await prisma.businessAccount.create({ data: { name: `Audit fix cash ${Date.now()}`, type: 'CASH', openingBalance: 50_000_000 } })).id;
});

test.after(async () => { await prisma.$disconnect(); });

const order = (quantity = 10) => purchase.createPurchaseOrder({
  supplierId: ctx.supplier.id,
  items: [{ productId: ctx.product.id, packagingUnitId: ctx.boxUnitId, quantity, unitCost: 1000 }],
}, ctx.admin);
const comingOf = async () => (await reorder.reorderAnalysis()).items.find((i) => i.productId === ctx.product.id).onTheWay;

test('reorder counts a bought order as on the way, not a draft; missing boxes never come', async () => {
  const before = await comingOf();
  const po = await order(37);
  assert.equal(await comingOf(), before, 'a draft is not bought');
  await purchase.confirmPurchase(po.id, { accountId: ctx.accountId }, ctx.admin);
  assert.equal(await comingOf(), before + 37);
  const [line] = await prisma.purchaseOrderItem.findMany({ where: { purchaseOrderId: po.id } });
  await purchase.receiveCargo(po.id, { clientKey: `audit-fix-${po.id}`, items: [{ itemId: line.id, received: 30, missing: 2 }] }, ctx.admin);
  assert.equal(await comingOf(), before + 5, '37 bought, 30 in, 2 never coming');
  const list = await purchase.listPurchaseOrders({}, { skip: 0, take: 1, orderBy: { createdAt: 'desc' } });
  assert.equal(list.onTheWay.orders_.find((o) => o.id === po.id).boxes, 5, 'the Purchases page agrees');
});

test('a cancelled order is frozen; price history shows bought lines only, with or without dates', async () => {
  const po = await order(3);
  await purchase.confirmPurchase(po.id, { accountId: ctx.accountId }, ctx.admin);
  await purchase.undoPurchase(po.id, { reason: 'audit fix test' }, ctx.admin);
  await purchase.updatePurchaseOrder(po.id, { status: 'CANCELLED' });
  await rejectsWith(purchase.updatePurchaseOrder(po.id, { items: [{ productId: ctx.product.id, packagingUnitId: ctx.boxUnitId, quantity: 350, unitCost: 33_000 }] }), 400, /is cancelled/);
  await rejectsWith(purchase.updatePurchaseOrder(po.id, { shippingCost: 5000 }), 400, /is cancelled/);
  const kept = await prisma.purchaseOrder.findUnique({ where: { id: po.id }, include: { items: true } });
  assert.equal(Number(kept.totalCost), 3000);
  assert.equal(kept.items[0].baseQuantity, 3);
  assert.equal((await purchase.updatePurchaseOrder(po.id, { notes: 'kept as the record' })).notes, 'kept as the record');

  const draft = await order(4);
  const today = new Date().toISOString().slice(0, 10);
  for (const range of [{}, { from: today, to: today }]) {
    const lines = await purchase.listPurchaseLines({ productId: ctx.product.id, ...range });
    assert.ok(!lines.some((l) => l.poId === draft.id), 'a draft is not a price paid');
    assert.ok(!lines.some((l) => l.poId === po.id), 'nor a cancelled order');
    assert.ok(lines.every((l) => !['DRAFT', 'CANCELLED'].includes(l.status)));
  }
  // An order bought before Confirm purchase (no purchase date) is still found by the day it was made.
  const older = await order(2);
  await prisma.purchaseOrder.update({ where: { id: older.id }, data: { status: 'RECEIVED' } });
  const dated = await purchase.listPurchaseLines({ productId: ctx.product.id, from: today, to: today });
  assert.ok(dated.some((l) => l.poId === older.id));
  await prisma.purchaseOrder.update({ where: { id: older.id }, data: { status: 'CANCELLED' } });
});

test('a switched-off supplier or product gets no new order and no payment', async () => {
  const po = await order(5); // made while both are on
  await prisma.supplier.update({ where: { id: ctx.supplier.id }, data: { isActive: false } });
  try {
    await rejectsWith(order(1), 400, /switched off/);
    await rejectsWith(purchase.confirmPurchase(po.id, { accountId: ctx.accountId }, ctx.admin), 400, /switched off/);
    assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: po.id } })).status, 'DRAFT', 'nothing paid');
    assert.equal(await prisma.financeTransaction.count({ where: { refType: 'PurchaseOrder', refId: po.id } }), 0);
  } finally {
    await prisma.supplier.update({ where: { id: ctx.supplier.id }, data: { isActive: true } });
  }
  await prisma.product.update({ where: { id: ctx.product.id }, data: { isActive: false } });
  try {
    await rejectsWith(order(1), 400, /switched off/);
    await rejectsWith(purchase.confirmPurchase(po.id, { accountId: ctx.accountId }, ctx.admin), 400, /switched off/);
  } finally {
    await prisma.product.update({ where: { id: ctx.product.id }, data: { isActive: true } });
  }
  await purchase.deletePurchaseOrder(po.id);
});

test('the cache rebuild takes the ledger lock and leaves every cache equal to the ledger', async () => {
  const out = await inventory.recomputeAllCaches(prisma);
  assert.ok(out.warehouseRows > 0);
  const [wh, cache] = await Promise.all([inventory.warehouseBalances(prisma), prisma.warehouseStock.findMany()]);
  const cached = new Map(cache.map((c) => [`${c.productId}:${c.warehouseId}`, c.baseQuantity]));
  for (const r of wh) assert.equal(cached.get(`${r.productId}:${r.warehouseId}`), r.baseQuantity);
  // A stock movement started at the same moment waits for the rebuild and still counts in the cache afterwards.
  const wid = (await prisma.warehouse.findFirst({ where: { isActive: true }, orderBy: { isPrimary: 'desc' } })).id;
  const before = (await prisma.warehouseStock.findUnique({ where: { productId_warehouseId: { productId: ctx.product.id, warehouseId: wid } } }))?.baseQuantity || 0;
  await Promise.all([
    inventory.recomputeAllCaches(prisma),
    prisma.$transaction((tx) => inventory.increaseStock(tx, {
      productId: ctx.product.id, packagingUnitId: ctx.boxUnitId, quantity: 1, baseQuantity: 1, type: 'ADJUSTMENT',
      location: { type: 'WAREHOUSE', warehouseId: wid }, referenceType: 'ADJUSTMENT', notes: 'audit fix test: race with the cache rebuild',
    })),
  ]);
  const after = (await prisma.warehouseStock.findUnique({ where: { productId_warehouseId: { productId: ctx.product.id, warehouseId: wid } } })).baseQuantity;
  assert.equal(after, before + 1);
  assert.equal(after, await inventory.getBalance(prisma, { productId: ctx.product.id, type: 'WAREHOUSE', warehouseId: wid }));
  // Put the box back the way the ledger does: a new row, never a deleted one.
  await prisma.$transaction((tx) => inventory.decreaseStock(tx, {
    productId: ctx.product.id, packagingUnitId: ctx.boxUnitId, quantity: 1, baseQuantity: 1, type: 'ADJUSTMENT',
    location: { type: 'WAREHOUSE', warehouseId: wid }, referenceType: 'ADJUSTMENT', notes: 'audit fix test: undo',
  }));
});
