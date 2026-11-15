'use strict';

// ── The rep flow, against a REAL database (audit 15 Nov 2026, batch "reps") ──────────────────────────────
// Locks, keyed ids racing on the primary key, the fine sweep and the money booked on approval only prove
// themselves on Postgres, so this runs only against a throwaway copy of the data:
//
//   REPS_TEST_DATABASE_URL=postgresql://localhost/zelab_fix_reps node --test test/rep-flow.db.test.js
//
// Never point it at production: it creates a test rep, orders, settlements, returns, fines and sales, and
// it runs the late-fine sweep over every overdue order in that database.

const test = require('node:test');
const assert = require('node:assert');

const url = process.env.REPS_TEST_DATABASE_URL;
if (!url) {
  test('rep flow (real database)', { skip: 'set REPS_TEST_DATABASE_URL to a throwaway database' }, () => {});
  return;
}
process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only';

// Nothing leaves this computer: WhatsApp (CallMeBot) and anything else outside is answered here.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const href = typeof input === 'string' ? input : input?.url || String(input);
  let host = '';
  try { host = new URL(href).hostname; } catch { /* relative */ }
  if (host === 'localhost' || host === '127.0.0.1') return realFetch(input, init);
  return new Response('captured by test, not sent', { status: 200 });
};

const prisma = require('../src/config/prisma');
const settlement = require('../src/services/settlement.service');
const submission = require('../src/services/settlementSubmission.service');
const returns = require('../src/services/returns.service');
const stockRequest = require('../src/services/stockRequest.service');
const penalty = require('../src/services/penalty.service');
const commission = require('../src/services/commission.service');

const ctx = {};
const HOUR = 3_600_000;
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const byName = (name) => prisma.product.findFirst({ where: { name, isActive: true }, include: { brand: true } });
const boxUnitOf = async (productId) => (await prisma.productPackaging.findFirst({ where: { productId, isBaseUnit: true } })).packagingUnitId;
const issue = (product, boxes) => settlement.addStockToRep(ctx.rep.id, { productId: product.id, boxes, warehouseId: ctx.warehouseId }, ctx.admin);
const accountFor = async (product) => {
  const finance = require('../src/services/finance.service');
  return (await finance.paymentAccountsForBrand(product.brandId || null))[0].id;
};
// Each test starts with no order of the test rep still open, so "Add stock" always opens a fresh one.
const closeOpenOrders = () => prisma.settlement.updateMany({ where: { salesRepId: ctx.rep.id, status: { not: 'SETTLED' } }, data: { deadlineAt: new Date(Date.now() - 1000), status: 'OVERDUE' } });

test.before(async () => {
  const stamp = Date.now();
  const adminUser = await prisma.user.findFirst({ where: { role: { name: 'ADMIN' }, isActive: true } });
  ctx.admin = { id: adminUser.id, name: adminUser.name, role: 'ADMIN' };
  ctx.warehouseId = (await prisma.warehouse.findFirst({ where: { isActive: true }, orderBy: { isPrimary: 'desc' } })).id;
  const role = await prisma.role.findFirst({ where: { name: 'SALES_REP' } });
  const user = await prisma.user.create({
    data: { name: `Test Rep ${stamp}`, email: `rep-flow-${stamp}@test.local`, passwordHash: 'not-a-login', roleId: role.id },
  });
  ctx.rep = await prisma.salesRepresentative.create({ data: { userId: user.id, code: `RT-${stamp}` } });
  ctx.repActor = { id: user.id, name: user.name, role: 'SALES_REP', salesRepId: ctx.rep.id };
  ctx.ohis = await byName('OHIS Ndogo (Brown) Na Filter');
  ctx.civ = await byName('Civlily Ndogo (Brown) Bila Filter');
  ctx.pepa = await byName('Pepa Ndogo (Brown) Bila Filter');
  assert.ok(ctx.ohis && ctx.civ && ctx.pepa, 'needs the OHIS, Civlily and Pepa products of the data copy');
});

