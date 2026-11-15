'use strict';

// ── Faster reads, same answers (15 Nov 2026) ──────────────────────────────────────────────────────────
// Pinned here (stubbed database; the SQL itself is run on a real copy in speed-ledger-gaps.db.test.js):
//   - the sign-in check is one statement and still refuses a deactivated user / an old session;
//     if that statement cannot run, the old step-by-step read answers instead;
//   - the deployed app asks for 10 pooled connections, never on a direct address, never over the owner's value;
//   - the fine sweep only locks orders that can owe a new day, and the read paths share one sweep a minute;
//   - Finance runs the full ledger self-heal only when the one-statement check finds a gap (or cannot run);
//   - every rep's fines come from one set of reads and land on the right rep.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub@localhost:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only';

const stub = (rel, exports) => {
  const f = require.resolve(rel);
  require.cache[f] = { id: f, filename: f, loaded: true, exports };
};
const fresh = (rel) => {
  delete require.cache[require.resolve(rel)];
  return require(rel);
};

function db(tables = {}, extra = {}) {
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    count: async () => 0, groupBy: async () => [], aggregate: async () => ({ _sum: {}, _count: 0 }),
    create: async () => ({}), update: async () => ({}),
  };
  return new Proxy({}, {
    get(_t, name) {
      if (name === 'then') return undefined;
      if (name in extra) return extra[name];
      return { ...empty, ...(tables[name] || {}) };
    },
  });
}

stub('../src/services/notification.service', { notifyUser: async () => {}, notifyAdmins: async () => {}, createIfAbsent: async () => {} });

// ── Sign-in check ────────────────────────────────────────────────────────────────────────────────────
const { signAccessToken } = (() => {
  try { return require('../src/utils/tokens'); } catch { return {}; }
})();

function runAuth(authenticate, token, ua = 'curl') {
  return new Promise((resolve) => {
    const req = { headers: { authorization: `Bearer ${token}`, 'user-agent': ua } };
    authenticate(req, {}, (err) => resolve({ err, user: req.user }));
  });
}

test('the sign-in check reads the user, role, permissions and rep profile in one statement', async (t) => {
  if (typeof signAccessToken !== 'function') return t.skip('no token helper');
  const row = {
    id: 'u1', name: 'Owner', email: 'o@x', roleId: 'role-admin', warehouseId: null, isActive: true, sessionVersion: 3,
    roleName: 'ADMIN', salesRepId: null, salesRepActive: null, permissions: ['report:view', 'product:create'],
  };
  const raw = [];
  let stepByStep = 0;
  stub('../src/config/prisma', db({ user: { findUnique: async () => { stepByStep += 1; return null; } } }, {
    $queryRaw: async (strings, ...values) => { raw.push(values); return [{ ...row }]; },
  }));
  const { authenticate } = fresh('../src/middleware/auth');

  const ok = await runAuth(authenticate, signAccessToken({ sub: 'u1', sv: 3 }));
  assert.equal(ok.err, undefined);
  assert.deepEqual(ok.user, {
    id: 'u1', name: 'Owner', email: 'o@x', roleId: 'role-admin', role: 'ADMIN',
    permissions: ['report:view', 'product:create'], warehouseId: null, salesRepId: null,
  });
  assert.equal(raw.length, 1, 'one statement');
  assert.deepEqual(raw[0], ['u1'], 'the id is a bound value, never pasted into the SQL');
  assert.equal(stepByStep, 0);

  // A password change bumps the session version: the old token stops at once.
  const old = await runAuth(authenticate, signAccessToken({ sub: 'u1', sv: 2 }));
  assert.equal(old.err.statusCode, 401);
  // A deactivated account stops at once.
  row.isActive = false;
  const off = await runAuth(authenticate, signAccessToken({ sub: 'u1', sv: 3 }));
  assert.equal(off.err.statusCode, 401);
});

