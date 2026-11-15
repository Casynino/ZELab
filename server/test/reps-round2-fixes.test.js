'use strict';

// ── Rep commission, fines, notices and the rep app: what the final check found after the merge (15 Nov 2026) ──
// Each test pins one finding; the money ones are also run on a real copy (rep-flow.db.test.js and
// speed-ledger-gaps.db.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => { const f = require.resolve(rel); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
const fresh = (rel) => { delete require.cache[require.resolve(rel)]; return require(rel); };

// A database stand-in that answers every table with "nothing"; a test fills in only the tables it is about.
function db(tables = {}) {
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    count: async () => 0, groupBy: async () => [], aggregate: async () => ({ _sum: {}, _count: 0 }),
  };
  return new Proxy({}, {
    get(_t, name) {
      if (name === 'then') return undefined;
      if (name === '$queryRaw' || name === '$executeRaw') return async () => [];
      return { ...empty, ...(tables[name] || {}) };
    },
  });
}

// ── repor00 / reps-00 / repor04: the every-rep batch prices a box exactly as the one-rep read does ──────────
// Pepa (6,000 a box from 15 Nov) added to an order opened on 14 Nov is priced from the day Pepa was created,
// never the 5,000 no-brand fallback. The batch read used to leave the product's createdAt out of its select,
// so the wallet, the available balance and the withdrawal limit paid 5,000 while the order said 6,000.
const DAY = (s) => new Date(`${s}T00:00:00Z`);
const RATES = [
  { brandId: null, brand: null, perBox: 5000, effectiveFrom: DAY('2026-01-01') },
  { brandId: 'b-ohis', brand: { id: 'b-ohis', name: 'OHIS' }, perBox: 5000, effectiveFrom: DAY('2026-01-01') },
  { brandId: 'b-civ', brand: { id: 'b-civ', name: 'Civlily' }, perBox: 3000, effectiveFrom: DAY('2026-01-01') },
  { brandId: 'b-pepa', brand: { id: 'b-pepa', name: 'Pepa' }, perBox: 6000, effectiveFrom: DAY('2026-11-15') },
];
const OLD_ORDER = { issuedAt: new Date('2026-11-14T18:00:00Z') };
const LINES = [
  // Civlily first, as the database may well return it: 5 × 3,000 = 15,000, the same as OHIS's 3 × 5,000.
  { qty: 5, product: { createdAt: DAY('2025-06-01'), brand: { name: 'Civlily' } } },
  { qty: 3, product: { createdAt: DAY('2025-06-01'), brand: { name: 'OHIS' } } },
  { qty: 2, product: { createdAt: new Date('2026-11-15T10:28:00Z'), brand: { name: 'Pepa' } } },
];

// Prisma answers only what was selected: a select without product.createdAt gets no createdAt back.
function saleItemsAs(select, lines) {
  const want = select.product.select;
  return lines.map((l) => ({
    baseQuantity: l.qty,
    product: {
      ...(want.name ? { name: 'Product' } : {}),
      ...(want.createdAt ? { createdAt: l.product.createdAt } : {}),
      brand: { name: l.product.brand.name },
    },
    sale: { salesRepId: 'r1', soldAt: new Date('2026-11-15T12:00:00Z'), settlement: OLD_ORDER },
  }));
}

function loadCommission(lines) {
  stub('../src/services/notification.service', { notifyUser: async () => {}, notifyAdmins: async () => {}, createIfAbsent: async () => {} });
  stub('../src/services/penalty.service', {
    penaltyBreakdownForRep: async () => ({ total: 0, breakdown: [] }),
    penaltyBreakdownForReps: async (ids) => new Map((ids || []).map((id) => [id, { total: 0, breakdown: [] }])),
  });
  stub('../src/config/prisma', db({
    commissionRate: { findMany: async () => RATES },
    saleItem: { findMany: async ({ select }) => saleItemsAs(select, lines) },
  }));
  return fresh('../src/services/commission.service');
}