test.after(async () => {
  await pause(500); // fire-and-forget notices finish before the pool closes
  await prisma.$disconnect();
});

test('ui-r00 / ui-r01: a double tap on Settle, Settle several, Request and Return saves ONE record each', async () => {
  await closeOpenOrders();
  const order = (await issue(ctx.ohis, 3)).settlement;
  await settlement.addStockToRep(ctx.rep.id, { productId: ctx.civ.id, boxes: 2, warehouseId: ctx.warehouseId }, ctx.admin);
  const ohisAcc = await accountFor(ctx.ohis);
  const civAcc = await accountFor(ctx.civ);

  // Settle one product: two presses in the same instant with the same window key.
  const one = { productId: ctx.ohis.id, boxes: 1, accountId: ohisAcc, clientKey: `one-${order.id}` };
  const [a, b] = await Promise.all([submission.submit(order.id, one, ctx.repActor), submission.submit(order.id, one, ctx.repActor)]);
  assert.equal(a.id, b.id, 'both answers are the same settlement');
  assert.equal([a, b].filter((x) => x.replayed).length, 1, 'the second is a replay');
  // A retry after a lost answer, later: the same one again.
  assert.equal((await submission.submit(order.id, one, ctx.repActor)).id, a.id);
  assert.equal(await prisma.settlementSubmission.count({ where: { settlementId: order.id } }), 1);

  // Settle several products.
  const many = { clientKey: `many-${order.id}`, items: [{ productId: ctx.ohis.id, boxes: 1, accountId: ohisAcc }, { productId: ctx.civ.id, boxes: 1, accountId: civAcc }] };
  const [m1, m2] = await Promise.all([submission.submitMany(order.id, many, ctx.repActor), submission.submitMany(order.id, many, ctx.repActor)]);
  assert.deepEqual(m1.map((x) => x.id), m2.map((x) => x.id));
  assert.equal(await prisma.settlementSubmission.count({ where: { settlementId: order.id } }), 3, '1 + 2 lines, not 1 + 4');

  // A press from another window is a new submission, checked as usual: 2 of the 3 boxes are already waiting.
  const other = await submission.submit(order.id, { ...one, boxes: 2, clientKey: 'a-different-window' }, ctx.repActor).catch((e) => e);
  assert.match(String(other.message), /Only 1 box of .* can still be submitted/);

  // Request stock.
  const unit = await boxUnitOf(ctx.ohis.id);
  const req = { clientKey: `req-${order.id}`, notes: 'rep-flow test', items: [{ productId: ctx.ohis.id, packagingUnitId: unit, quantity: 1 }] };
  const [r1, r2] = await Promise.all([stockRequest.create(ctx.rep.id, req), stockRequest.create(ctx.rep.id, req)]);
  assert.equal(r1.id, r2.id);
  assert.equal(await prisma.stockRequest.count({ where: { salesRepId: ctx.rep.id, notes: 'rep-flow test' } }), 1);
  assert.equal((await stockRequest.create(ctx.rep.id, req)).id, r1.id, 'a retry later finds it too');

  // Return boxes (the order's own window, so under the order's lock) and from the Returns page (no order given).
  const civUnit = await boxUnitOf(ctx.civ.id);
  const ret = { clientKey: `ret-${order.id}`, type: 'SALES_RETURN', salesRepId: ctx.rep.id, settlementId: order.id, warehouseId: ctx.warehouseId, items: [{ productId: ctx.civ.id, packagingUnitId: civUnit, quantity: 1 }] };
  const [t1, t2] = await Promise.all([returns.createReturn(ret, ctx.repActor), returns.createReturn(ret, ctx.repActor)]);
  assert.equal(t1.id, t2.id, 'not a second return, and no "Only 0 boxes" error');
  assert.equal(await prisma.return.count({ where: { settlementId: order.id } }), 1);
  await returns.cancelReturn(t1.id, ctx.repActor).catch(() => {});
});