test('a suspended rep is refused; a rep with no profile is refused', async (t) => {
  if (typeof signAccessToken !== 'function') return t.skip('no token helper');
  const phone = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
  const row = {
    id: 'u2', name: 'Rep', email: 'r@x', roleId: 'role-rep', warehouseId: null, isActive: true, sessionVersion: 0,
    roleName: 'SALES_REP', salesRepId: 'rep-1', salesRepActive: true, permissions: [],
  };
  stub('../src/config/prisma', db({}, { $queryRaw: async () => [{ ...row }] }));
  const { authenticate } = fresh('../src/middleware/auth');
  const ok = await runAuth(authenticate, signAccessToken({ sub: 'u2', sv: 0 }), phone);
  assert.equal(ok.err, undefined);
  assert.equal(ok.user.salesRepId, 'rep-1');
  row.salesRepActive = false;
  assert.equal((await runAuth(authenticate, signAccessToken({ sub: 'u2', sv: 0 }), phone)).err.statusCode, 401);
  Object.assign(row, { salesRepId: null, salesRepActive: null });
  assert.equal((await runAuth(authenticate, signAccessToken({ sub: 'u2', sv: 0 }), phone)).err.statusCode, 403);
});

test('if the one-statement read cannot run, the step-by-step read answers and nobody is locked out', async (t) => {
  if (typeof signAccessToken !== 'function') return t.skip('no token helper');
  let rawCalls = 0;
  stub('../src/config/prisma', db({
    user: {
      findUnique: async () => ({
        id: 'u1', name: 'Owner', email: 'o@x', roleId: 'role-admin', warehouseId: null, isActive: true, sessionVersion: 0,
        role: { name: 'ADMIN', permissions: [{ key: 'report:view' }] }, salesRep: null,
      }),
    },
  }, { $queryRaw: async () => { rawCalls += 1; throw Object.assign(new Error('column does not exist'), { code: 'P2010' }); } }));
  t.mock.method(console, 'warn', () => {});
  const { authenticate } = fresh('../src/middleware/auth');
  const a = await runAuth(authenticate, signAccessToken({ sub: 'u1', sv: 0 }));
  assert.equal(a.err, undefined);
  assert.deepEqual(a.user.permissions, ['report:view']);
  await runAuth(authenticate, signAccessToken({ sub: 'u1', sv: 0 }));
  assert.equal(rawCalls, 1, 'a statement that does not fit the schema is not tried again on every request');
});

// ── Pool size ────────────────────────────────────────────────────────────────────────────────────────
test('the deployed app asks for 10 pooled connections; local, direct and owner-set addresses are left alone', () => {
  const { datasourceUrl } = fresh('../src/config/databaseUrl');
  const pooled = 'postgresql://u:p%40ss@ep-x-pooler.eu-central-1.aws.neon.tech/db?sslmode=require&pgbouncer=true&connect_timeout=15';
  assert.equal(datasourceUrl(pooled, { VERCEL: '1' }), `${pooled}&connection_limit=10`);
  assert.equal(datasourceUrl(pooled, { NODE_ENV: 'production' }), `${pooled}&connection_limit=10`);
  assert.equal(datasourceUrl(pooled, { VERCEL: '1', PRISMA_CONNECTION_LIMIT: '15' }), `${pooled}&connection_limit=15`);
  assert.equal(datasourceUrl(pooled, { NODE_ENV: 'development' }), pooled, 'local runs keep Prisma\'s default');
  const own = `${pooled}&connection_limit=4`;
  assert.equal(datasourceUrl(own, { VERCEL: '1' }), own, 'a value in the address always wins');
  const direct = 'postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/db?sslmode=require';
  assert.equal(datasourceUrl(direct, { VERCEL: '1' }), direct, 'a direct address opens real Postgres connections: untouched');
  const poolerHostOnly = 'postgresql://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/db';
  assert.equal(datasourceUrl(poolerHostOnly, { VERCEL: '1' }), `${poolerHostOnly}?connection_limit=10`);
  assert.equal(datasourceUrl('', { VERCEL: '1' }), '', 'no address: nothing invented');
});

// ── Fine sweep: check first, lock second ─────────────────────────────────────────────────────────────
const HOUR = 3600 * 1000;
function sweepWorld({ orders, charged = {}, paused = [] }) {
  const locked = [];
  const created = [];
  const tx = {
    $queryRaw: async () => [],
    return: { count: async ({ where }) => (paused.includes(where.settlementId) ? 1 : 0) },
    settlement: { findUnique: async ({ where }) => orders.find((o) => o.id === where.id) },
    settlementPenalty: {
      count: async ({ where }) => charged[where.settlementId] || 0,
      create: async ({ data }) => { created.push(data); charged[data.settlementId] = (charged[data.settlementId] || 0) + 1; return data; },
    },
  };
  stub('../src/services/settlement.service', { lockOrder: async (_tx, id) => { locked.push(id); } });
  stub('../src/config/prisma', db({
    settlement: { findMany: async () => orders.map((o) => ({ ...o, salesRep: { user: { id: 'u', name: 'Rep' } } })) },
    settlementPenalty: {
      groupBy: async ({ where }) => where.settlementId.in.filter((id) => charged[id]).map((id) => ({ settlementId: id, _count: charged[id] })),
    },
    return: { groupBy: async ({ where }) => where.settlementId.in.filter((id) => paused.includes(id)).map((id) => ({ settlementId: id, _count: 1 })) },
  }, { $transaction: async (fn) => fn(tx) }));
  return { svc: fresh('../src/services/penalty.service'), locked, created };
}

