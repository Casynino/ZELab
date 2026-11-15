'use strict';

// ── Report windows and balances, against a REAL database (audit 15 Nov 2026) ────────────────────────────
// Read-only: it only builds report figures, it writes nothing. Run it on a copy of the business data:
//
//   REPORTS_TEST_DATABASE_URL=postgresql://localhost/zelab_copy node --test test/report-windows.db.test.js
//
//  repo01  daily reports tile time (21:00 to 21:00): ten of them add up to one report over the same 240 hours,
//          and money recorded between 21:00 and midnight is in the next day's report;
//  repo07  a report's accounts table (balances at the end of its period) adds up to its cash statement's
//          "Balance at the end", whenever the report is built;
//  sale16  the "Boxes moved" lines still add up to the window's whole movement.

const test = require('node:test');
const assert = require('node:assert');

const url = process.env.REPORTS_TEST_DATABASE_URL;
if (!url) {
  test('report windows and balances (real database)', { skip: 'set REPORTS_TEST_DATABASE_URL to a copy of the data' }, () => {});
  return;
}
process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;

const prisma = require('../src/config/prisma');
const finance = require('../src/services/finance.service');
const reportData = require('../src/services/reportData.service');
const daily = require('../src/services/dailyBusinessReport.service');
const { dayjs, eatNow } = require('../src/utils/dates');

const windowOf = (key) => daily.reportWindow(dayjs.utc(`${key}T12:00:00`).startOf('day'));
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 0.01, `${what}: ${a} vs ${b}`);

test.after(async () => { await prisma.$disconnect(); });

test('repo01: ten daily reports add up to one report over the same 240 hours', async () => {
  // the last ten finished report days
  const today = eatNow().startOf('day');
  const keys = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => today.subtract(n, 'day').format('YYYY-MM-DD'));
  const parts = await Promise.all(keys.map((k) => { const w = windowOf(k); return finance.report({ start: w.start, end: w.end }); }));
  const whole = await finance.report({ start: windowOf(keys[0]).start, end: windowOf(keys[keys.length - 1]).end });
  assert.ok(whole.revenue > 0, 'the span has sales to add up');
  const sum = (f) => parts.reduce((s, r) => s + f(r), 0);
  near(sum((r) => r.revenue), whole.revenue, 'revenue');
  near(sum((r) => r.boxesSold), whole.boxesSold, 'boxes sold');
  near(sum((r) => r.expenses), whole.expenses, 'expenses');
  near(sum((r) => r.cashFlow.moneyIn), whole.cashFlow.moneyIn, 'money in');
  near(sum((r) => r.cashFlow.moneyOut), whole.cashFlow.moneyOut, 'money out');
});

test('repo01: money recorded between 21:00 and midnight is in the next day\'s report', async (t) => {
  // the latest settlement or counter sale paid 21:00-23:59 Tanzania time (18:00-20:59 UTC; the column is UTC)
  const [row] = await prisma.$queryRaw`
    SELECT "occurredAt" FROM finance_transactions
    WHERE direction = 'IN' AND type IN ('SETTLEMENT', 'WAREHOUSE_SALE')
      AND EXTRACT(HOUR FROM "occurredAt") BETWEEN 18 AND 20
    ORDER BY "occurredAt" DESC LIMIT 1`;
  if (!row) { t.skip('no money recorded after 21:00 in this data'); return; }
  const at = new Date(row.occurredAt);
  const eatDay = dayjs.utc(at.getTime() + 3 * 3600 * 1000).format('YYYY-MM-DD');
  const next = dayjs.utc(`${eatDay}T12:00:00`).add(1, 'day').format('YYYY-MM-DD');
  assert.ok(at > windowOf(eatDay).end, 'after its own day\'s 21:00 cut-off');
  const w = windowOf(next);
  assert.ok(at >= w.start && at <= w.end, `in the ${next} report`);
  const r = await finance.report({ start: w.start, end: w.end });
  assert.ok(r.cashFlow.moneyIn > 0, 'the next report counts it');
});

test('repo07: the accounts at the end of a period add up to the cash statement\'s closing balance', async () => {
  const yesterday = eatNow().startOf('day').subtract(1, 'day').format('YYYY-MM-DD');
  const lastMonth = eatNow().startOf('month').subtract(1, 'month');
  const { eatToUtc } = require('../src/utils/dates');
  const periods = [
    windowOf(yesterday),
    { start: eatToUtc(lastMonth.startOf('month')).toDate(), end: eatToUtc(lastMonth.endOf('month')).toDate() },
  ];
  for (const p of periods) {
    const [accounts, cf] = await Promise.all([finance.accountBalances({ asOf: p.end }), finance.cashflow({ start: p.start, end: p.end })]);
    near(accounts.reduce((s, a) => s + a.balance, 0), cf.closingBalance, `balances at ${p.end.toISOString()}`);
  }
});

test('sale16: the "Boxes moved" lines add up to the window\'s whole movement', async () => {
  const today = eatNow().startOf('day');
  for (const n of [1, 2, 3, 4]) {
    const w = windowOf(today.subtract(n, 'day').format('YYYY-MM-DD'));
    const mv = await reportData.stockMovement(w.start, w.end);
    const lines = mv.stockInBoxes + mv.purchasedBoxes - mv.soldBoxes + mv.returnedBoxes + mv.cancelledBoxes + mv.adjustedBoxes;
    assert.equal(lines, mv.netMove, JSON.stringify(mv));
  }
});