test('reps00: a price raised before approval does not change what is booked — the sale and the account hold what the rep paid', async () => {
  await closeOpenOrders();
  const order = (await issue(ctx.civ, 2)).settlement;
  const sub = await submission.submit(order.id, { productId: ctx.civ.id, boxes: 1, accountId: await accountFor(ctx.civ) }, ctx.repActor);
  const paid = Number(sub.amount);
  assert.equal(paid, Number(ctx.civ.sellingPrice));
  const original = ctx.civ.sellingPrice;
  await prisma.product.update({ where: { id: ctx.civ.id }, data: { sellingPrice: Number(original) + 5000 } });
  try {
    await submission.approve(sub.id, ctx.admin);
  } finally {
    await prisma.product.update({ where: { id: ctx.civ.id }, data: { sellingPrice: original } });
  }
  const saved = await prisma.settlementSubmission.findUnique({ where: { id: sub.id } });
  const sale = await prisma.sale.findUnique({ where: { id: saved.saleId } });
  assert.equal(Number(sale.total), paid, 'the sale is the amount paid, not the new price');
  await pause(400); // the income is booked just after the approval answers
  const ledger = await prisma.financeTransaction.findMany({ where: { refType: 'Sale', refId: sale.id } });
  assert.equal(ledger.length, 1);
  assert.equal(Number(ledger[0].amount), paid, 'the account gets what the rep paid');
  const stl = await prisma.settlement.findUnique({ where: { id: order.id } });
  assert.equal(Number(stl.settledValue), paid);
});

test('reps02: Add stock never lands on an overdue order; it opens a fresh 72-hour one', async () => {
  await closeOpenOrders();
  const first = (await issue(ctx.ohis, 1)).settlement;
  await prisma.settlement.update({ where: { id: first.id }, data: { deadlineAt: new Date(Date.now() - HOUR), status: 'OVERDUE' } });
  const before = await prisma.settlement.findUnique({ where: { id: first.id } });
  const out = await issue(ctx.ohis, 2);
  assert.notEqual(out.settlement.id, first.id, 'a new order');
  const hoursLeft = (new Date(out.settlement.deadlineAt) - Date.now()) / HOUR;
  assert.ok(hoursLeft > 71.9 && hoursLeft <= 72, `72 hours to settle the new boxes (got ${hoursLeft.toFixed(2)})`);
  const after = await prisma.settlement.findUnique({ where: { id: first.id } });
  assert.equal(String(after.assignedValue), String(before.assignedValue), 'the overdue order did not grow');
  // An order still inside its deadline still takes the boxes.
  const again = await issue(ctx.ohis, 1);
  assert.equal(again.settlement.id, out.settlement.id);
  const notice = await prisma.notification.findFirst({ where: { userId: ctx.rep.userId }, orderBy: { createdAt: 'desc' } });
  assert.equal(notice.title, 'New stock added', 'no emoji (ui-r09)');
  assert.match(notice.message, /^ZELab added/);
});

test('reps03: approving a return while other boxes are owed gives back the hours it paused the fines', async () => {
  await closeOpenOrders();
  const order = (await issue(ctx.ohis, 2)).settlement;
  const unit = await boxUnitOf(ctx.ohis.id);
  const ret = await returns.createReturn({ type: 'SALES_RETURN', salesRepId: ctx.rep.id, settlementId: order.id, warehouseId: ctx.warehouseId, items: [{ productId: ctx.ohis.id, packagingUnitId: unit, quantity: 1 }] }, ctx.repActor);
  // Sent 1 hour before the deadline, decided 23 hours later (as in the audit).
  await prisma.return.update({ where: { id: ret.id }, data: { processedAt: new Date(Date.now() - 23 * HOUR) } });
  await prisma.settlement.update({ where: { id: order.id }, data: { deadlineAt: new Date(Date.now() - 22 * HOUR), status: 'OVERDUE' } });
  await returns.approveReturn(ret.id, ctx.admin);
  const stl = await prisma.settlement.findUnique({ where: { id: order.id } });
  const hoursLeft = (new Date(stl.deadlineAt) - Date.now()) / HOUR;
  assert.ok(hoursLeft > 0.9 && hoursLeft < 1.1, `the hour he had left is his again (got ${hoursLeft.toFixed(2)})`);
  assert.notEqual(stl.status, 'OVERDUE');
  await penalty.applyDuePenalties();
  assert.equal(await prisma.settlementPenalty.count({ where: { settlementId: order.id } }), 0, 'no fine for the paused time');
});