test('the fine sweep locks only orders that can owe a new day, and still charges every day owed', async () => {
  const now = Date.now();
  const orders = [
    // Due 30 h ago: owes 2 days, both charged already. Nothing to do: no lock.
    { id: 'paid-up', status: 'OVERDUE', deadlineAt: new Date(now - 30 * HOUR), penaltyFrom: null, selfExtendedAt: null, settlementNumber: 'S1', salesRepId: 'r1' },
    // Due 50 h ago: owes 3 days, 1 charged. Locked, days 2 and 3 charged.
    { id: 'behind', status: 'OVERDUE', deadlineAt: new Date(now - 50 * HOUR), penaltyFrom: null, selfExtendedAt: null, settlementNumber: 'S2', salesRepId: 'r1' },
    // A return is waiting: the clock is paused. No lock.
    { id: 'paused', status: 'OVERDUE', deadlineAt: new Date(now - 50 * HOUR), penaltyFrom: null, selfExtendedAt: null, settlementNumber: 'S3', salesRepId: 'r2' },
    // Time was taken back: the fine clock starts in an hour. No lock.
    { id: 'later', status: 'OPEN', deadlineAt: new Date(now - 5 * HOUR), penaltyFrom: new Date(now + HOUR), selfExtendedAt: null, settlementNumber: 'S4', salesRepId: 'r2' },
    // Never fined yet: owes day 1. Locked.
    { id: 'new', status: 'OPEN', deadlineAt: new Date(now - HOUR), penaltyFrom: null, selfExtendedAt: new Date(now - 200 * HOUR), settlementNumber: 'S5', salesRepId: 'r3' },
  ];
  const { svc, locked, created } = sweepWorld({ orders, charged: { 'paid-up': 2, behind: 1 }, paused: ['paused'] });
  const r = await svc.applyDuePenalties();
  assert.deepEqual(locked.sort(), ['behind', 'new']);
  assert.equal(r.applied, 3);
  assert.deepEqual(created.filter((c) => c.settlementId === 'behind').map((c) => c.daysOverdue), [2, 3]);
  const first = created.find((c) => c.settlementId === 'new');
  assert.equal(first.daysOverdue, 1);
  assert.equal(first.amount, 20000, 'an extended order is charged the extended rate');

  // Run again straight away: nothing is owed, nothing is locked.
  locked.length = 0;
  const again = await svc.applyDuePenalties();
  assert.equal(again.applied, 0);
  assert.deepEqual(locked, []);
});

test('Home polls share one fine sweep a minute; the morning check and "apply now" are never held back', async () => {
  let runs = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  stub('../src/services/settlement.service', { lockOrder: async () => {} });
  stub('../src/config/prisma', db({
    settlement: { findMany: async () => { runs += 1; await gate; return []; } },
  }));
  const svc = fresh('../src/services/penalty.service');
  const a = svc.applyDuePenaltiesFromRead();
  const b = svc.applyDuePenaltiesFromRead();
  assert.equal(a, b, 'a poll that arrives during a sweep waits for that sweep');
  release();
  await a;
  const c = await svc.applyDuePenaltiesFromRead();
  assert.equal(c.skipped, true, 'a poll within the minute does not start another');
  assert.equal(runs, 1);
  await svc.applyDuePenalties();
  assert.equal(runs, 2, 'the cron and the admin button always run');
});

// ── Finance ledger self-heal ─────────────────────────────────────────────────────────────────────────
function financeWorld(answer) {
  const counts = { pass: 0, check: 0 };
  stub('../src/services/reports.service', { financeEpoch: async () => new Date('2026-07-05T09:36:54Z') });
  stub('../src/config/prisma', db({
    businessAccount: { count: async () => 1, findFirst: async () => null },
    expenseCategory: { count: async () => 1 },
    sale: { findMany: async () => { counts.pass += 1; return []; } },
  }, {
    $queryRaw: async () => { counts.check += 1; if (answer instanceof Error) throw answer; return [answer]; },
  }));
  return { finance: fresh('../src/services/finance.service'), counts };
}

