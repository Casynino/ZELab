'use strict';

// The rep's wallet transactions (15 Nov 2026) must add up to the figures on his card, for every rep:
// commission rows = grossEarned, + adjustment + bonus = earned, payouts = paid, fines = penalties,
// requests still waiting = pending. Read-only, against a throwaway copy of the data:
//
//   REPS_TEST_DATABASE_URL=postgresql://localhost/zelab_copy node --test test/wallet-activity.db.test.js

const test = require('node:test');
const assert = require('node:assert');

const url = process.env.REPS_TEST_DATABASE_URL;
if (!url) {
  test('wallet activity adds up (real database)', { skip: 'set REPS_TEST_DATABASE_URL to a throwaway database' }, () => {});
  return;
}
process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;

const prisma = require('../src/config/prisma');
const commission = require('../src/services/commission.service');
const bonus = require('../src/services/bonus.service');

test.after(async () => { await prisma.$disconnect(); });

const neg = (x) => (x === 0 ? 0 : -x); // no -0
const sum = (items, kind) => Math.round(items.filter((i) => i.kind === kind).reduce((s, i) => s + i.amount, 0) * 100) / 100;

test('every rep: the transactions add up to the card (earned, paid out, fines, waiting, balance)', async () => {
  const reps = await prisma.salesRepresentative.findMany({ select: { id: true } });
  assert.ok(reps.length > 0, 'needs reps in the copy');
  for (const { id } of reps) {
    const [c, items, b] = await Promise.all([commission.computeForRep(id), commission.activityForRep(id), bonus.walletForRep(id)]);
    const card = bonus.combine(c, b);
    assert.strictEqual(sum(items, 'EARNED'), c.grossEarned, `commission rows = grossEarned (${id})`);
    assert.strictEqual(Math.round((sum(items, 'EARNED') + sum(items, 'ADJUSTMENT') + sum(items, 'BONUS')) * 100) / 100, card.earned, `earned (${id})`);
    assert.strictEqual(neg(sum(items, 'PAID_OUT')), card.paid, `paid out (${id})`);
    assert.strictEqual(neg(sum(items, 'FINE')), c.penalties, `fines (${id})`);
    assert.strictEqual(neg(sum(items, 'WAITING')), card.pending, `waiting (${id})`);
    // Newest first.
    for (let i = 1; i < items.length; i++) assert.ok(new Date(items[i - 1].at) >= new Date(items[i].at), 'newest first');
  }
});
