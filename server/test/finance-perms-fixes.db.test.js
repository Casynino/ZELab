'use strict';

// ── Finance write paths, against a REAL database (audit 15 Nov 2026: fina00/01/04/05/06/07, perm00/01/04) ──
// Supplier payments are judged under the supplier's row lock, a money date stays inside the books, an account
// is never opened below zero or switched off with money in it, a new category moves an expense with it, and a
// second press of a transfer that emptied the account is told "already recorded". The locks are raw SQL, so
// this runs only against a throwaway copy of the data:
//
//   FINANCE_TEST_DATABASE_URL=postgresql://localhost/zelab_fix_finance node --test test/finance-perms-fixes.db.test.js
//
// Never point it at production: it writes accounts, suppliers, orders and payments.

const test = require('node:test');
const assert = require('node:assert');

const url = process.env.FINANCE_TEST_DATABASE_URL;
if (!url) {
  test('finance write paths (real database)', { skip: 'set FINANCE_TEST_DATABASE_URL to a throwaway database' }, () => {});
  return;
}
process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;

const prisma = require('../src/config/prisma');
const finance = require('../src/services/finance.service');
const reports = require('../src/services/reports.service');

const ctx = {};
const stamp = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
const balanceOf = async (id) => (await finance.accountBalances({ accountId: id }))[0].balance;
const rejectsWith = (p, code, re) => assert.rejects(p, (e) => e.statusCode === code && (!re || re.test(e.message)));
const newAccount = (name, openingBalance) => prisma.businessAccount.create({
  data: { name: `${name} ${stamp}-${Math.round(Math.random() * 1e6)}`, type: 'BANK', openingBalance },
});
const eatDay = (d) => new Date(new Date(d).getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
// A supplier owed `owed` on one confirmed order.
async function owedSupplier(owed) {
  const supplier = await prisma.supplier.create({ data: { name: `Race supplier ${stamp}-${Math.round(Math.random() * 1e6)}` } });
  const po = await prisma.purchaseOrder.create({
    data: { poNumber: `PO-T-${stamp}-${Math.round(Math.random() * 1e6)}`, supplierId: supplier.id, status: 'ORDERED', goodsCost: owed, totalCost: owed },
  });
  return { supplier, po };
}

test.before(async () => {
  ctx.admin = await prisma.user.findFirst({ where: { role: { name: 'ADMIN' } } });
  ctx.epoch = await reports.financeEpoch();
  assert.ok(ctx.admin, 'needs an admin');
});
test.after(async () => { await prisma.$disconnect(); });

test('two balance payments at once for a supplier owed 7,000: one goes through, the bill never goes below zero', async () => {
  const acc = await newAccount('Test pay', 100_000);
  const { supplier } = await owedSupplier(7_000);
  const both = await Promise.allSettled([
    finance.paySupplierBalance(supplier.id, { accountId: acc.id, amount: 7_000 }, ctx.admin),
    finance.paySupplierBalance(supplier.id, { accountId: acc.id, amount: 7_000 }, ctx.admin),
    finance.paySupplierBalance(supplier.id, { accountId: acc.id, amount: 7_000 }, ctx.admin),
  ]);
  assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1, 'one payment');
  for (const r of both.filter((x) => x.status === 'rejected')) assert.match(r.reason.message, /only owe/);
  const { totals } = await finance.supplierDetail(supplier.id);
  assert.equal(totals.outstanding, 0);
  assert.equal(await balanceOf(acc.id), 93_000);
});

test('the same press twice (one clientKey) is recorded once and told "already recorded"', async () => {
  const acc = await newAccount('Test key', 100_000);
  const { supplier, po } = await owedSupplier(10_000);
  const key = `sup-${stamp}`;
  const both = await Promise.allSettled([
    finance.paySupplierBalance(supplier.id, { accountId: acc.id, amount: 10_000, clientKey: key }, ctx.admin),
    finance.paySupplierBalance(supplier.id, { accountId: acc.id, amount: 10_000, clientKey: key }, ctx.admin),
  ]);
  assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
  const refused = both.find((r) => r.status === 'rejected').reason;
  assert.equal(refused.statusCode, 409);
  assert.match(refused.message, /Already recorded/);
  // A PO payment with a key, pressed twice after the first paid it all: "already recorded", not "nothing left".
  const { supplier: s2, po: po2 } = await owedSupplier(4_000);
  const k2 = `po-${stamp}`;
  await finance.paySupplier({ purchaseOrderId: po2.id, accountId: acc.id, amount: 4_000, clientKey: k2 }, ctx.admin);
  await rejectsWith(finance.paySupplier({ purchaseOrderId: po2.id, accountId: acc.id, amount: 4_000, clientKey: k2 }, ctx.admin), 409, /Already recorded/);
  assert.equal((await finance.supplierDetail(s2.id)).totals.outstanding, 0);
  assert.ok(po, 'first order kept');
});

test('two PO payments at once for the whole order: one goes through', async () => {
  const acc = await newAccount('Test po', 100_000);
  const { supplier, po } = await owedSupplier(25_000);
  const both = await Promise.allSettled([
    finance.paySupplier({ purchaseOrderId: po.id, accountId: acc.id, amount: 25_000 }, ctx.admin),
    finance.paySupplier({ purchaseOrderId: po.id, accountId: acc.id, amount: 25_000 }, ctx.admin),
  ]);
  assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await finance.supplierDetail(supplier.id)).totals.outstanding, 0);
  assert.equal(await balanceOf(acc.id), 75_000);
});