test('Finance runs the full ledger self-heal only when the check finds a gap, or cannot run', async () => {
  const none = { missingIncome: false, untaggedIncome: false, missingPayout: false };
  const healed = financeWorld(none);
  assert.deepEqual(await healed.finance.healLedgerOnRead(), { skipped: true });
  assert.equal(healed.counts.check, 1);
  assert.equal(healed.counts.pass, 0, 'nothing missing: the history is not read');

  for (const gap of ['missingIncome', 'untaggedIncome', 'missingPayout']) {
    const w = financeWorld({ ...none, [gap]: true });
    await w.finance.healLedgerOnRead();
    // No default account in this stub, so the pass stops after its setup; it was still started.
    assert.equal(w.counts.check, 1, gap);
  }
  const broken = financeWorld(new Error('relation does not exist'));
  await broken.finance.healLedgerOnRead();
  assert.equal(broken.counts.check, 1, 'a check that cannot run falls back to the full pass, as before');
});

test('the full pass starts when a gap is found', async () => {
  const counts = { pass: 0 };
  stub('../src/services/reports.service', { financeEpoch: async () => null });
  stub('../src/config/prisma', db({
    businessAccount: {
      count: async () => 1,
      findFirst: async () => ({ id: 'acc-1', name: 'Cash', isActive: true }),
    },
    expenseCategory: { count: async () => 1 },
    sale: { findMany: async () => { counts.pass += 1; return []; } },
  }, { $queryRaw: async () => [{ missingIncome: true, untaggedIncome: false, missingPayout: false }] }));
  const finance = fresh('../src/services/finance.service');
  await finance.healLedgerOnRead();
  assert.equal(counts.pass, 1);
});

// ── Fines for many reps at once ──────────────────────────────────────────────────────────────────────
test('every rep\'s fines come from one set of reads and each lands on its own rep', async () => {
  const rows = [
    { salesRepId: 'r1', settlementId: 's1', amount: 10000, daysOverdue: 1, kind: 'LATE_FINE', status: 'APPLIED' },
    { salesRepId: 'r1', settlementId: 's1', amount: 10000, daysOverdue: 2, kind: 'LATE_FINE', status: 'APPLIED' },
    { salesRepId: 'r2', settlementId: 's2', amount: 20000, daysOverdue: 1, kind: 'LATE_FINE', status: 'APPLIED' },
    { salesRepId: 'r2', settlementId: null, amount: 5000, daysOverdue: 0, kind: 'ADJUSTMENT', status: 'APPLIED' },
  ];
  let reads = 0;
  const group = ({ by, where, _sum, _count, _max }) => {
    reads += 1;
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
    settlementPenalty: { groupBy: async (a) => group(a) },
    settlement: {
      findMany: async () => [
        { id: 's1', settlementNumber: 'STL-1', status: 'SETTLED', selfExtendedAt: null },
        { id: 's2', settlementNumber: 'STL-2', status: 'OVERDUE', selfExtendedAt: new Date() },
      ],
    },
    return: { groupBy: async () => [] },
  }));
  const svc = fresh('../src/services/penalty.service');
  const out = await svc.penaltyBreakdownForReps(['r1', 'r2', 'r3']);
  assert.equal(reads, 2, 'two grouped reads, whatever the number of reps');
  assert.equal(out.get('r1').total, 20000);
  assert.deepEqual(out.get('r1').breakdown.map((b) => [b.settlementNumber, b.fines, b.daysOverdue, b.penaltyPerDay]), [['STL-1', 2, 2, 10000]]);
  assert.equal(out.get('r2').total, 25000);
  assert.deepEqual(out.get('r2').breakdown.map((b) => [b.settlementNumber, b.totalPenalty, b.penaltyPerDay]), [['STL-2', 20000, 20000], ['Manual deduction', 5000, null]]);
  assert.deepEqual(out.get('r3'), { total: 0, breakdown: [] }, 'a rep with no fines is answered too');
  assert.deepEqual(await svc.penaltyBreakdownForRep('r2'), out.get('r2'), 'one rep reads the same way');
});
