'use strict';

// ── Reports, schedules and WhatsApp texts (audit 15 Nov 2026) ───────────────────────────────────────
// Pinned here:
//  repo00  the owner's deadline warning is checked from the app itself, at most every 5 minutes, an hour ahead;
//  repo04  a report whose WhatsApp FAILED is sent once more by the morning catch-up, under <key>:retry;
//  repo05  a message stuck waiting (five tries used, or older than 48 hours) is closed as FAILED, one notice;
//  repo06  a rep's quota refusals raise ONE notice per rep per day, naming the rep;
//  repo08  SETTLEMENT SUBMITTED lists its products Pepa, OHIS, Civlily;
//  sale16  "Boxes moved" leaves out sales cancelled or refunded in the same window, and still adds up;
//  ui-a07  the owner's notification list names the rep a notice was written to.
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => {
  const file = require.resolve(rel);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
const fresh = (rel) => {
  delete require.cache[require.resolve(rel)];
  return require(rel);
};

// Prisma's where, just enough for the queries below (SQL null rules: NULL never matches lt/gt/in).
function matches(r, where = {}) {
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'AND') return cond.every((w) => matches(r, w));
    if (k === 'OR') return cond.some((w) => matches(r, w));
    const v = r[k] ?? null;
    if (cond === null) return v === null;
    if (typeof cond !== 'object' || cond instanceof Date) return v === cond;
    return Object.entries(cond).every(([op, x]) => {
      if (op === 'not') return x === null ? v !== null : v !== null && v !== x;
      if (v === null) return false;
      if (op === 'in') return x.includes(v);
      if (op === 'notIn') return !x.includes(v);
      if (op === 'lt') return v < x;
      if (op === 'gt') return v > x;
      if (op === 'startsWith') return String(v).startsWith(x);
      throw new Error(`stub: no operator ${op}`);
    });
  });
}

const OWNER = { 'whatsapp.phone': '+255700000001', 'whatsapp.apikey': 'k' };

function loadNotify({ rows = [], settings = OWNER, notices = [], settlements = [] } = {}) {
  const calls = { admins: [], created: [], settlementWhere: null, fetches: [] };
  stub('../src/config/prisma', {
    setting: { findUnique: async ({ where }) => (where.key in settings ? { key: where.key, value: settings[where.key] } : null) },
    whatsAppNotification: {
      findMany: async ({ where, take } = {}) => {
        const hit = rows.filter((r) => matches(r, where));
        return take ? hit.slice(0, take) : hit;
      },
      findFirst: async ({ where }) => rows.find((r) => matches(r, where)) || null,
      findUnique: async ({ where }) => rows.find((r) => r.id === where.id || r.dedupeKey === where.dedupeKey) || null,
      count: async () => 0,
      groupBy: async () => [],
      create: async ({ data }) => {
        if (data.dedupeKey && rows.some((r) => r.dedupeKey === data.dedupeKey)) { const e = new Error('dup'); e.code = 'P2002'; throw e; }
        const row = { id: `new${rows.length}`, status: 'PENDING', attempts: 0, lastAttemptAt: null, createdAt: new Date(), toPhone: null, ...data };
        rows.push(row);
        calls.created.push(row);
        return row;
      },
      updateMany: async ({ where, data }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
      update: async ({ where, data }) => Object.assign(rows.find((r) => r.id === where.id), data),
    },
    notification: { findFirst: async ({ where }) => notices.find((n) => n.entityId === where.entityId) || null },
    salesRepresentative: { findFirst: async () => ({ code: 'KP', user: { name: 'Kassim' } }) },
    settlement: { findMany: async ({ where }) => { calls.settlementWhere = where; return settlements; } },
    return: { count: async () => 0 },
  });
  stub('../src/services/notification.service', {
    notifyAdmins: async (d) => { calls.admins.push(d); notices.push({ entityId: d.entityId }); return d; },
    createIfAbsent: async () => ({}),
  });
  stub('../src/services/penalty.service', { dailyRateFor: () => 10000 });
  global.fetch = async (url) => { calls.fetches.push(url); return { ok: true, status: 200, text: async () => 'Message queued' }; };
  return { wa: fresh('../src/services/whatsappNotify.service'), calls, rows };
}

// ── repo00 ─────────────────────────────────────────────────────────────────────────────────────────
test('repo00: signed-in traffic runs the deadline check at most once every 5 minutes, looking an hour ahead', async () => {
  const { wa, calls } = loadNotify();
  const t0 = Date.now();
  assert.equal(wa.dueChecksSoon(t0), true);
  assert.equal(wa.dueChecksSoon(t0 + 60 * 1000), false, 'a minute later: not again');
  assert.equal(wa.dueChecksSoon(t0 + 4 * 60 * 1000), false);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls.settlementWhere, 'the deadline query ran');
  const { gt, lte } = calls.settlementWhere.deadlineAt;
  assert.equal(Math.round((lte - gt) / 60000), 60, 'warns up to an hour before the deadline');
  assert.equal(wa.DEADLINE_WARN_MINUTES, 60);
  assert.equal(wa.dueChecksSoon(t0 + 5 * 60 * 1000), true, 'five minutes on: due again');
});