test('the batch (wallet, withdrawals) pays Pepa on an older order 6,000 a box, the same as the one-rep read', async () => {
  const commission = loadCommission(LINES);
  const batch = await commission.computeForRep('r1');
  const alone = await commission.earnedForRep('r1');
  const pepa = batch.earnedByBrand.find((b) => b.brand === 'Pepa');
  assert.deepEqual(pepa, { brand: 'Pepa', boxes: 2, amount: 12000, rate: 6000 });
  assert.equal(batch.grossEarned, 42000, '15,000 + 15,000 + 12,000');
  assert.equal(batch.available, 42000, 'what he can withdraw counts Pepa at 6,000');
  assert.deepEqual(batch.earnedByBrand, alone.byBrand);
  assert.equal(batch.grossEarned, alone.earned);
  assert.deepEqual((await commission.computeForReps(['r1', 'r2'])).get('r1'), batch);
});

test('brands with the same amount come out in the owner\'s brand order, whatever order the lines arrive in', async () => {
  const order = (b) => b.earnedByBrand.map((r) => r.brand);
  const one = await loadCommission(LINES).computeForRep('r1');
  const two = await loadCommission([...LINES].reverse()).computeForRep('r1');
  assert.deepEqual(order(one), ['OHIS', 'Civlily', 'Pepa']);
  assert.deepEqual(order(two), order(one));
  assert.deepEqual((await loadCommission([...LINES].reverse()).earnedForRep('r1')).byBrand, one.earnedByBrand);
});

// ── ui-re02: the Fines line counts the late days actually charged ─────────────────────────────────────────
test('Fines by order counts the late days charged, not the day number that starts again after an extension', async () => {
  const rows = [
    // One late day before the owner extended the order, one after: both are "day 1".
    { salesRepId: 'r1', settlementId: 's1', amount: 20000, daysOverdue: 1, kind: 'LATE_FINE', status: 'APPLIED' },
    { salesRepId: 'r1', settlementId: 's1', amount: 20000, daysOverdue: 1, kind: 'LATE_FINE', status: 'APPLIED' },
    // A late-return fine is not a late day.
    { salesRepId: 'r1', settlementId: 's2', amount: 10000, daysOverdue: 0, kind: 'EXPIRY_FINE', status: 'APPLIED' },
    { salesRepId: 'r1', settlementId: null, amount: 5000, daysOverdue: 0, kind: 'ADJUSTMENT', status: 'APPLIED' },
  ];
  const groupBy = async ({ by, where, _sum, _count, _max }) => {
    const keep = rows.filter((r) => where.salesRepId.in.includes(r.salesRepId) && r.status === where.status
      && (!where.kind || r.kind === where.kind) && (!where.settlementId || where.settlementId.in.includes(r.settlementId)));
    const m = new Map();
    for (const r of keep) {
      const k = by.map((b) => r[b]).join('|');
      if (!m.has(k)) m.set(k, { ...Object.fromEntries(by.map((b) => [b, r[b]])), rs: [] });
      m.get(k).rs.push(r);
    }
    return [...m.values()].map(({ rs, ...g }) => ({
      ...g,
      ...(_sum ? { _sum: { amount: rs.reduce((s, r) => s + r.amount, 0) } } : {}),
      ...(_count ? { _count: rs.length } : {}),
      ...(_max ? { _max: { daysOverdue: Math.max(...rs.map((r) => r.daysOverdue)), amount: Math.max(...rs.map((r) => r.amount)) } } : {}),
    }));
  };
  stub('../src/config/prisma', db({
    settlementPenalty: { groupBy },
    settlement: {
      findMany: async () => [
        { id: 's1', settlementNumber: 'STL-17', status: 'SETTLED', selfExtendedAt: new Date() },
        { id: 's2', settlementNumber: 'STL-18', status: 'SETTLED', selfExtendedAt: null },
      ],
    },
  }));
  const penalty = fresh('../src/services/penalty.service');
  const { total, breakdown } = await penalty.penaltyBreakdownForRep('r1');
  const by = Object.fromEntries(breakdown.map((b) => [b.settlementNumber, b]));
  assert.equal(total, 55000);
  assert.equal(by['STL-17'].lateDays, 2, 'two late days were charged');
  assert.equal(by['STL-17'].lateDays * by['STL-17'].penaltyPerDay, by['STL-17'].totalPenalty, '2 × 20,000 = 40,000: the line adds up');
  assert.equal(by['STL-17'].daysOverdue, 1, 'the day number is still there for anything that reads it');
  assert.equal(by['STL-18'].lateDays, 0, 'a late-return fine is not a late day');
  assert.equal(by['Manual deduction'].lateDays, 0);
});

