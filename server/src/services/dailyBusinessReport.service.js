'use strict';

// ===========================================================================
// DAILY BUSINESS REPORT — the 21:00 (Tanzania time) evening report.
//
// (Not to be confused with dailyReport.service.js, which holds the opening and
// closing reports the sales reps submit themselves.)
//
// Same shape as the weekly and monthly reports: a full PDF (archived for good,
// opened from a signed link) and a short WhatsApp summary with that link right
// under the header. The day is the business's day (EAT), never the server's.
// Every figure comes from the services the dashboard reads; nothing is
// recomputed here (see reportData.service.js).
//
// WHAT A DAILY REPORT COVERS (audit repo01, 15 Nov 2026): the report for day D
// runs from 21:00 on D-1 to 21:00 on D (Tanzania time) — from the cut-off of the
// report before it to the moment it is sent. It used to be the calendar day built
// at 21:00, so everything recorded from 21:00 to midnight (23% of the money in, on
// some weeks) fell into no daily report at all. Now every minute is in exactly
// one daily report, whenever the report is actually built (a late cron, the
// morning catch-up), and the text and the PDF both say which 24 hours they hold.
// ===========================================================================

const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const finance = require('./finance.service');
const reorder = require('./reorder.service');
const settlementSvc = require('./settlement.service');
const inventorySvc = require('./inventory.service');
const reportData = require('./reportData.service');
const { dayjs, eatNow, eatToUtc } = require('../utils/dates');