test('repo00: every signed-in request starts the due checks, and a failure there never fails the request', async () => {
  let started = 0;
  stub('../src/config/prisma', {
    user: { findUnique: async () => ({ id: 'a1', isActive: true, sessionVersion: 0, role: { name: 'ADMIN', permissions: [] }, salesRep: null }) },
  });
  stub('../src/utils/tokens', { verifyAccessToken: () => ({ sub: 'a1', sv: 0 }) });
  stub('../src/utils/device', { assertDeviceAllowed: () => {} });
  stub('../src/services/whatsappNotify.service', { dueChecksSoon: () => { started += 1; throw new Error('scheduler broke'); } });
  const { authenticate } = fresh('../src/middleware/auth');
  const req = { headers: { authorization: 'Bearer t' } };
  const err = await new Promise((resolve) => { authenticate(req, {}, (e) => resolve(e || null)); });
  assert.equal(err, null, 'the request goes on');
  assert.equal(req.user.id, 'a1');
  assert.equal(started, 1);
  delete require.cache[require.resolve('../src/services/whatsappNotify.service')];
  delete require.cache[require.resolve('../src/utils/tokens')];
  delete require.cache[require.resolve('../src/utils/device')];
});

// ── repo04 ─────────────────────────────────────────────────────────────────────────────────────────
test('repo04: a report whose WhatsApp failed is sent once more under <key>:retry, with its own text and PDF', async () => {
  const { dayjs } = require('../src/utils/dates');
  const failed = { id: 'd10', type: 'DAILY_SUMMARY', priority: 'INFO', dedupeKey: 'daily:2026-11-10', status: 'FAILED', attempts: 5, refType: 'ReportArchive', refId: 'arch10', text: '*ZELAB — DAILY REPORT*\n10 November 2026', createdAt: new Date(), toPhone: null };
  const sentOk = (key, type) => ({ id: key, type, dedupeKey: key, status: 'SENT', attempts: 1, createdAt: new Date(), toPhone: null });
  const sent = { daily: 0 };
  stub('../src/services/dailyBusinessReport.service', { sendDailyReport: async () => { sent.daily += 1; return {}; } });
  stub('../src/services/weeklyReport.service', { REPORT_WEEKDAY: 2, weekKeyOf: () => '2026-W45', sendWeeklyReport: async () => ({}) });
  stub('../src/services/monthlyReport.service', { sendMonthlyReport: async () => ({}) });
  const { wa, rows, calls } = loadNotify({ rows: [failed, sentOk('weekly:2026-W45', 'WEEKLY_REPORT'), sentOk('monthly:2026-10', 'MONTHLY_REPORT')] });
  const r = await wa.catchUpReports(dayjs.utc('2026-11-11T09:00:00'));
  assert.equal(sent.daily, 0, 'the report on file is not rebuilt');
  assert.equal(r.daily.resent, true);
  const retry = rows.find((x) => x.dedupeKey === 'daily:2026-11-10:retry');
  assert.ok(retry, 'the resend is on record under its own key');
  assert.equal(retry.text, failed.text);
  assert.equal(retry.refId, 'arch10');
  assert.equal(calls.fetches.length, 1, 'and it went to the provider');
  // the next morning: already resent, nothing more
  const again = await wa.catchUpReports(dayjs.utc('2026-11-11T09:00:00'));
  assert.deepEqual(again.daily, { key: '2026-11-10', missing: false });
  assert.equal(calls.fetches.length, 1);
  // a report that went out is left alone, as before
  assert.deepEqual(r.weekly, { key: '2026-W45', missing: false });
});

