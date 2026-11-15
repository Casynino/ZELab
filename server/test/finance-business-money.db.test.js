'use strict';

// ── Business money only, against a REAL database (15 Nov 2026) ─────────────────────────────────────────
// Every payment comes out of a recorded account and never more than it holds; rep payouts come off an account;
// a double tap records once; recorded money is reversed, never deleted or edited. The funds check locks rows
// with raw SQL, so this runs only against a throwaway copy of the data:
//
//   FINANCE_TEST_DATABASE_URL=postgresql://localhost/zelab_po node --test test/finance-business-money.db.test.js
//
// Never point it at production: it writes accounts, expenses and payouts.

const test = require('node:test');
const assert = require('node:assert');

const url = process.env.FINANCE_TEST_DATABASE_URL;
if (!url) {
  test('business money only (real database)', { skip: 'set FINANCE_TEST_DATABASE_URL to a throwaway database' }, () => {});
  return;
}
process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;

const prisma = require('../src/config/prisma');
const finance = require('../src/services/finance.service');
const commission = require('../src/services/commission.service');

const ctx = {};
const stamp = Date.now();
const balanceOf = async (id) => (await finance.accountBalances({ accountId: id }))[0].balance;
const rejectsWith = (p, code, re) => assert.rejects(p, (e) => e.statusCode === code && (!re || re.test(e.message)));
const newAccount = (name, openingBalance, extra = {}) => prisma.businessAccount.create({
  data: { name: `${name} ${stamp}-${Math.round(Math.random() * 1e6)}`, type: 'CASH', openingBalance, ...extra },
});

test.before(async () => {
  ctx.admin = await prisma.user.findFirst({ where: { role: { name: 'ADMIN' } } });
  ctx.rep = await prisma.salesRepresentative.findFirst({ include: { user: { select: { name: true } } } });
  assert.ok(ctx.admin && ctx.rep, 'needs an admin and a rep');
});
test.after(async () => { await prisma.$disconnect(); });

test('an expense is paid only from what the account holds, says what it was for, and is recorded once', async () => {
  const acc = await newAccount('Test cash', 100_000);
  const exp = { accountId: acc.id, amount: 60_000, category: 'Transport', description: 'Boda to the port' };
  await rejectsWith(finance.recordExpense({ ...exp, description: '' }, ctx.admin), 400, /spent on/);
  await rejectsWith(finance.recordExpense({ ...exp, amount: 150_000 }, ctx.admin), 400, /Not enough money/);
  assert.equal(await balanceOf(acc.id), 100_000, 'a refused expense takes nothing');
  // The same press twice at once: one entry.
  const key = `exp-${stamp}`;
  const both = await Promise.allSettled([
    finance.recordExpense({ ...exp, clientKey: key }, ctx.admin),
    finance.recordExpense({ ...exp, clientKey: key }, ctx.admin),
  ]);
  assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(both.find((r) => r.status === 'rejected').reason.statusCode, 409);
  assert.equal(await balanceOf(acc.id), 40_000);
  // Two different expenses at once that together are more than it holds: only one goes through.
  const two = await Promise.allSettled([
    finance.recordExpense({ ...exp, amount: 30_000 }, ctx.admin),
    finance.recordExpense({ ...exp, amount: 30_000 }, ctx.admin),
  ]);
  assert.equal(two.filter((r) => r.status === 'fulfilled').length, 1, 'never below zero, even at the same moment');
  assert.equal(await balanceOf(acc.id), 10_000);
});

test('own money is put in first (not income), then spent; taking profit out cannot go below zero', async () => {
  const acc = await newAccount('Test airtel', 0);
  await rejectsWith(finance.recordExpense({ accountId: acc.id, amount: 5_000, category: 'Office', description: 'Pens' }, ctx.admin), 400, /Put my money in/);
  const inflow = await finance.recordOwnerMoney({ direction: 'IN', accountId: acc.id, amount: 50_000, description: 'From my pocket' }, ctx.admin);
  assert.equal(inflow.type, 'OWNER_CONTRIBUTION');
  assert.equal(await balanceOf(acc.id), 50_000);
  await finance.recordExpense({ accountId: acc.id, amount: 5_000, category: 'Office', description: 'Pens' }, ctx.admin);
  await rejectsWith(finance.recordOwnerMoney({ direction: 'OUT', accountId: acc.id, amount: 60_000 }, ctx.admin), 400, /Not enough money/);
});

test('a transfer moves money only if the first account has it, both sides together, once', async () => {
  const a = await newAccount('Test from', 20_000);
  const b = await newAccount('Test to', 0);
  await rejectsWith(finance.transferBetweenAccounts({ fromAccountId: a.id, toAccountId: b.id, amount: 30_000 }, ctx.admin), 400);
  const key = `trf-${stamp}`;
  await finance.transferBetweenAccounts({ fromAccountId: a.id, toAccountId: b.id, amount: 15_000, clientKey: key }, ctx.admin);
  await rejectsWith(finance.transferBetweenAccounts({ fromAccountId: a.id, toAccountId: b.id, amount: 1_000, clientKey: key }, ctx.admin), 409);
  assert.equal(await balanceOf(a.id), 5_000);
  assert.equal(await balanceOf(b.id), 15_000);
});