test('reps04: after an extension, the first late day past the NEW deadline is fined at once', async () => {
  await closeOpenOrders();
  const order = (await issue(ctx.ohis, 1)).settlement;
  await prisma.settlement.update({ where: { id: order.id }, data: { deadlineAt: new Date(Date.now() - 60_000), status: 'OVERDUE' } });
  await penalty.applyDuePenalties();
  assert.equal(await prisma.settlementPenalty.count({ where: { settlementId: order.id } }), 1, 'day 1 of the first deadline');
  await settlement.extendDeadline(order.id, { deadlineAt: new Date(Date.now() + 1500).toISOString() }, ctx.admin);
  await penalty.applyDuePenalties();
  assert.equal(await prisma.settlementPenalty.count({ where: { settlementId: order.id } }), 1, 'nothing while the new deadline is ahead');
  await pause(2000);
  await penalty.applyDuePenalties();
  const fines = await prisma.settlementPenalty.findMany({ where: { settlementId: order.id }, orderBy: { appliedAt: 'asc' } });
  assert.equal(fines.length, 2, 'the new deadline passed: its first day is charged (it was skipped before)');
  await penalty.applyDuePenalties();
  assert.equal(await prisma.settlementPenalty.count({ where: { settlementId: order.id } }), 2, 'and only once');
});

test('reps01: Pepa added to an order opened before the Pepa rate earns 6,000 a box, not the 5,000 fallback', async () => {
  await closeOpenOrders();
  const order = (await issue(ctx.ohis, 1)).settlement;
  // An order opened on 14 Nov, still inside its deadline.
  await prisma.settlement.update({ where: { id: order.id }, data: { issuedAt: new Date('2026-11-14T18:00:00Z'), deadlineAt: new Date(Date.now() + 48 * HOUR) } });
  const added = await issue(ctx.pepa, 2);
  assert.equal(added.mode, 'attached');
  assert.equal(added.settlement.id, order.id);
  const sub = await submission.submit(order.id, { productId: ctx.pepa.id, boxes: 2, accountId: await accountFor(ctx.pepa) }, ctx.repActor);
  await submission.approve(sub.id, ctx.admin);
  const view = await settlement.get(order.id);
  const line = view.order.lines.find((l) => l.productId === ctx.pepa.id);
  assert.equal(line.commissionPerBox, 6000);
  assert.equal(Number(await commission.rateForProductOnOrder(order.id, ctx.pepa.id)), 6000);
  const lines = await commission.earnedLinesForRep(ctx.rep.id, new Date(Date.now() - HOUR), new Date(Date.now() + HOUR));
  const pepaLines = lines.filter((l) => l.brand === 'Pepa');
  assert.equal(pepaLines.reduce((n, l) => n + l.boxes, 0), 2);
  assert.equal(pepaLines.reduce((n, l) => n + l.amount, 0), 12000, 'the rep\'s earnings: 2 boxes × 6,000');
  // OHIS on the same old order keeps the rate of the order's own date.
  const ohisLine = view.order.lines.find((l) => l.productId === ctx.ohis.id);
  assert.equal(ohisLine.commissionPerBox, Number(await commission.rateForBrandAt('OHIS', '2026-11-14T18:00:00Z')));

  // repor00 / reps-00: the every-rep batch behind Home, Commissions, the wallet and withdrawals prices the same
  // boxes the same way — it used to pay these two 5,000 each while the order and the notice said 6,000.
  const batch = await commission.computeForRep(ctx.rep.id);
  assert.deepEqual(batch.earnedByBrand.find((b) => b.brand === 'Pepa'), { brand: 'Pepa', boxes: 2, amount: 12000, rate: 6000 });
  const alone = await commission.earnedForRep(ctx.rep.id);
  assert.deepEqual(batch.earnedByBrand, alone.byBrand, 'batch and one-rep read give the same brands, figures and order');
  assert.equal(batch.grossEarned, alone.earned);
  const others = (await prisma.salesRepresentative.findMany({ select: { id: true }, take: 5 })).map((r) => r.id);
  assert.deepEqual((await commission.computeForReps([...others, ctx.rep.id])).get(ctx.rep.id), batch, 'read with other reps, the same');

  // ui-re03: the approval notice counts boxes in plain English.
  await pause(500); // the notice is written after the approval returns
  const notice = await prisma.notification.findFirst({ where: { userId: ctx.rep.userId, title: 'Settlement approved', message: { contains: 'Pepa' } }, orderBy: { createdAt: 'desc' } });
  assert.match(notice.message, /Your settlement of 2 boxes of Pepa/);
  assert.match(notice.message, /\(2 boxes × TSh\s6,000\)/);
  assert.doesNotMatch(notice.message, /box\(es\)/);
});