test('a money date stays between the day the books started and today', async () => {
  const acc = await newAccount('Test dates', 50_000);
  const exp = { accountId: acc.id, amount: 1_000, category: 'Transport', description: 'Date check' };
  if (ctx.epoch) {
    const before = new Date(ctx.epoch.getTime() - 3 * 86_400_000);
    await rejectsWith(finance.recordExpense({ ...exp, occurredAt: eatDay(before) }, ctx.admin), 400, /books start/);
    await rejectsWith(finance.recordIncome({ accountId: acc.id, amount: 500, occurredAt: before.toISOString() }, ctx.admin), 400, /books start/);
    const { supplier } = await owedSupplier(1_000);
    await rejectsWith(finance.paySupplierBalance(supplier.id, { accountId: acc.id, amount: 1, occurredAt: eatDay(before) }, ctx.admin), 400, /books start/);
    assert.equal((await finance.supplierDetail(supplier.id)).totals.outstanding, 1_000, 'the bill did not fall');
    // Go-live day itself is in the books: it counts from the moment they started.
    const onDay = await finance.recordExpense({ ...exp, occurredAt: eatDay(ctx.epoch) }, ctx.admin);
    assert.ok(new Date(onDay.occurredAt) >= ctx.epoch);
    assert.equal(await balanceOf(acc.id), 49_000, 'and it came off the balance');
  }
  const tomorrow = eatDay(Date.now() + 86_400_000);
  await rejectsWith(finance.recordExpense({ ...exp, occurredAt: tomorrow }, ctx.admin), 400, /after today/);
  await rejectsWith(finance.transferBetweenAccounts({ fromAccountId: acc.id, toAccountId: (await newAccount('Test to', 0)).id, amount: 10, occurredAt: tomorrow }, ctx.admin), 400, /after today/);
  const today = await finance.recordExpense({ ...exp, occurredAt: eatDay(Date.now()) }, ctx.admin);
  // An edit cannot move it after today either.
  await rejectsWith(finance.updateTransaction(today.id, { occurredAt: tomorrow }), 400, /after today/);
});

test('an account never opens below zero and is switched off only once it holds nothing', async () => {
  await rejectsWith(finance.createAccount({ name: `Neg ${stamp}`, type: 'BANK', openingBalance: -5_000 }), 400, /less than zero/);
  const acc = await finance.createAccount({ name: `Close ${stamp}`, type: 'BANK', openingBalance: 7_000 });
  await rejectsWith(finance.updateAccount(acc.id, { openingBalance: -1 }), 400, /less than zero/);
  await rejectsWith(finance.updateAccount(acc.id, { isActive: false }), 400, /still holds TSh\s?7,000/);
  assert.equal((await prisma.businessAccount.findUnique({ where: { id: acc.id } })).isActive, true);
  const other = await newAccount('Test sink', 0);
  await finance.transferBetweenAccounts({ fromAccountId: acc.id, toAccountId: other.id, amount: 7_000 }, ctx.admin);
  const { updated } = await finance.updateAccount(acc.id, { isActive: false });
  assert.equal(updated.isActive, false);
});

test('a second press of a transfer that emptied the account is "already recorded", not "only holds 0"', async () => {
  const a = await newAccount('Test empty', 6_100);
  const b = await newAccount('Test fill', 0);
  const body = { fromAccountId: a.id, toAccountId: b.id, amount: 6_100, clientKey: `trf-empty-${stamp}` };
  await finance.transferBetweenAccounts(body, ctx.admin);
  await rejectsWith(finance.transferBetweenAccounts(body, ctx.admin), 409, /Already recorded/);
  assert.equal(await balanceOf(a.id), 0);
  assert.equal(await balanceOf(b.id), 6_100);
});

test('changing an expense\'s category moves it between expense and stock bought', async () => {
  const acc = await newAccount('Test cat', 10_000);
  const stock = await finance.recordExpense({ accountId: acc.id, amount: 30, category: 'Stock Purchase', description: 'cat test' }, ctx.admin);
  assert.equal(stock.type, 'STOCK_PURCHASE');
  assert.equal((await finance.updateTransaction(stock.id, { category: 'Fuel' })).updated.type, 'EXPENSE');
  const fuel = await finance.recordExpense({ accountId: acc.id, amount: 20, category: 'Fuel', description: 'cat test' }, ctx.admin);
  assert.equal(fuel.type, 'EXPENSE');
  assert.equal((await finance.updateTransaction(fuel.id, { category: 'Stock Purchase' })).updated.type, 'STOCK_PURCHASE');
  // A supplier payment keeps its type whatever its category says.
  const { supplier } = await owedSupplier(100);
  const pay = await finance.paySupplierBalance(supplier.id, { accountId: acc.id, amount: 100 }, ctx.admin);
  assert.equal((await finance.updateTransaction(pay.id, { category: 'Fuel' })).updated.type, 'STOCK_PURCHASE');
});

test('a supplier credit is capped under the same lock as payments', async () => {
  const acc = await newAccount('Test credit', 10_000);
  const { supplier } = await owedSupplier(5_000);
  const both = await Promise.allSettled([
    finance.recordSupplierCredit(supplier.id, { amount: 5_000, reason: 'Damaged boxes sent back' }, ctx.admin),
    finance.paySupplierBalance(supplier.id, { accountId: acc.id, amount: 5_000 }, ctx.admin),
  ]);
  assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1, 'the bill is taken off once, by a credit or a payment');
  assert.equal((await finance.supplierDetail(supplier.id)).totals.outstanding, 0);
});