// ── repo05 ─────────────────────────────────────────────────────────────────────────────────────────
test('repo05: rows flush() will never send again are closed as FAILED, and the owner is told once for all of them', async () => {
  const now = Date.now();
  const hour = 3600 * 1000;
  const base = { priority: 'INFO', status: 'PENDING', toPhone: null };
  const rows = [
    { ...base, id: 'july', type: 'MONTHLY_REPORT', dedupeKey: 'monthly:2026-07', attempts: 5, lastAttemptAt: new Date(now - 100 * 24 * hour), createdAt: new Date(now - 100 * 24 * hour) },
    { ...base, id: 'old', type: 'REP_ALERT', dedupeKey: 'r1', attempts: 0, lastAttemptAt: null, createdAt: new Date(now - 50 * hour) },
    { ...base, id: 'busy', type: 'REP_ALERT', dedupeKey: 'r2', attempts: 5, lastAttemptAt: new Date(now - 2 * 60 * 1000), createdAt: new Date(now - hour) }, // being sent now
    { ...base, id: 'fresh', type: 'REP_ALERT', dedupeKey: 'r3', attempts: 1, lastAttemptAt: new Date(now - 60 * 1000), createdAt: new Date(now - hour) },
  ];
  const { wa, calls } = loadNotify({ rows });
  const r = await wa.flush({ throttleMs: 0 });
  assert.equal(r.failedStale, 2);
  assert.equal(rows.find((x) => x.id === 'july').status, 'FAILED');
  assert.match(rows.find((x) => x.id === 'july').lastError, /all 5 tries/);
  assert.equal(rows.find((x) => x.id === 'old').status, 'FAILED');
  assert.match(rows.find((x) => x.id === 'old').lastError, /more than 48 hours/);
  assert.equal(rows.find((x) => x.id === 'busy').status, 'PENDING', 'a row tried minutes ago is left alone');
  assert.equal(rows.find((x) => x.id === 'fresh').status, 'PENDING');
  assert.equal(calls.admins.length, 1, 'one notice for the lot');
  assert.match(calls.admins[0].title, /^2 WhatsApp messages were never delivered$/);
});

