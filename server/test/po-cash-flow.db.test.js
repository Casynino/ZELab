'use strict';

// ── Cash-only purchasing, against a REAL database ──────────────────────────────
// Confirm purchase, Add cost, Check in and Confirm arrival lock rows with raw SQL (SELECT … FOR UPDATE) and
// read balances inside their transaction. Stubs cannot prove that (11 Nov 2026: a stubbed lock hid a bug that
// broke every stock movement), so this runs only against a throwaway copy of the data:
//
//   PO_TEST_DATABASE_URL=postgresql://localhost/zelab_po node --test test/po-cash-flow.db.test.js
//
// Never point it at production: it writes orders, payments and stock.

const test = require('node:test');
const assert = require('node:assert');

const url = process.env.PO_TEST_DATABASE_URL;
if (!url) {
  test('cash-only purchasing (real database)', { skip: 'set PO_TEST_DATABASE_URL to a throwaway database' }, () => {});
  return;
}
process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;

const prisma = require('../src/config/prisma');
const purchase = require('../src/services/purchase.service');
const finance = require('../src/services/finance.service');
const inventory = require('../src/services/inventory.service');

const ctx = {};
const stockOf = (productId) => inventory.getBalance(prisma, { productId, type: inventory.LOCATION.WAREHOUSE, warehouseId: ctx.warehouseId });
const balanceOf = async () => (await finance.accountBalances({ accountId: ctx.accountId }))[0].balance;
const moneyOn = (poId) => prisma.financeTransaction.findMany({ where: { refType: 'PurchaseOrder', refId: poId } });
const rejectsWith = (p, code, re) => assert.rejects(p, (e) => e.statusCode === code && (!re || re.test(e.message)));

test.before(async () => {
  const boxUnit = await prisma.packagingUnit.findFirst({ where: { shortCode: 'BX' } });
  const products = await prisma.product.findMany({
    where: { isActive: true, packagings: { some: { packagingUnit: { shortCode: 'CT' }, isActive: true } } },
    take: 2,
    orderBy: { name: 'asc' },
  });
  assert.equal(products.length, 2, 'needs two products with a carton size');
  ctx.a = products[0];
  ctx.b = products[1];
  ctx.boxUnitId = boxUnit.id;
  ctx.admin = await prisma.user.findFirst({ where: { role: { name: 'ADMIN' } } });
  ctx.warehouseId = (await prisma.warehouse.findFirst({ where: { isActive: true }, orderBy: { isPrimary: 'desc' } })).id;
  ctx.supplier = await prisma.supplier.create({ data: { name: `PO test supplier ${Date.now()}`, country: 'China' } });
  // Its own account, starting with 1,000,000 — too little for the order, on purpose.
  ctx.accountId = (await prisma.businessAccount.create({ data: { name: `PO test cash ${Date.now()}`, type: 'CASH', openingBalance: 1_000_000 } })).id;
});

test.after(async () => { await prisma.$disconnect(); });

const draft = () => purchase.createPurchaseOrder({
  supplierId: ctx.supplier.id,
  orderedAt: '2026-11-15',
  items: [
    { productId: ctx.a.id, packagingUnitId: ctx.boxUnitId, quantity: 100, unitCost: 10_000 }, // 1,000,000
    { productId: ctx.b.id, packagingUnitId: ctx.boxUnitId, quantity: 50, unitCost: 12_000 }, //   600,000
  ],
}, ctx.admin);