test('a rep is paid from the chosen account: approval moves nothing, paying needs the money, never twice', async () => {
  const acc = await newAccount('Test payout', 30_000);
  const w = await prisma.commissionWithdrawal.create({ data: { salesRepId: ctx.rep.id, amount: 50_000, status: 'PENDING' } });
  const pocketBefore = (await finance.ownerFigures()).commissionFromPocket;
  await commission.decideWithdrawal(w.id, 'APPROVE', ctx.admin);
  assert.equal(await balanceOf(acc.id), 30_000, 'approving moves no money');
  await rejectsWith(commission.decideWithdrawal(w.id, 'PAY', ctx.admin, {}), 400, /Choose the account/);
  await rejectsWith(commission.decideWithdrawal(w.id, 'PAY', ctx.admin, { accountId: acc.id }), 400, /Not enough money/);
  assert.equal((await prisma.commissionWithdrawal.findUnique({ where: { id: w.id } })).status, 'APPROVED', 'not marked paid without the money');
  await prisma.businessAccount.update({ where: { id: acc.id }, data: { openingBalance: 80_000 } });
  const two = await Promise.allSettled([
    commission.decideWithdrawal(w.id, 'PAY', ctx.admin, { accountId: acc.id }),
    commission.decideWithdrawal(w.id, 'PAY', ctx.admin, { accountId: acc.id }),
  ]);
  assert.equal(two.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(two.find((r) => r.status === 'rejected').reason.statusCode, 409);
  assert.equal(await balanceOf(acc.id), 30_000, 'paid exactly once, from that account');
  const rows = await prisma.financeTransaction.findMany({ where: { refType: 'CommissionWithdrawal', refId: w.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'EXPENSE', 'a business expense');
  assert.equal(rows[0].category, 'Commission Payments');
  assert.equal((await prisma.commissionWithdrawal.findUnique({ where: { id: w.id } })).status, 'PAID');
  assert.equal((await finance.ownerFigures()).commissionFromPocket, pocketBefore, 'not counted as money from your pocket');
  // The rebuild never adds a second (pocket) record for it.
  await finance.backfillShared?.();
  assert.equal(await prisma.financeTransaction.count({ where: { refType: 'CommissionWithdrawal', refId: w.id } }), 1);
  // A rejected request moves nothing.
  const r = await prisma.commissionWithdrawal.create({ data: { salesRepId: ctx.rep.id, amount: 10_000, status: 'PENDING' } });
  await commission.decideWithdrawal(r.id, 'REJECT', ctx.admin);
  assert.equal(await prisma.financeTransaction.count({ where: { refType: 'CommissionWithdrawal', refId: r.id } }), 0);
});

test('recorded money is never deleted or edited: it is reversed, once, and both stay', async () => {
  const acc = await newAccount('Test reverse', 100_000);
  const exp = await finance.recordExpense({ accountId: acc.id, amount: 40_000, category: 'Transport', description: 'Wrong amount' }, ctx.admin);
  await rejectsWith(finance.deleteTransaction(exp.id), 400, /never deleted/);
  await rejectsWith(finance.updateTransaction(exp.id, { amount: 4_000 }), 400, /cannot be changed/);
  await rejectsWith(finance.updateTransaction(exp.id, { accountId: (await newAccount('Other', 0)).id }), 400, /cannot be changed/);
  await finance.updateTransaction(exp.id, { description: 'Boda to the port' }); // words can still be fixed
  await rejectsWith(finance.reverseTransaction(exp.id, {}, ctx.admin), 400, /why/);
  const { reversals } = await finance.reverseTransaction(exp.id, { reason: 'Typed 40,000 instead of 4,000' }, ctx.admin);
  assert.equal(Number(reversals[0].amount), -40_000);
  assert.equal(await balanceOf(acc.id), 100_000, 'the account is whole again');
  await rejectsWith(finance.reverseTransaction(exp.id, { reason: 'again' }, ctx.admin), 409);
  await rejectsWith(finance.reverseTransaction(reversals[0].id, { reason: 'undo the undo' }, ctx.admin), 400, /itself a reversal/);
  // Undoing money that came in cannot leave the account below zero.
  const inc = await finance.recordIncome({ accountId: acc.id, amount: 10_000, category: 'Other', description: 'Refund' }, ctx.admin);
  await finance.recordExpense({ accountId: acc.id, amount: 105_000, category: 'Office', description: 'Spend it' }, ctx.admin);
  await rejectsWith(finance.reverseTransaction(inc.id, { reason: 'not a refund' }, ctx.admin), 400, /Not enough money/);
});

test('a correction cannot set a balance below zero; an opening balance is fixed once money moved', async () => {
  const acc = await newAccount('Test correct', 10_000);
  await rejectsWith(finance.recordBalanceCorrection({ accountId: acc.id, targetBalance: -5 }, ctx.admin), 400, /less than zero/);
  await finance.recordExpense({ accountId: acc.id, amount: 1_000, category: 'Office', description: 'Tea' }, ctx.admin);
  await rejectsWith(finance.updateAccount(acc.id, { openingBalance: 50_000 }), 400, /Correct balance/);
});