test('reps06 / reps07 / ui-r06: current names on approvals, the fixed product order, and the closing return says so', async () => {
  await closeOpenOrders();
  const order = (await issue(ctx.civ, 1)).settlement;
  await issue(ctx.ohis, 1);
  await issue(ctx.pepa, 1);
  const view = await settlement.get(order.id);
  assert.deepEqual(view.order.lines.map((l) => l.brandName), ['Pepa', 'OHIS', 'Civlily'], 'Pepa, OHIS, Civlily — not by boxes issued');

  // A submission stored under an older name shows the product's name now.
  const sub = await submission.submit(order.id, { productId: ctx.civ.id, boxes: 1, accountId: await accountFor(ctx.civ) }, ctx.repActor);
  await prisma.settlementSubmission.update({ where: { id: sub.id }, data: { productName: 'Civlily Pepa Ndogo (Brown) – Bila Filter' } });
  const pending = (await submission.listPending()).find((p) => p.id === sub.id);
  assert.equal(pending.productName, ctx.civ.name);
  assert.equal((await settlement.get(order.id)).pendingSubmissionsList.find((p) => p.id === sub.id).productName, ctx.civ.name);
  await submission.approve(sub.id, ctx.admin);

  // The rest goes back: that return closes the order, and both the rep and the owner are told.
  const items = [];
  for (const p of [ctx.ohis, ctx.pepa]) items.push({ productId: p.id, packagingUnitId: await boxUnitOf(p.id), quantity: 1 });
  const ret = await returns.createReturn({ type: 'SALES_RETURN', salesRepId: ctx.rep.id, settlementId: order.id, warehouseId: ctx.warehouseId, items }, ctx.repActor);
  const since = new Date();
  await returns.approveReturn(ret.id, ctx.admin);
  await pause(500);
  assert.equal((await prisma.settlement.findUnique({ where: { id: order.id } })).status, 'SETTLED');
  const repNotice = await prisma.notification.findFirst({ where: { userId: ctx.rep.userId, title: 'Return approved', createdAt: { gte: since } } });
  assert.match(repNotice.message, new RegExp(`Order ${order.settlementNumber} is now fully closed`));
  const ownerNotice = await prisma.notification.count({ where: { title: `Order closed: ${order.settlementNumber}`, createdAt: { gte: since } } });
  assert.ok(ownerNotice >= 1, 'the owner gets "Order closed"');
});