test('the whole journey: draft → purchase → dispatch → cost → received in two parts', async () => {
  const po = await draft();
  assert.equal(po.status, 'DRAFT');
  assert.equal(Number(po.totalCost), 1_600_000);
  assert.equal((await moneyOn(po.id)).length, 0, 'a draft moves no money');
  assert.equal((await finance.supplierDetail(ctx.supplier.id)).totals.outstanding, 0, 'a draft is owed to nobody');

  // Not enough in the account: refused with the numbers, nothing written.
  await rejectsWith(purchase.confirmPurchase(po.id, { accountId: ctx.accountId }, ctx.admin), 400, /missing/);
  assert.equal((await prisma.purchaseOrder.findUnique({ where: { id: po.id } })).status, 'DRAFT');
  assert.equal((await moneyOn(po.id)).length, 0);

  await prisma.businessAccount.update({ where: { id: ctx.accountId }, data: { openingBalance: 5_000_000 } });
  const before = await balanceOf();
  // Two presses at once: paid exactly once.
  const both = await Promise.allSettled([
    purchase.confirmPurchase(po.id, { accountId: ctx.accountId, occurredAt: '2026-11-15' }, ctx.admin),
    purchase.confirmPurchase(po.id, { accountId: ctx.accountId, occurredAt: '2026-11-15' }, ctx.admin),
  ]);
  assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(both.find((r) => r.status === 'rejected').reason.statusCode, 409);
  const paid = await moneyOn(po.id);
  assert.equal(paid.length, 1);
  assert.equal(Number(paid[0].amount), 1_600_000);
  assert.equal(paid[0].type, 'STOCK_PURCHASE');
  assert.equal(await balanceOf(), before - 1_600_000);
  assert.equal((await finance.supplierDetail(ctx.supplier.id)).totals.outstanding, 0, 'paid in cash: nothing owed');

  // Locked once bought.
  await rejectsWith(purchase.updatePurchaseOrder(po.id, { items: [{ productId: ctx.a.id, packagingUnitId: ctx.boxUnitId, quantity: 1, unitCost: 1 }] }), 400, /locked/);
  await rejectsWith(purchase.deletePurchaseOrder(po.id), 400);
  await purchase.updatePurchaseOrder(po.id, { notes: 'still editable' });

  // Not on its way yet: nothing can be received.
  const [ia, ib] = (await prisma.purchaseOrderItem.findMany({ where: { purchaseOrderId: po.id }, orderBy: { baseQuantity: 'desc' } }));
  await rejectsWith(purchase.receiveCargo(po.id, { clientKey: `early-${po.id}`, items: [{ itemId: ia.id, received: 1 }] }, ctx.admin), 400, /not been dispatched/);

  const sent = await purchase.dispatchOrder(po.id, { dispatchedAt: '2026-11-16', expectedArrival: '2026-12-20' });
  assert.equal(sent.status, 'IN_TRANSIT');

  // Shipping paid in cash as it is recorded: the order stays fully paid.
  const withShip = await purchase.addOrderCost(po.id, { kind: 'shipping', amount: 160_000, accountId: ctx.accountId }, ctx.admin);
  assert.equal(Number(withShip.totalCost), 1_760_000);
  assert.equal((await moneyOn(po.id)).length, 2);
  assert.equal((await finance.supplierDetail(ctx.supplier.id)).totals.outstanding, 0);

  const stockA = await stockOf(ctx.a.id);
  const stockB = await stockOf(ctx.b.id);
  const key = (n) => `test-${po.id}-${n}`;

  // Refused: more than bought, more damaged than received, damaged with no reason, nothing entered.
  await rejectsWith(purchase.receiveCargo(po.id, { clientKey: key('x1'), items: [{ itemId: ia.id, received: 101 }] }, ctx.admin), 400, /still to come/);
  await rejectsWith(purchase.receiveCargo(po.id, { clientKey: key('x2'), items: [{ itemId: ia.id, received: 2, damaged: 5, note: 'x' }] }, ctx.admin), 400, /damaged/);
  await rejectsWith(purchase.receiveCargo(po.id, { clientKey: key('x3'), items: [{ itemId: ia.id, received: 2, damaged: 1 }] }, ctx.admin), 400, /what is wrong/);
  await rejectsWith(purchase.receiveCargo(po.id, { clientKey: key('x4'), items: [{ itemId: ia.id }] }, ctx.admin), 400, /at least one/);
  assert.equal(await stockOf(ctx.a.id), stockA, 'refusals add nothing');

  // First part: 50 of A arrive, 2 damaged. The same press twice at once: stock comes in once.
  const first = { clientKey: key(1), items: [{ itemId: ia.id, received: 50, damaged: 2, note: 'Two boxes wet' }] };
  const two = await Promise.allSettled([
    purchase.receiveCargo(po.id, first, ctx.admin),
    purchase.receiveCargo(po.id, first, ctx.admin),
  ]);
  assert.equal(two.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(two.find((r) => r.status === 'rejected').reason.statusCode, 409);
  assert.equal(await stockOf(ctx.a.id), stockA + 48, 'accepted only: damaged never becomes stock');
  assert.equal(await stockOf(ctx.b.id), stockB);
  let now = await purchase.getPurchaseOrder(po.id);
  assert.equal(now.status, 'PARTLY_RECEIVED');
  const lineA = now.items.find((i) => i.id === ia.id);
  assert.equal(lineA.receivedBase, 50);
  assert.equal(lineA.damagedBase, 2);
  assert.equal(Number(lineA.unitCost), 10_000, 'the buying price never changes');
  // Landed: 160,000 shipping over 1,600,000 goods = 10% → 11,000 a box.
  assert.equal(Number(lineA.landedUnitCost), 11_000);
  assert.equal(now.receipts.length, 1);
  assert.equal(now.receipts[0].items[0].note, 'Two boxes wet');
  const moved = await prisma.inventoryTransaction.findMany({ where: { referenceType: 'PURCHASE', referenceId: po.id } });
  assert.equal(moved.length, 1);
  assert.equal(moved[0].baseQuantity, 48);
  assert.equal(Number(moved[0].unitCost), 11_000);

  // Second part, another day: the rest of A arrives except 10 that will never come; B arrives in full.
  now = (await purchase.receiveCargo(po.id, {
    clientKey: key(2), arrivedAt: '2026-12-21',
    items: [{ itemId: ia.id, received: 40, missing: 10 }, { itemId: ib.id, received: 50 }],
  }, ctx.admin)).order;
  assert.equal(now.status, 'RECEIVED', 'every box is received or missing: complete');
  assert.ok(now.receivedAt);
  assert.equal(await stockOf(ctx.a.id), stockA + 88);
  assert.equal(await stockOf(ctx.b.id), stockB + 50);
  const doneA = now.items.find((i) => i.id === ia.id);
  assert.deepEqual([doneA.receivedBase, doneA.damagedBase, doneA.missingBase], [90, 2, 10]);
  // Finished orders cannot be received or costed again.
  await rejectsWith(purchase.receiveCargo(po.id, { clientKey: key(3), items: [{ itemId: ib.id, received: 1 }] }, ctx.admin), 400);
  await rejectsWith(purchase.addOrderCost(po.id, { kind: 'other', amount: 1000, accountId: ctx.accountId }, ctx.admin), 400);

  // History by product: each order line keeps its own price.
  const lines = await purchase.listPurchaseLines({ productId: ctx.a.id });
  const mine = lines.find((l) => l.poId === po.id);
  assert.deepEqual([mine.unitCost, mine.accepted, mine.missing, mine.outstanding], [10_000, 88, 10, 0]);
});

test('the same product at a different price on another order, cartons, and nothing more coming', async () => {
  const carton = await prisma.productPackaging.findFirst({ where: { productId: ctx.a.id, packagingUnit: { shortCode: 'CT' } } });
  const po = await purchase.createPurchaseOrder({
    supplierId: ctx.supplier.id,
    items: [{ productId: ctx.a.id, packagingUnitId: carton.packagingUnitId, quantity: 10, unitCost: 440 }], // 22,000 a carton
  }, ctx.admin);
  assert.equal(Number(po.totalCost), 10 * carton.baseQuantity * 440);
  await purchase.confirmPurchase(po.id, { accountId: ctx.accountId }, ctx.admin);
  await purchase.dispatchOrder(po.id, {});
  const [line] = await prisma.purchaseOrderItem.findMany({ where: { purchaseOrderId: po.id } });
  const stockA = await stockOf(ctx.a.id);
  // 4 cartons arrive fine: they enter stock as boxes; 6 cartons stay outstanding.
  let r = await purchase.receiveCargo(po.id, { clientKey: `c-${po.id}-1`, items: [{ itemId: line.id, received: 4 }] }, ctx.admin);
  assert.equal(r.order.status, 'PARTLY_RECEIVED');
  assert.equal(await stockOf(ctx.a.id), stockA + 4 * carton.baseQuantity);
  // Nothing more is coming: the 6 left are recorded missing and the order is complete.
  r = await purchase.receiveCargo(po.id, { clientKey: `c-${po.id}-2`, items: [{ itemId: line.id, missing: 6 }] }, ctx.admin);
  assert.equal(r.order.status, 'RECEIVED');
  assert.equal(await stockOf(ctx.a.id), stockA + 4 * carton.baseQuantity, 'missing adds nothing');
  const prices = (await purchase.listPurchaseLines({ productId: ctx.a.id })).map((l) => l.unitCost);
  assert.ok(prices.includes(10_000) && prices.includes(440), 'both prices are kept, each on its own order');
});

test('a dispatched order cannot be cancelled; a draft can be deleted', async () => {
  const po = await draft();
  await purchase.confirmPurchase(po.id, { accountId: ctx.accountId }, ctx.admin);
  // Bought: cancelling is refused while the payment stands (it is reversed in Finance first).
  await rejectsWith(purchase.updatePurchaseOrder(po.id, { status: 'CANCELLED' }), 400, /paid/);
  await purchase.dispatchOrder(po.id, {});
  await rejectsWith(purchase.updatePurchaseOrder(po.id, { status: 'CANCELLED' }), 400, /dispatched/);
  await rejectsWith(purchase.updatePurchaseOrder(po.id, { status: 'DRAFT' }), 400, /buttons/); // no walking it back

  const d = await draft();
  await purchase.deletePurchaseOrder(d.id);
  assert.equal(await prisma.purchaseOrder.findUnique({ where: { id: d.id } }), null);
});

test('an older credit order already paid through the supplier balance is not paid again', async () => {
  // Before 15 Nov 2026 an order with a date was ORDERED (owed), and could be paid with Pay supplier balance.
  const po = await draft();
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'ORDERED' } });
  const owed = (await finance.supplierDetail(ctx.supplier.id)).totals.outstanding;
  assert.equal(owed, 1_600_000);
  await finance.paySupplierBalance(ctx.supplier.id, { accountId: ctx.accountId, amount: owed }, ctx.admin);
  const before = await balanceOf();
  assert.equal((await purchase.getPurchaseOrder(po.id)).toPay, 0, 'the window offers nothing to pay');
  const done = await purchase.confirmPurchase(po.id, {}, ctx.admin); // no account needed: nothing left to pay
  assert.equal(done.status, 'PURCHASED');
  assert.equal(await balanceOf(), before, 'no second payment');
  assert.equal((await moneyOn(po.id)).length, 0);
  assert.equal((await finance.supplierDetail(ctx.supplier.id)).totals.outstanding, 0, 'supplier not overpaid');
});