// ── reps-05: a closed order owes nothing ──────────────────────────────────────────────────────────────────
test('a closed order with every box settled or returned shows nothing owed, even after a price change', () => {
  stub('../src/config/prisma', db());
  const settlement = fresh('../src/services/settlement.service');
  // 2 boxes issued at 30,000; one paid at 30,000; the price cut to 25,000; the other box returned.
  const order = { id: 'o1', assignedValue: 60000, settledValue: 30000, returnedValue: 25000, deadlineAt: new Date(Date.now() + 3600_000), issuedAt: new Date() };
  assert.equal(settlement.decorate({ ...order, status: 'SETTLED' }).balance, 0);
  assert.equal(settlement.decorate({ ...order, status: 'PARTIAL' }).balance, 5000, 'a live order still shows its sum');
});

// ── ui-re00: a rep can number his invoices again ─────────────────────────────────────────────────────────
test('the invoice number route lets a rep, the warehouse and the owner through, and no one else', () => {
  stub('../src/middleware/auth', { authenticate: (_req, _res, next) => next() });
  const router = fresh('../src/routes/invoices.routes');
  const layer = router.stack.find((l) => l.route && l.route.path === '/number' && l.route.methods.post);
  const guard = layer.route.stack[0].handle;
  const run = (role) => { let out; guard({ user: { role } }, {}, (err) => { out = err || 'passed'; }); return out; };
  assert.equal(run('SALES_REP'), 'passed');
  assert.equal(run('WAREHOUSE_STAFF'), 'passed');
  assert.equal(run('ADMIN'), 'passed');
  assert.equal(run('SOMEONE_ELSE').statusCode, 403);
});

// ── reps-04 / ui-re01: the owner's emergency-window note never reaches a rep ─────────────────────────────
test('the rep view strips the emergency-window note and who opened it, at any depth; the owner keeps them', () => {
  const { forRole } = fresh('../src/utils/repView');
  const answer = {
    data: [{ id: 'stl1', salesRep: { id: 'r1', emergencyWindowAt: '2026-11-15', emergencyWindowReason: 'private note', emergencyWindowById: 'admin1' } }],
    user: { salesRep: { emergencyWindowReason: 'private note', emergencyWindowById: 'admin1' } },
  };
  const rep = JSON.stringify(forRole({ user: { role: 'SALES_REP' } }, answer));
  assert.doesNotMatch(rep, /emergencyWindowReason|emergencyWindowById|private note|admin1/);
  assert.match(rep, /emergencyWindowAt/, 'when it opened is his to know');
  assert.match(JSON.stringify(forRole({ user: { role: 'ADMIN' } }, answer)), /private note/);
});

// ── ui-re03: plurals and one way of writing money below zero ─────────────────────────────────────────────
test('box counts read "1 box" / "2 boxes", and WhatsApp writes money below zero as the app does', () => {
  const { boxCount, isAre } = fresh('../src/utils/words');
  assert.equal(boxCount(1), '1 box');
  assert.equal(boxCount(2), '2 boxes');
  assert.equal(boxCount(0), '0 boxes');
  assert.equal(`${boxCount(1)} ${isAre(1)}`, '1 box is');
  assert.equal(`${boxCount(3)} ${isAre(3)}`, '3 boxes are');
  const wt = fresh('../src/services/whatsappText');
  assert.equal(wt.money(-685000), '-TSh 685,000');
  assert.equal(wt.money(-0.4), 'TSh 0');
  assert.equal(wt.money(30000), 'TSh 30,000');
  const text = wt.repTexts.SETTLEMENT_APPROVED({ boxes: 1, product: 'OHIS', amount: 30000, earned: 5000, available: -685000, order: 'STL-1' });
  assert.match(text, /Available Balance: -TSh 685,000/);
});