// ── repo06 ─────────────────────────────────────────────────────────────────────────────────────────
test('repo06: a rep\'s quota refusals raise one notice per rep per day, naming the rep; the owner\'s own stay as they were', async () => {
  const { wa, calls } = loadNotify();
  const repRow = (id) => ({ id, type: 'REP_ALERT', toPhone: '+255700000002', refType: 'SalesRepresentative', refId: 'sr1' });
  for (const id of ['a', 'b', 'c']) await wa._failureAlert(repRow(id), { quotaExhausted: true });
  assert.equal(calls.admins.length, 1);
  assert.equal(calls.admins[0].title, 'Kassim\'s WhatsApp quota is used up — their alerts are not delivered');
  assert.ok(!/NOT being delivered/.test(calls.admins[0].title));
  // the owner's failed report: its own notice, saying where the report is
  await wa._failureAlert({ id: 'd', type: 'DAILY_SUMMARY', toPhone: null, dedupeKey: 'daily:2026-11-10' }, { attempts: 5 });
  assert.equal(calls.admins.length, 2);
  assert.equal(calls.admins[1].title, 'WhatsApp notification failed');
  assert.match(calls.admins[1].message, /Profile → Reports/);
  assert.match(calls.admins[1].message, /09:00 check sends the WhatsApp once more/);
  // the owner's quota: once a day
  await wa._failureAlert({ id: 'o1', type: 'STOCK_REQUEST', toPhone: null }, { quotaExhausted: true });
  await wa._failureAlert({ id: 'o2', type: 'STOCK_REQUEST', toPhone: null }, { quotaExhausted: true });
  assert.equal(calls.admins.length, 3);
  assert.equal(calls.admins[2].title, 'WhatsApp quota exhausted — messages are NOT being delivered');
});

// ── repo08 ─────────────────────────────────────────────────────────────────────────────────────────
test('repo08: SETTLEMENT SUBMITTED with several products lists them Pepa, OHIS, Civlily, whatever order they came in', () => {
  const t = require('../src/services/whatsappText');
  const text = t.owner.settlementSubmitted({
    by: 'Paul', order: 'STL-20261115-0001',
    items: [{ product: 'Civlily Ndogo (Brown) Bila Filter', boxes: 2 }, { product: 'OHIS Ndogo (Brown) Bila Filter', boxes: 3 }, { product: 'Pepa Ndogo (Brown) Bila Filter', boxes: 1 }],
    payments: [{ method: 'M-Pesa', amount: 1 }],
  });
  assert.match(text, /\(1\) Pepa Ndogo \(Brown\) Bila Filter\nBoxes Sold: 1\n\n\(2\) OHIS Ndogo \(Brown\) Bila Filter\nBoxes Sold: 3\n\n\(3\) Civlily Ndogo \(Brown\) Bila Filter\nBoxes Sold: 2/);
});

// ── repo02 ─────────────────────────────────────────────────────────────────────────────────────────
test('repo02: the reports say the top product is ranked by sales', () => {
  const t = require('../src/services/whatsappText');
  const d = { period: 'October 2026', revenue: 1, netProfit: 1, expenses: 1, cashBalance: 1, topProduct: { name: 'Civlily Ndogo (Brown) Bila Filter', revenue: 2275000 }, stockValue: 1, stockBoxes: 1, alerts: 0 };
  assert.match(t.owner.monthlyReport(d), /\nTop Product by Sales: Civlily Ndogo \(Brown\) Bila Filter — TSh 2,275,000\n/);
  const { inShort } = require('../src/services/reportPdf.service');
  const lines = inShort({
    finance: { revenue: 100, netProfit: 1, expenses: 0, moneyIn: 0, moneyOut: 0, boxesSold: 3 },
    extras: { orders: 1, prev: null, byDay: [], reps: [], cashStatement: { closing: 3441000 } },
    brands: [],
    // handed over in profit order: the line must still pick the best seller
    topProducts: [{ name: 'OHIS', revenue: 40, boxes: 1 }, { name: 'Civlily', revenue: 60, boxes: 2 }],
    cashPosition: 999,
  }, { compare: 'the month before' });
  assert.ok(lines.includes('Top product by sales: Civlily, TSh 60 from 2 boxes.'), lines.join('\n'));
  // repo07: the balance at the END of the period, not when the PDF was built
  assert.ok(lines.includes('TSh 3,441,000 was held across the business accounts at the end of the period.'), lines.join('\n'));
});