test('an account reserved for one brand cannot pay for another brand, even in a mixed order', async () => {
  const brands = await prisma.brand.findMany({ take: 2, orderBy: { name: 'asc' } });
  const [p1, p2] = await Promise.all(brands.map((b) => prisma.product.findFirst({ where: { brandId: b.id, isActive: true, packagings: { some: { isBaseUnit: true } } } })));
  assert.ok(p1 && p2, 'needs a product of each brand');
  await prisma.businessAccount.update({ where: { id: ctx.accountId }, data: { openingBalance: 50_000_000 } });
  const reserved = await prisma.businessAccount.create({ data: { name: `PO test reserved ${Date.now()}`, type: 'CASH', openingBalance: 50_000_000, brandId: brands[0].id } });
  const po = await purchase.createPurchaseOrder({
    supplierId: ctx.supplier.id,
    items: [
      { productId: p1.id, packagingUnitId: ctx.boxUnitId, quantity: 10, unitCost: 1000 },
      { productId: p2.id, packagingUnitId: ctx.boxUnitId, quantity: 10, unitCost: 1000 },
    ],
  }, ctx.admin);
  await rejectsWith(purchase.confirmPurchase(po.id, { accountId: reserved.id }, ctx.admin), 400, /only pays for its own brand/);
  assert.equal((await moneyOn(po.id)).length, 0);
  // A shared account pays it.
  assert.equal((await purchase.confirmPurchase(po.id, { accountId: ctx.accountId }, ctx.admin)).status, 'PURCHASED');
});

test('a carton price that does not divide evenly still adds up to exactly what was typed', async () => {
  // 100,000 a carton of 24 boxes, 10 cartons: the cost per box is kept to six places.
  const po = await purchase.createPurchaseOrder({
    supplierId: ctx.supplier.id,
    items: [{ productId: ctx.a.id, packagingUnitId: ctx.boxUnitId, quantity: 240, unitCost: Math.round((100_000 / 24) * 1e6) / 1e6 }],
  }, ctx.admin);
  assert.equal(Number(po.totalCost), 1_000_000);
});

test('one-step Receive is refused for new orders', async () => {
  const po = await draft();
  await rejectsWith(purchase.receivePurchaseOrder(po.id, ctx.admin, {}), 400, /Confirm the purchase/);
});
