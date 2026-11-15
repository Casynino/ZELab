'use strict';

// ── Finance's missing-row check, on a real database (15 Nov 2026) ────────────────────────────────────
// Finance and Home used to run the whole ledger self-heal (backfillFromHistory) before every read. They now
// ask one SQL question first and run the pass only when it finds a gap. These tests pin that the question
// sees every gap the pass would fill — and none it would not — on a real Postgres. Every change is made
// inside a transaction that is rolled back, so the database is left exactly as it was.
//
// Run with: SPEED_TEST_DATABASE_URL=postgresql://…/<a throwaway copy> node --test test/speed-ledger-gaps.db.test.js
// Skipped without the variable. Never point it at production.

const test = require('node:test');
const assert = require('node:assert/strict');

const URL = process.env.SPEED_TEST_DATABASE_URL;
const skip = !URL && 'SPEED_TEST_DATABASE_URL not set';
if (URL) {
  process.env.DATABASE_URL = URL;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only';
}

const ROLLBACK = new Error('rollback');
// Run `fn` inside a transaction and always roll it back; returns what fn returned.
async function inRolledBackTx(prisma, fn) {
  let out;
  try {
    await prisma.$transaction(async (tx) => { out = await fn(tx); throw ROLLBACK; }, { timeout: 20_000 });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return out;
}

test('the check finds nothing when the full pass would add nothing', { skip }, async () => {
  const fin = require('../src/services/finance.service');
  const gaps = await fin.ledgerGaps();
  // The pass itself: on a copy that is already healed it writes nothing, which is what is asserted.
  const result = await fin.backfillFromHistory();
  assert.deepEqual(result, { incomeCreated: 0, paymentsCreated: 0, brandTagged: 0 }, 'the copy was already healed');
  assert.deepEqual(gaps, { missingIncome: false, untaggedIncome: false, missingPayout: false });
});

test('a settled-order sale with no ledger row is a gap; one from before the epoch is not', { skip }, async () => {
  const prisma = require('../src/config/prisma');
  const fin = require('../src/services/finance.service');
  const reports = require('../src/services/reports.service');
  const epoch = await reports.financeEpoch();
  const row = await prisma.financeTransaction.findFirst({
    where: { refType: 'Sale', refId: { not: null } },
    orderBy: { occurredAt: 'desc' },
  });
  assert.ok(row, 'the copy has sale income rows');
  const sale = await prisma.sale.findUnique({ where: { id: row.refId } });
  const gaps = await inRolledBackTx(prisma, async (tx) => {
    await tx.financeTransaction.delete({ where: { id: row.id } });
    return fin.ledgerGaps(tx);
  });
  const eligible = sale && sale.status !== 'CANCELLED' && sale.type === 'CASH'
    && (sale.settlementId || !sale.salesRepId) && (!epoch || sale.soldAt >= epoch)
    && Number(sale.settlementId ? sale.total : sale.amountPaid) > 0;
  assert.equal(gaps.missingIncome, Boolean(eligible));

  // The epoch boundary, to the millisecond: a sale moved to just before it no longer counts, just after it does.
  if (epoch && eligible) {
    const at = async (ms) => inRolledBackTx(prisma, async (tx) => {
      await tx.financeTransaction.delete({ where: { id: row.id } });
      await tx.sale.update({ where: { id: sale.id }, data: { soldAt: new Date(epoch.getTime() + ms) } });
      return fin.ledgerGaps(tx);
    });
    assert.equal((await at(-1)).missingIncome, false, '1 ms before the epoch is history');
    assert.equal((await at(0)).missingIncome, true, 'the epoch itself counts');
    assert.equal((await at(1)).missingIncome, true);
  }
  assert.deepEqual(await fin.ledgerGaps(), { missingIncome: false, untaggedIncome: false, missingPayout: false }, 'rolled back');
});

test('a sale row that lost its brand is a gap only when its sale is all one brand', { skip }, async () => {
  const prisma = require('../src/config/prisma');
  const fin = require('../src/services/finance.service');
  const rows = await prisma.financeTransaction.findMany({ where: { refType: 'Sale', brandId: { not: null } }, take: 5, orderBy: { occurredAt: 'desc' } });
  assert.ok(rows.length, 'the copy has brand-tagged sale income');
  for (const row of rows) {
    const items = await prisma.saleItem.findMany({ where: { saleId: row.refId }, select: { product: { select: { brandId: true } } } });
    const brands = new Set(items.map((i) => i.product?.brandId).filter(Boolean));
    const gaps = await inRolledBackTx(prisma, async (tx) => {
      await tx.financeTransaction.update({ where: { id: row.id }, data: { brandId: null } });
      return fin.ledgerGaps(tx);
    });
    assert.equal(gaps.untaggedIncome, brands.size === 1);
    assert.equal(gaps.missingIncome, false);
  }
});

test('a PAID withdrawal with no ledger row is a gap', { skip }, async () => {
  const prisma = require('../src/config/prisma');
  const fin = require('../src/services/finance.service');
  const reports = require('../src/services/reports.service');
  const epoch = await reports.financeEpoch();
  const paid = await prisma.commissionWithdrawal.findFirst({ where: { status: 'PAID' } });
  if (!paid) return; // nothing to test on this copy
  const gaps = await inRolledBackTx(prisma, async (tx) => {
    await tx.financeTransaction.deleteMany({ where: { refType: 'CommissionWithdrawal', refId: paid.id } });
    return fin.ledgerGaps(tx);
  });
  const at = paid.paidAt || paid.decidedAt;
  const inBooks = !epoch || (paid.paidAt ? paid.paidAt >= epoch : (paid.decidedAt && paid.decidedAt >= epoch));
  assert.equal(gaps.missingPayout, Boolean(at && inBooks));
});

// ── The other speed changes, on the same real copy (read-only) ──────────────────────────────────────

test('the one-statement sign-in read gives every user exactly what the step-by-step read gave', { skip }, async () => {
  const prisma = require('../src/config/prisma');
  const { loadSessionUser } = require('../src/middleware/auth');
  const users = await prisma.user.findMany({ select: { id: true } });
  assert.ok(users.length > 1);
  const shape = (u) => u && ({
    id: u.id, name: u.name, email: u.email, roleId: u.roleId, warehouseId: u.warehouseId, isActive: u.isActive,
    sessionVersion: u.sessionVersion, role: u.role.name, permissions: u.role.permissions.map((p) => p.key).sort(),
    salesRep: u.salesRep ? { id: u.salesRep.id, isActive: u.salesRep.isActive } : null,
  });
  for (const { id } of users) {
    const old = await prisma.user.findUnique({ where: { id }, include: { role: { include: { permissions: true } }, salesRep: true } });
    assert.deepEqual(shape(await loadSessionUser(id)), shape(old), id);
  }
  assert.equal(await loadSessionUser('no-such-user'), null);
});

test('every rep\'s commission, bonus and fines read in one batch equal each rep read alone', { skip }, async () => {
  const prisma = require('../src/config/prisma');
  const commission = require('../src/services/commission.service');
  const bonus = require('../src/services/bonus.service');
  const penalty = require('../src/services/penalty.service');
  const ids = (await prisma.salesRepresentative.findMany({ select: { id: true } })).map((r) => r.id);
  assert.ok(ids.length > 1);
  const [all, allBonus, allFines] = await Promise.all([
    commission.computeForReps(ids),
    bonus.progressForReps(ids, { heal: false }),
    penalty.penaltyBreakdownForReps(ids),
  ]);
  for (const id of ids) {
    assert.deepEqual(all.get(id), await commission.computeForRep(id), `commission ${id}`);
    // progressForRep is still the per-rep read (one sum query per start date): the batch must match it.
    assert.deepEqual(allBonus.get(id), await bonus.progressForRep(id, { heal: false }), `bonus ${id}`);
    assert.deepEqual(allFines.get(id), await penalty.penaltyBreakdownForRep(id), `fines ${id}`);
  }
});

test.after(async () => {
  if (URL) await require('../src/config/prisma').$disconnect();
});