// ── sale16 ─────────────────────────────────────────────────────────────────────────────────────────
test('sale16: "Boxes moved" leaves out sales cancelled or refunded in the window, keeps earlier ones apart, and still adds up', async () => {
  // In the window: sale s1 (5 boxes) made and cancelled; s2 (4 boxes) made, 1 refunded; s3 made before the
  // window and cancelled in it (3 back); a stock count -2.
  const byType = [
    { type: 'CASH_SALE', _sum: { baseQuantity: -9 } },
    { type: 'CORRECTION', _sum: { baseQuantity: 5 + 3 } },
    { type: 'CUSTOMER_RETURN', _sum: { baseQuantity: 1 } },
    { type: 'STOCK_COUNT', _sum: { baseQuantity: -2 } },
  ];
  const putBack = [
    { type: 'CORRECTION', baseQuantity: 5, referenceId: 's1' },
    { type: 'CUSTOMER_RETURN', baseQuantity: 1, referenceId: 's2' },
    { type: 'CORRECTION', baseQuantity: 3, referenceId: 's3' },
  ];
  stub('../src/config/prisma', {
    inventoryTransaction: { groupBy: async () => byType, findMany: async () => putBack },
    sale: { findMany: async ({ where }) => ['s1', 's2'].filter((id) => where.id.in.includes(id)).map((id) => ({ id })) },
  });
  stub('../src/services/finance.service', {});
  stub('../src/services/reports.service', {});
  const reportData = fresh('../src/services/reportData.service');
  const mv = await reportData.stockMovement(new Date('2026-11-11T18:00:00Z'), new Date('2026-11-12T17:59:59.999Z'));
  assert.equal(mv.soldBoxes, 3, 's1 never sold, s2 sold 4 less the 1 refunded');
  assert.equal(mv.returnedBoxes, 0, 'the refund is in "Sold", not a customer return');
  assert.equal(mv.cancelledBoxes, 3, 'an earlier sale cancelled has its own line');
  assert.equal(mv.adjustedBoxes, -2, 'the cancellations are not adjustments');
  const lines = mv.stockInBoxes + mv.purchasedBoxes - mv.soldBoxes + mv.returnedBoxes + mv.cancelledBoxes + mv.adjustedBoxes;
  assert.equal(lines, mv.netMove, 'the lines add up to the whole movement');
  assert.equal(mv.netMove, -9 + 8 + 1 - 2);
});

// ── ui-a07 ─────────────────────────────────────────────────────────────────────────────────────────
test('ui-a07: the owner\'s list names the rep a notice was written to; a rep\'s own list is unchanged', async () => {
  const rows = [
    { id: 'n1', title: 'Your return of 1 box(es) has been approved', userId: 'rep-user', user: { id: 'rep-user', name: 'Paul', role: { name: 'SALES_REP' } } },
    { id: 'n2', title: 'Withdrawal requested', userId: null, user: null },
    { id: 'n3', title: 'Mine', userId: 'admin-1', user: { id: 'admin-1', name: 'Nino', role: { name: 'ADMIN' } } },
  ];
  const asked = [];
  stub('../src/config/prisma', {
    notification: {
      findMany: async (args) => { asked.push(args); return args.include ? rows : rows.map(({ user, ...n }) => n); },
      count: async () => rows.length,
    },
  });
  const svc = fresh('../src/services/notification.service');
  const page = { skip: 0, take: 25 };
  const admin = await svc.list({ id: 'admin-1', role: 'ADMIN' }, {}, page);
  assert.deepEqual(admin.items.map((n) => n.recipient), [{ name: 'Paul', role: 'SALES_REP' }, null, null]);
  assert.ok(admin.items.every((n) => !('user' in n)), 'only the name and role go out');
  const rep = await svc.list({ id: 'rep-user', role: 'SALES_REP' }, {}, page);
  assert.equal(asked[1].include, undefined, 'a rep\'s list reads no one else\'s name');
  assert.ok(rep.items.every((n) => !('recipient' in n)));
});