const fmt = (n) => `TSh ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

// The daily report is cut at 21:00 Tanzania time: the report of day D covers 21:00 on D-1 to 21:00 on D.
const CUT_OFF_HOUR = 21;
const DAY_SHIFT_MS = (24 - CUT_OFF_HOUR) * 3600 * 1000; // a moment after 21:00 belongs to the next report day

/** The 24 hours a day's report covers: [21:00 the day before, 21:00 that day), as real instants. */
function reportWindow(eatDay) {
  const cut = eatDay.startOf('day').hour(CUT_OFF_HOUR);
  const from = cut.subtract(1, 'day');
  return {
    eatFrom: from,
    eatTo: cut,
    start: eatToUtc(from).toDate(),
    end: new Date(eatToUtc(cut).valueOf() - 1), // the queries take `lte`: up to 20:59:59.999
  };
}

/** The report for one EAT day: 'YYYY-MM-DD', or today when omitted. */
async function buildDailyData(dateKey) {
  const anchor = dateKey && /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? dayjs.utc(`${dateKey}T12:00:00`) : eatNow();
  const dayStart = anchor.startOf('day');
  const day = reportWindow(dayStart);
  const before = reportWindow(dayStart.subtract(1, 'day'));
  const key = dayStart.format('YYYY-MM-DD');
  // The little chart shows this report day and the six before it, each 21:00 to 21:00.
  const chartStart = reportWindow(dayStart.subtract(6, 'day')).start;

  const [rep, accounts, accountsNow, val, low, stl, counts, suppliers, extras, movement] = await Promise.all([
    finance.report({ start: day.start, end: day.end }),
    // What each account held at the cut-off, for the PDF; the "below zero" alert reads them as they are now.
    finance.accountBalances({ asOf: day.end }),
    finance.accountBalances(),
    inventorySvc.valuation(prisma),
    reorder.lowStock(),
    settlementSvc.summary(),
    prisma.$transaction([
      prisma.stockRequest.count({ where: { status: 'PENDING' } }),
      prisma.settlementSubmission.count({ where: { status: 'PENDING' } }),
      prisma.return.count({ where: { status: 'PENDING' } }),
      prisma.settlementSubmission.count({ where: { status: 'APPROVED', decidedAt: { gte: day.start, lte: day.end } } }),
      // "Returns" and "Orders" count what the words say, like "Settlements" above: returns accepted
      // today, and orders issued today. Counting every request created also counted the cancelled
      // and rejected ones (four "orders" on a day that issued one).
      prisma.return.count({ where: { status: { in: ['APPROVED', 'COMPLETED'] }, decidedAt: { gte: day.start, lte: day.end } } }),
      prisma.settlement.count({ where: { issuedAt: { gte: day.start, lte: day.end } } }),
    ]),
    finance.supplierSummaries(),
    reportData.periodExtras({ start: day.start, end: day.end }, before, { dayWindow: { start: chartStart, end: day.end }, dayShiftMs: DAY_SHIFT_MS }),
    // the window's stock movement, for the PDF's "boxes moved" (cancelled sales netted out)
    reportData.stockMovement(day.start, day.end),
  ]);

  const supplierDue = suppliers.reduce((s, x) => s + x.outstanding, 0);
  const cashPosition = accounts.reduce((s, a) => s + a.balance, 0);
  const negAccounts = accountsNow.filter((a) => a.balance < 0);
  const pendingTotal = counts[0] + counts[1] + counts[2];

  const attention = [];
  if (pendingTotal) attention.push(`${pendingTotal} approval(s) waiting: ${counts[0]} stock request(s), ${counts[1]} settlement(s), ${counts[2]} return(s)`);
  if (stl.overdueCount) attention.push(`${stl.overdueCount} order(s) OVERDUE worth ${fmt(stl.overdueValue)}`);
  if (negAccounts.length) attention.push(`Account below zero: ${negAccounts.map((a) => a.name).join(', ')}`);
  if (low.length) attention.push(`${low.length} product(s) low on stock (${low.slice(0, 3).map((l) => l.name).join(', ')})`);
  if (supplierDue > 0) attention.push(`Owed to suppliers: ${fmt(supplierDue)}`);

  return {
    period: {
      label: dayStart.format('dddd D MMMM YYYY'),
      shortLabel: dayStart.format('D MMMM YYYY'),
      key,
      start: day.start,
      end: day.end,
      // "14 Nov 21:00 – 15 Nov 21:00": the 24 hours this report holds
      covers: `${day.eatFrom.format('D MMM HH:mm')} – ${day.eatTo.format('D MMM HH:mm')}`,
      // "from 21:00 on Friday 14 November to 21:00 on Saturday 15 November 2026"
      coversLong: `from ${day.eatFrom.format('HH:mm [on] dddd D MMMM')} to ${day.eatTo.format('HH:mm [on] dddd D MMMM YYYY')}`,
    },
    generatedAt: `${eatNow().format('D MMM YYYY, HH:mm')} EAT`,
    number: `ZL-D-${key}`,
    extras,
    finance: {
      revenue: rep.revenue,
      cogs: rep.cogs,
      grossProfit: rep.grossProfit,
      expenses: rep.expenses,
      netProfit: rep.netProfit,
      moneyIn: rep.cashFlow.moneyIn,
      moneyOut: rep.cashFlow.moneyOut,
      netCash: rep.cashFlow.net,
      boxesSold: rep.boxesSold,
    },
    brands: (rep.topBrands || []).map((b) => ({ name: b.name, revenue: b.revenue, cost: b.cost, profit: b.profit, margin: b.margin, boxes: b.boxes })),
    // the best sellers by sales value (finance.report ranks them so)
    topProducts: (rep.topProducts || []).slice(0, 5).map((p) => ({ name: p.name, revenue: p.revenue, boxes: p.boxes })),
    repPerformance: extras.reps,
    accounts: accounts.map((a) => ({ name: a.name, balance: a.balance })),
    cashPosition,
    stock: reportData.stockBlock(val, low),
    movement,
    settlements: {
      active: stl.outstandingCount,
      activeValue: stl.outstandingValue,
      overdue: stl.overdueCount,
      overdueValue: stl.overdueValue,
    },
    pending: { requests: counts[0], settlements: counts[1], returns: counts[2] },
    activity: { newOrders: counts[5], settlements: counts[3], returns: counts[4] },
    attention,
    supplierDue,
  };
}

// The WhatsApp summary: wording and the 700-character fitting live in
// whatsappText.js, which keeps the PDF link (at the foot) and drops optional
// lines first. `link` is the archived report's signed https URL, or null when
// the PDF could not be made.
function buildWhatsAppText(d, link, { late = null } = {}) {
  const f = d.finance;
  return require('./whatsappText').owner.dailyReport({
    date: d.period.shortLabel,
    covers: d.period.covers,
    late,
    sales: f.revenue,
    boxesSold: f.boxesSold,
    netProfit: f.netProfit,
    expenses: f.expenses,
    cashIn: f.moneyIn,
    cashOut: f.moneyOut,
    // The balance at the END of the period the message is labelled with, the figure its PDF's cash
    // statement ("Balance at the end") and the Cash Flow page show. It quoted the accounts at the time of
    // sending: October's report said TSh 4,548,999 while its own PDF closed October at 3,434,000, and the
    // Tuesday weekly counted Monday's money (final audit, 12 Nov 2026).
    cashBalance: d.extras?.cashStatement?.closing ?? d.cashPosition,
    orders: d.activity.newOrders,
    settlements: d.activity.settlements,
    returns: d.activity.returns,
    reps: d.extras.reps,
    stockValue: d.stock.costValue,
    stockBoxes: d.stock.units,
    alerts: d.attention.length,
    link,
  });
}

/**
 * Build, archive and send the day's report. `queue` is whatsappNotify's queue();
 * it is passed in so this file never has to require that one back.
 * If the PDF cannot be made, the summary still goes out, without a link: the
 * owner must always get the evening numbers.
 * `late`: a missed day sent the next morning (the message says so). `force` is a
 * test resend: it links to the PDF already on file and never replaces it.
 */
async function sendDailyReport({ force = false, dateKey, queue, late = false } = {}) {
  const archive = require('./reportArchive.service');
  const data = await buildDailyData(dateKey);

  let link = null;
  let archiveId = null;
  try {
    const { dailyPdf } = require('./reportPdf.service');
    const pdf = await dailyPdf(data);
    const saved = await archive.save({
      type: 'DAILY',
      periodKey: data.period.key,
      label: data.period.label,
      from: data.period.start,
      to: data.period.end,
      pdf,
      meta: { revenue: data.finance.revenue, netProfit: data.finance.netProfit, boxes: data.finance.boxesSold },
      keep: force,
    });
    archiveId = saved.id;
    link = archive.publicLink(saved.id);
  } catch (e) {
    logger.error('[daily-report] PDF failed, sending the summary without it:', e.message);
  }

  const text = buildWhatsAppText(data, link, { late: late ? new Date() : null });
  const result = await queue('DAILY_SUMMARY', {
    dedupeKey: force ? `daily:${data.period.key}:${Date.now()}` : `daily:${data.period.key}`,
    ...(archiveId ? { refType: 'ReportArchive', refId: archiveId } : {}),
    text,
  });
  return { ...result, pdf: link, archiveId, chars: text.length };
}

module.exports = { buildDailyData, buildWhatsAppText, sendDailyReport, reportWindow, CUT_OFF_HOUR };
