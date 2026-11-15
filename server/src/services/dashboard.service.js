'use strict';

const prisma = require('../config/prisma');
const inventory = require('./inventory.service');
const credit = require('./credit.service');
const reports = require('./reports.service');
const profitMath = require('../utils/profitMath');
const reorder = require('./reorder.service');
const stockCount = require('./stockCount.service');
const settlement = require('./settlement.service');
const { toNumber, round2 } = require('../utils/money');
const { resolveRange } = require('../utils/dates');
const { mergeRegionRevenue } = require('../constants/regions');

async function periodSales(period) {
  const r = await reports.salesReport({ period });
  return { revenue: r.totals.revenue, profit: r.totals.grossProfit, orders: r.totals.orders };
}

// Money windows on the dashboard start at the finance epoch — pre-go-live
// activity stays in the database but never counts as money.
async function epochRange(period) {
  const range = resolveRange({ period });
  const epoch = await reports.financeEpoch();
  if (epoch && range.start < epoch) return { ...range, start: epoch };
  return range;
}

async function paymentsCollected(period) {
  const range = await epochRange(period);
  const [credits, cash] = await Promise.all([
    prisma.creditPayment.aggregate({
      where: { paidAt: { gte: range.start, lte: range.end } },
      _sum: { amount: true },
    }),
    prisma.sale.aggregate({
      where: { type: 'CASH', status: { not: 'CANCELLED' }, soldAt: { gte: range.start, lte: range.end } },
      _sum: { amountPaid: true },
    }),
  ]);
  return {
    creditPayments: round2(toNumber(credits._sum.amount)),
    cashCollected: round2(toNumber(cash._sum.amountPaid)),
    total: round2(toNumber(credits._sum.amount) + toNumber(cash._sum.amountPaid)),
  };
}

// Reps still holding stock — "outstanding salesperson stock" alert source.
async function outstandingRepStock() {
  const rows = await inventory.repBalances(prisma);
  const positive = rows.filter((r) => r.baseQuantity > 0);
  const byRep = new Map();
  positive.forEach((r) => byRep.set(r.salesRepId, (byRep.get(r.salesRepId) || 0) + r.baseQuantity));

  const reps = await prisma.salesRepresentative.findMany({
    where: { id: { in: [...byRep.keys()] } },
    include: { user: { select: { name: true } } },
  });
  return reps
    .map((rep) => ({
      salesRepId: rep.id,
      name: rep.user?.name,
      code: rep.code,
      region: rep.region,
      heldBaseUnits: byRep.get(rep.id) || 0,
    }))
    .sort((a, b) => b.heldBaseUnits - a.heldBaseUnits);
}

async function recentActivity(limit = 12) {
  const rows = await prisma.inventoryTransaction.findMany({
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: {
      product: { select: { name: true } },
      packagingUnit: { select: { name: true } },
      warehouse: { select: { name: true } },
      salesRep: { include: { user: { select: { name: true } } } },
      user: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    product: r.product.name,
    quantity: r.quantity,
    unit: r.packagingUnit?.name,
    baseQuantity: r.baseQuantity,
    location: r.locationType === 'WAREHOUSE' ? r.warehouse?.name : r.salesRep?.user?.name,
    by: r.user?.name,
    at: r.createdAt,
    notes: r.notes,
  }));
}

// One call powering the whole admin dashboard.
async function overview() {
  const [
    valuation,
    daily,
    weekly,
    monthly,
    debt,
    collected,
    profit,
    performance,
    regional,
    reorderData,
    low,
    missing,
    repStock,
    activity,
    counts,
    settlements,
    monthExpenses,
    monthLosses,
  ] = await Promise.all([
    inventory.valuation(prisma),
    periodSales('today'),
    periodSales('week'),
    periodSales('month'),
    credit.debtSummary(),
    paymentsCollected('month'),
    reports.profitOverview('month'),
    reports.productPerformance({ period: 'month', limit: 5 }),
    reports.regionalPerformance({ period: 'month' }),
    reorder.reorderAnalysis(),
    reorder.lowStock(),
    stockCount.missingStockReport({}),
    outstandingRepStock(),
    recentActivity(12),
    prisma.$transaction([
      prisma.product.count({ where: { isActive: true } }),
      prisma.customer.count({ where: { isActive: true } }),
      prisma.salesRepresentative.count({ where: { isActive: true } }),
      prisma.warehouse.count({ where: { isActive: true } }),
    ]),
    settlement.summary(),
    epochRange('month').then((r) => reports.expensesBetween(r)),
    epochRange('month').then((r) => reports.stockLosses(r)),
  ]);

  return {
    inventory: {
      totalValue: valuation.totals.totalValue,
      warehouseValue: valuation.totals.warehouseValue,
      repValue: valuation.totals.repValue,
      retailValue: valuation.totals.retailValue,
      totalBaseUnits: valuation.totals.totalBaseUnits,
      productCount: valuation.totals.productCount,
    },
    sales: { daily, weekly, monthly },
    profit: {
      grossProfit: profit.totals.profit,
      // THE net profit (reports.netProfitOf): gross − expenses − stock lost, as Finance and Reports print it.
      netProfit: profitMath.netProfitOf({ grossProfit: profit.totals.profit, expenses: monthExpenses, stockLoss: monthLosses.total }),
      grossMargin: profit.totals.margin,
      revenue: profit.totals.revenue,
    },
    debt: {
      totalOutstanding: debt.totalOutstanding,
      overdueAmount: debt.overdueAmount,
      overdueAccounts: debt.overdueAccounts,
      openAccounts: debt.openAccounts,
      topDebtors: debt.topDebtors.slice(0, 5),
    },
    paymentsCollected: collected,
    topSelling: performance.topSelling,
    slowMoving: performance.slowMoving,
    regional: regional.items,
    alerts: {
      lowStock: { count: low.length, items: low.slice(0, 8) },
      reorder: {
        count: reorderData.summary.reorderCount,
        critical: reorderData.summary.criticalCount,
        items: reorderData.recommendations.slice(0, 8),
      },
      missingStock: { count: missing.totals.count, value: missing.totals.totalValue, items: missing.items.slice(0, 8) },
      outstandingRepStock: { count: repStock.length, items: repStock.slice(0, 8) },
      overdueDebts: { count: debt.overdueAccounts, amount: debt.overdueAmount },
      settlements: {
        outstanding: settlements.outstandingCount,
        approaching: settlements.approachingCount,
        overdue: settlements.overdueCount,
        overdueValue: settlements.overdueValue,
        items: settlements.items,
      },
    },
    counts: {
      products: counts[0],
      customers: counts[1],
      salesReps: counts[2],
      warehouses: counts[3],
    },
    recentActivity: activity,
  };
}

// Per-brand split (OHIS vs CIVILLY): stock on hand + this month's/today's sales.
// Everything is grouped by the product's brand, so no brand is ever mixed.
// `valuationPromise` (optional): the command center passes the stock valuation it is already reading, so
// one dashboard load values the stock once instead of three times. Read-only either way.
async function brandBreakdown(valuationPromise = null, periodsPromise = null) {
  // Month and today's sales by brand from the same line maths as Finance (discount shared, cost frozen at the sale,
  // boxes with no buying price kept out of profit) — this used today's buying price and the pre-discount line total.
  const [brands, products, val, periods] = await Promise.all([
    prisma.brand.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
    prisma.product.findMany({ select: { id: true, brandId: true } }),
    valuationPromise || inventory.valuation(prisma),
    periodsPromise || reports.profitByPeriods(['today', 'month']),
  ]);

  const brandOf = new Map(products.map((p) => [p.id, p.brandId]));
  const mk = (b) => ({ brandId: b.id, name: b.name, stockValue: 0, stockRetail: 0, stockUnits: 0, warehouseUnits: 0, salesMonth: 0, profitMonth: 0, marginMonth: 0, unitsSoldMonth: 0, salesToday: 0 });
  const byBrand = new Map(brands.map((b) => [b.id, mk(b)]));

  for (const it of val.items) {
    const b = byBrand.get(brandOf.get(it.productId));
    if (!b) continue;
    b.stockValue += it.costValue;
    // What the same boxes are worth at selling price. valuation() already
    // prices every line both ways, so the brand split is a second sum over
    // rows already in hand rather than another pass at the database.
    b.stockRetail += it.retailValue;
    b.stockUnits += it.totalBase;
    b.warehouseUnits += it.warehouseBase;
  }
  for (const r of periods?.month?.byBrand || []) {
    const b = byBrand.get(r.brandId);
    if (!b) continue;
    b.salesMonth = r.revenue;
    b.profitMonth = r.profit;
    b.marginMonth = r.margin;
    b.unitsSoldMonth = r.boxes;
    b.noCostMonth = r.noCost;
  }
  for (const r of periods?.today?.byBrand || []) {
    const b = byBrand.get(r.brandId);
    if (b) b.salesToday = r.revenue;
  }

  const items = [...byBrand.values()]
    .map((b) => ({
      ...b,
      stockValue: round2(b.stockValue),
      stockRetail: round2(b.stockRetail),
      // What this brand's shelf would leave behind if it all sold at today's
      // prices — before commission, like the figure for both brands together.
      stockPotential: round2(b.stockRetail - b.stockValue),
      salesMonth: round2(b.salesMonth),
      salesToday: round2(b.salesToday),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const sum = (k) => round2(items.reduce((t, b) => t + b[k], 0));
  return {
    brands: items,
    totals: {
      stockValue: sum('stockValue'),
      stockRetail: sum('stockRetail'),
      stockPotential: sum('stockPotential'),
      stockUnits: items.reduce((t, b) => t + b.stockUnits, 0),
      salesMonth: sum('salesMonth'),
      salesToday: sum('salesToday'),
      profitMonth: sum('profitMonth'),
    },
  };
}

// ── Chart series for the dashboard ───────────────────────────────────────────
// The dashboard reported totals and nothing else, so it could say what today
// was worth but never whether that was good. These give the numbers a shape:
// where the money has been going, and which brand, region, rep and product
// carry it.

const eatDayKey = (d) => new Date(new Date(d).getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);

// Revenue, gross profit and boxes per day. Empty days are emitted as zeros — a
// gap in a line reads as missing data rather than as a quiet day, and a quiet
// day is itself the thing worth seeing.
async function dailySeries(days = 30) {
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86400000);
  const items = await prisma.saleItem.findMany({
    where: { sale: { is: { status: { not: 'CANCELLED' }, soldAt: { gte: from, lte: to } } } },
    // The sale's discount, so a day's revenue is what the customers paid (sale05) — the same line maths as Finance.
    select: { baseQuantity: true, lineTotal: true, unitCost: true, sale: { select: { soldAt: true, discount: true, subtotal: true } } },
  });

  const byDay = new Map();
  for (const it of items) {
    const k = eatDayKey(it.sale.soldAt);
    const row = byDay.get(k) || profitMath.newTally();
    profitMath.addLine(row, profitMath.lineFinancials(it));
    byDay.set(k, row);
  }

  const out = [];
  const cur = new Date(from);
  for (let i = 0; i < days; i += 1) {
    const k = eatDayKey(cur);
    const row = byDay.get(k) || profitMath.newTally();
    const p = profitMath.profitOf(row);
    out.push({ date: k, revenue: p.revenue, profit: p.profit, boxes: row.boxes });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// "Which region is doing best" — a question only answerable now that regions
// come from a fixed list instead of free text.
// The same rule as Finance > Reports > Regional (reports.revenueByRegionRule), so the chart and the report never
// put the same sale in two places (sale04). Blank is Dar es Salaam's (mergeRegionRevenue keeps that rule too).
async function revenueByRegion(range) {
  const rows = await reports.revenueByRegionRule(range);
  return mergeRegionRevenue(rows.map((r) => ({ region: r.region, total: r.revenue })));
}

async function revenueByRep(range) {
  const rows = await prisma.sale.groupBy({
    by: ['salesRepId'],
    where: { status: { not: 'CANCELLED' }, salesRepId: { not: null }, soldAt: { gte: range.start, lte: range.end } },
    _sum: { total: true },
  });
  if (!rows.length) return [];
  const reps = await prisma.salesRepresentative.findMany({
    where: { id: { in: rows.map((r) => r.salesRepId) } },
    include: { user: { select: { name: true } } },
  });
  const m = new Map(reps.map((r) => [r.id, r]));
  return rows
    .map((r) => ({
      name: m.get(r.salesRepId)?.user?.name || m.get(r.salesRepId)?.code || 'Rep',
      region: m.get(r.salesRepId)?.region || null,
      value: round2(toNumber(r._sum.total)),
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
}

// What each product brought in, net of the sale discount (sale05) — the same line maths as Finance > Profit.
async function topProductsByRevenue(range, limit = 6) {
  const items = await prisma.saleItem.findMany({
    where: { sale: { is: { status: { not: 'CANCELLED' }, soldAt: { gte: range.start, lte: range.end } } } },
    select: { productId: true, baseQuantity: true, lineTotal: true, unitCost: true, sale: { select: { discount: true, subtotal: true } } },
  });
  if (!items.length) return [];
  const byProduct = new Map();
  for (const it of items) {
    const f = profitMath.lineFinancials(it);
    const cur = byProduct.get(it.productId) || { productId: it.productId, value: 0, boxes: 0 };
    cur.value += f.revenue; cur.boxes += f.boxes;
    byProduct.set(it.productId, cur);
  }
  const prods = await prisma.product.findMany({
    where: { id: { in: [...byProduct.keys()] } },
    select: { id: true, name: true },
  });
  const m = new Map(prods.map((x) => [x.id, x.name]));
  return [...byProduct.values()]
    .map((r) => ({ name: m.get(r.productId) || 'Product', value: round2(r.value), boxes: r.boxes }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

// ── Analysis ─────────────────────────────────────────────────────────────────
// The owner asked to see the SHAPE of the business, not only today's figures
// (8 Nov 2026): this month set against last, the ratios the business is run
// by, two years of months, how long the boxes already out have been out, and
// where the money goes.
//
// Every money figure here is built with reports.lineFinancials — the same
// function the Profit screen uses — so a month on the dashboard and the same
// month in Finance can never print different numbers. Months before the
// finance epoch read zero rather than part of a month nobody entered.
const eatMonthKey = (d) => eatDayKey(d).slice(0, 7);

/** Days from a moment until now, as a fraction, in whole hours. */
const hoursSince = (d) => (Date.now() - new Date(d).getTime()) / 3600000;

const AGE_BUCKETS = [
  { key: 'fresh', label: 'Still inside 72 hours', max: 72 },
  { key: 'week', label: '3 to 7 days out', max: 24 * 7 },
  { key: 'fortnight', label: '8 to 14 days out', max: 24 * 14 },
  { key: 'old', label: 'Over 14 days out', max: Infinity },
];

// This calendar year against the one before it, month for month. A month of this year that has not come
// yet is null, not 0: nothing has been sold in it because it has not happened, and a 0 drew the curve
// crashing to the floor in December (audit ui-a12). The chart stops the line at the current month.
function yearAgainstLast(months, year, boxesOf) {
  const out = [];
  for (let i = 0; i < 12; i += 1) {
    const now = months.find((m) => m.year === year && m.monthIndex === i);
    const before = months.find((m) => m.year === year - 1 && m.monthIndex === i);
    out.push({
      period: (now || before).label,
      thisYear: now ? boxesOf(now) : null,
      lastYear: before ? boxesOf(before) : 0,
    });
  }
  return out;
}

async function analysis() {
  const finance = require('./finance.service'); // lazy: avoids import cycles
  const { eatNow, eatToUtc } = require('../utils/dates');
  const epoch = await reports.financeEpoch();

  // 24 EAT months, oldest first, so this year can be set against last.
  const months = [];
  for (let i = 23; i >= 0; i -= 1) {
    const m = eatNow().subtract(i, 'month');
    months.push({
      key: m.format('YYYY-MM'),
      label: m.format('MMM'),
      year: m.year(),
      monthIndex: m.month(),
      start: eatToUtc(m.startOf('month')).toDate(),
      end: eatToUtc(m.endOf('month')).toDate(),
    });
  }
  const thisMonth = months[23];
  const prevMonth = months[22];
  const windowStart = months[0].start;
  const readFrom = epoch && epoch > windowStart ? epoch : windowStart;
  const last12 = months.slice(12);

  // EXACTLY the population finance.service's P&L counts as expenses — direction,
  // type and the epoch clamp, and nothing else. It is tempting to add
  // `account: { isActive: true }` here, the way flowBetween does; that filter
  // belongs to cash flow, where Opening + In − Out has to reconcile to the
  // ACTIVE accounts' balances. An expense is a cost of the month whoever's
  // wallet paid it, and closing that wallet later cannot un-spend the money.
  // Adding it here made this card's Net profit disagree with the Profit & loss
  // screen its own link opens.
  const expenseWhere = (start, end) => ({
    direction: 'OUT',
    type: 'EXPENSE',
    occurredAt: { gte: epoch && epoch > start ? epoch : start, lte: end },
  });

  const [items, products, openOrders, spendRows, expMonth, expPrev, flows, lossMonth, lossPrev] = await Promise.all([
    prisma.saleItem.findMany({
      where: { sale: { is: { status: { not: 'CANCELLED' }, soldAt: { gte: readFrom } } } },
      select: {
        baseQuantity: true,
        lineTotal: true,
        unitCost: true,
        productId: true,
        sale: { select: { soldAt: true, discount: true, subtotal: true } },
      },
    }),
    prisma.product.findMany({ select: { id: true, purchasePrice: true } }),
    // Every box still standing against a rep's name, with the day it left.
    prisma.settlement.findMany({
      where: { status: { in: ['OPEN', 'PARTIAL', 'OVERDUE'] } },
      select: { id: true, issuedAt: true, deadlineAt: true, assignedValue: true, settledValue: true, returnedValue: true },
    }),
    prisma.financeTransaction.groupBy({
      by: ['category'],
      where: expenseWhere(thisMonth.start, thisMonth.end),
      _sum: { amount: true },
    }),
    prisma.financeTransaction.aggregate({ where: expenseWhere(thisMonth.start, thisMonth.end), _sum: { amount: true } }),
    prisma.financeTransaction.aggregate({ where: expenseWhere(prevMonth.start, prevMonth.end), _sum: { amount: true } }),
    // Money in and out, month by month. A month wholly before the epoch is
    // not a month of zero trading — it is a month nobody recorded — but it
    // reads as zero either way, and the chart says where the records begin.
    Promise.all(last12.map((m) => (
      epoch && m.end < epoch
        ? Promise.resolve({ moneyIn: 0, moneyOut: 0, net: 0 })
        : finance.flowBetween(epoch && epoch > m.start ? epoch : m.start, m.end)
    ))),
    // Stock lost this month and last (written off, or bought and never received): part of THE net profit.
    reports.stockLosses({ start: thisMonth.start, end: thisMonth.end }),
    epoch && prevMonth.end < epoch ? { total: 0 } : reports.stockLosses({ start: prevMonth.start, end: prevMonth.end }),
  ]);

  // ── The months ──
  const productById = new Map(products.map((p) => [p.id, p]));
  const byMonth = new Map();
  for (const it of items) {
    const k = eatMonthKey(it.sale.soldAt);
    const row = byMonth.get(k) || profitMath.newTally();
    profitMath.addLine(row, profitMath.lineFinancials(it, productById.get(it.productId)));
    byMonth.set(k, row);
  }
  // Boxes sold before a buying price was set count in revenue, never in profit (reports.lineFinancials).
  const monthFigures = (m) => {
    const row = byMonth.get(m.key) || profitMath.newTally();
    const p = profitMath.profitOf(row);
    return { revenue: p.revenue, cost: p.cost, grossProfit: p.profit, boxes: row.boxes, noCost: p.noCost };
  };

  const trend = last12.map((m, i) => {
    const f = monthFigures(m);
    return {
      period: m.label,
      revenue: f.revenue,
      cost: f.cost,
      profit: f.grossProfit,
      boxes: f.boxes,
      moneyIn: flows[i].moneyIn,
      moneyOut: flows[i].moneyOut,
      net: flows[i].net,
    };
  });

  const boxesByYear = yearAgainstLast(months, thisMonth.year, (m) => monthFigures(m).boxes);

  const m0 = monthFigures(thisMonth);
  const m1 = monthFigures(prevMonth);
  const expensesMonth = round2(toNumber(expMonth._sum.amount));
  const expensesPrev = round2(toNumber(expPrev._sum.amount));

  // THE net profit (reports.netProfitOf) — the same figure Finance and Reports > Profit print for the month.
  const month = {
    ...m0, label: thisMonth.label, expenses: expensesMonth, stockLoss: lossMonth.total,
    netProfit: profitMath.netProfitOf({ grossProfit: m0.grossProfit, expenses: expensesMonth, stockLoss: lossMonth.total }),
  };
  const lastMonth = {
    ...m1, label: prevMonth.label, expenses: expensesPrev, stockLoss: lossPrev.total,
    netProfit: profitMath.netProfitOf({ grossProfit: m1.grossProfit, expenses: expensesPrev, stockLoss: lossPrev.total }),
  };

  // ── How long the boxes already out have been out ──
  // Outstanding is what the order still owes: issued, less what was settled,
  // less what came back. An order whose figures already balance is finished
  // in all but status and does not belong in a list of money at risk.
  const buckets = AGE_BUCKETS.map((b) => ({ ...b, orders: 0, value: 0 }));
  let outstandingTotal = 0;
  let overdueValue = 0;
  for (const o of openOrders) {
    const left = round2(toNumber(o.assignedValue) - toNumber(o.settledValue) - toNumber(o.returnedValue));
    if (left <= 0) continue;
    outstandingTotal += left;
    if (new Date(o.deadlineAt).getTime() < Date.now()) overdueValue += left;
    const age = hoursSince(o.issuedAt);
    const bucket = buckets.find((b) => age < b.max) || buckets[buckets.length - 1];
    bucket.orders += 1;
    bucket.value = round2(bucket.value + left);
  }
  outstandingTotal = round2(outstandingTotal);
  const ageing = {
    total: outstandingTotal,
    overdueValue: round2(overdueValue),
    buckets: buckets.map(({ max, ...b }) => ({
      ...b,
      share: outstandingTotal > 0 ? round2((b.value / outstandingTotal) * 100) : 0,
    })),
  };

  // ── Where the money goes ──
  const spendTotal = round2(spendRows.reduce((n, r) => n + toNumber(r._sum.amount), 0));
  const spend = spendRows
    .map((r) => ({
      name: r.category || 'Uncategorised',
      amount: round2(toNumber(r._sum.amount)),
      share: spendTotal > 0 ? round2((toNumber(r._sum.amount) / spendTotal) * 100) : 0,
    }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  // ── The ratios the business is run by ──
  // A ratio with no denominator is not zero, it is unanswerable: those come
  // back null so the screen can say so instead of printing a confident 0%.
  const growth = (now, before) => (before > 0 ? round2(((now - before) / before) * 100) : null);
  const share = (part, whole) => (whole > 0 ? round2((part / whole) * 100) : null);
  // Margins are over the revenue whose cost is known: a box sold before a buying price was set is never "100% kept".
  const costedRevenue = round2(month.revenue - (month.noCost?.revenue || 0));
  const health = {
    grossMargin: share(month.grossProfit, costedRevenue),
    expenseRatio: share(month.expenses, month.revenue),
    netMargin: share(month.netProfit, costedRevenue),
    revenueGrowth: growth(month.revenue, lastMonth.revenue),
    profitGrowth: growth(month.grossProfit, lastMonth.grossProfit),
    overdueShare: share(ageing.overdueValue, ageing.total),
  };
  // The month cards show the same two growth figures the health list does, so
  // they are read from here rather than worked out again on the client: two
  // roundings of one quantity printed "7.4%" on the card and "7.5%" in the
  // list, a few centimetres apart.
  const growthOf = {
    revenue: health.revenueGrowth,
    grossProfit: health.profitGrowth,
    expenses: growth(month.expenses, lastMonth.expenses),
    netProfit: growth(month.netProfit, lastMonth.netProfit),
    boxes: growth(month.boxes, lastMonth.boxes),
  };

  return { month, lastMonth, health, growth: growthOf, trend, boxesByYear, ageing, spend, spendTotal, epoch };
}

// ── Command center ───────────────────────────────────────────────────────────
// One composed payload for the admin dashboard: where the money is, today's
// business (all from Finance), per-brand performance, rep performance, what
// needs attention, and the inventory picture. Every figure derives from the
// same Finance/epoch sources, so the dashboard can never disagree with Finance.
async function command() {
  const finance = require('./finance.service'); // lazy: avoids import cycles
  const reorderSvc = require('./reorder.service');
  const commission = require('./commission.service');

  const todayR = await epochRange('today');
  const monthR = await epochRange('month');

  // Chart data, gathered in parallel with the rest and never allowed to break
  // the dashboard: an empty chart is a far better failure than a blank page.
  const chartsPromise = Promise.all([
    dailySeries(30).catch(() => []),
    revenueByRegion(monthR).catch(() => []),
    revenueByRep(monthR).catch(() => []),
    topProductsByRevenue(monthR).catch(() => []),
  ]).then(([daily, byRegion, byRep, topProducts]) => ({ daily, byRegion, byRep, topProducts }));

  // Three heavy reads this page needs that finance.overview('today') and brandBreakdown() also make.
  // Each is started once here and handed to them, instead of being worked out two or three times over
  // in the same request. Same functions, same arguments, read-only; nothing is kept after the request.
  const valP = inventory.valuation(prisma);
  // Today, this week and this month in one read: the brand cards and the brand split both use it.
  const periodsP = reports.profitByPeriods(['today', 'week', 'month']).catch(() => null);
  const commAllP = commission.summaryAllReps();
  const supplierRowsP = finance.supplierSummaries();

  const [fin, profMonth, periods, bd, stl, low, val, repsRows, repBal, commAll, supplierRows, products, pendCounts, pendingWithdrawals, salesTodayRows, salesMonthRows, activeStl, retTodayAgg, retSubmittedToday, retSubmittedTodayBoxes, refundTodayAgg] = await Promise.all([
    finance.overview('today', { valuation: valP, commSummary: commAllP, supplierSummaries: supplierRowsP }),
    reports.profitOverview('month'),
    // Today, this week and this month in one read, so every brand card can be
    // switched between them without another trip.
    periodsP,
    brandBreakdown(valP, periodsP),
    settlement.summary(),
    reorderSvc.lowStock(),
    valP,
    prisma.salesRepresentative.findMany({ where: { isActive: true }, include: { user: { select: { name: true } } } }),
    inventory.repBalances(prisma),
    commAllP,
    supplierRowsP,
    prisma.product.findMany({ where: { isActive: true }, select: { id: true, brandId: true } }),
    prisma.$transaction([
      prisma.stockRequest.count({ where: { status: 'PENDING' } }),
      prisma.settlementSubmission.count({ where: { status: 'PENDING' } }),
      prisma.return.count({ where: { status: 'PENDING' } }),
    ]),
    // Approved but not yet paid still waits for the owner's money (audit money-flows-7).
    prisma.commissionWithdrawal.findMany({
      where: { status: { in: ['PENDING', 'APPROVED'] } },
      include: { salesRep: { select: { id: true, code: true, user: { select: { name: true } } } } },
      orderBy: { requestedAt: 'asc' },
    }),
    prisma.sale.groupBy({ by: ['salesRepId'], where: { status: { not: 'CANCELLED' }, soldAt: { gte: todayR.start, lte: todayR.end }, salesRepId: { not: null } }, _sum: { total: true } }),
    prisma.sale.groupBy({ by: ['salesRepId'], where: { status: { not: 'CANCELLED' }, soldAt: { gte: monthR.start, lte: monthR.end }, salesRepId: { not: null } }, _sum: { total: true } }),
    prisma.settlement.findMany({ where: { status: { in: ['OPEN', 'PARTIAL', 'OVERDUE'] } }, select: { salesRepId: true, deadlineAt: true } }),
    prisma.returnItem.aggregate({
      where: { return: { is: { status: { in: ['APPROVED', 'COMPLETED'] }, decidedAt: { gte: todayR.start, lte: todayR.end } } } },
      _sum: { baseQuantity: true },
    }),
    prisma.return.count({ where: { createdAt: { gte: todayR.start, lte: todayR.end } } }),
    prisma.returnItem.aggregate({
      where: { return: { is: { createdAt: { gte: todayR.start, lte: todayR.end } } } },
      _sum: { quantity: true },
    }),
    // Boxes customers brought back today (a refund on the sale puts them back as CUSTOMER_RETURN stock rows, not
    // as a Return): they are boxes back on the shelf too (sale08).
    prisma.inventoryTransaction.aggregate({
      where: { type: 'CUSTOMER_RETURN', referenceType: 'SALE', occurredAt: { gte: todayR.start, lte: todayR.end } },
      _sum: { baseQuantity: true },
    }),
  ]);

  // ── Brands: month P&L + stock split + top product ──
  const brandOf = new Map(products.map((p) => [p.id, p.brandId]));
  // The best-selling product of each brand, for each window the card can show. It used to be the
  // month's only, printed under Today and This week too, so one product "earned" more than its whole
  // brand that day (audit admin-ops-1).
  const topOf = (rows) => {
    const top = new Map();
    for (const pr of rows || []) {
      const b = brandOf.get(pr.productId);
      if (!b) continue;
      const cur = top.get(b);
      if (!cur || pr.revenue > cur.revenue) top.set(b, { name: pr.name, revenue: pr.revenue, boxes: pr.boxes });
    }
    return top;
  };
  const topByBrand = topOf(profMonth.byProduct);
  const topToday = topOf(periods?.today?.byProduct);
  const topWeek = topOf(periods?.week?.byProduct);
  const profBrand = new Map(profMonth.byBrand.map((b) => [b.brandId, b]));
  // The same brand, over each window. An owner asked to see today and the week
  // beside the month so he does not have to wait for month end to know where a
  // brand stands.
  const brandIn = (period, brandId) => {
    const row = periods?.[period]?.byBrand?.find((x) => x.brandId === brandId);
    return row || { revenue: 0, profit: 0, margin: 0, boxes: 0 };
  };
  const brands = bd.brands.map((b) => {
    const pm = profBrand.get(b.brandId) || { revenue: 0, profit: 0, margin: 0, boxes: 0 };
    const today = brandIn('today', b.brandId);
    const week = brandIn('week', b.brandId);
    return {
      brandId: b.brandId,
      name: b.name,
      revenueToday: today.revenue,
      grossProfitToday: today.profit,
      marginToday: today.margin,
      boxesSoldToday: today.boxes,
      // Boxes sold before a buying price was set, per window: in revenue, not in profit or margin.
      noCostToday: today.noCost || { boxes: 0, revenue: 0 },
      noCostWeek: week.noCost || { boxes: 0, revenue: 0 },
      noCostMonth: pm.noCost || { boxes: 0, revenue: 0 },
      revenueWeek: week.revenue,
      grossProfitWeek: week.profit,
      marginWeek: week.margin,
      boxesSoldWeek: week.boxes,
      revenueMonth: pm.revenue,
      grossProfitMonth: pm.profit,
      marginMonth: pm.margin,
      boxesSoldMonth: pm.boxes,
      inventoryValue: b.stockValue,
      warehouseBoxes: b.warehouseUnits,
      repBoxes: b.stockUnits - b.warehouseUnits,
      topProduct: topByBrand.get(b.brandId) || null,
      topProductMonth: topByBrand.get(b.brandId) || null,
      topProductToday: topToday.get(b.brandId) || null,
      topProductWeek: topWeek.get(b.brandId) || null,
    };
  });

  // ── Reps: boxes held, sales today/month, commission, order status ──
  const heldByRep = new Map();
  repBal.forEach((r) => { if (r.baseQuantity > 0) heldByRep.set(r.salesRepId, (heldByRep.get(r.salesRepId) || 0) + r.baseQuantity); });
  const sToday = new Map(salesTodayRows.map((r) => [r.salesRepId, toNumber(r._sum.total)]));
  const sMonth = new Map(salesMonthRows.map((r) => [r.salesRepId, toNumber(r._sum.total)]));
  const commByRep = new Map(commAll.items.map((c) => [c.salesRepId, c]));
  const stlByRep = new Map();
  const now = Date.now();
  for (const x of activeStl) {
    const cur = stlByRep.get(x.salesRepId) || { active: 0, overdue: 0 };
    cur.active += 1;
    if (new Date(x.deadlineAt).getTime() < now) cur.overdue += 1;
    stlByRep.set(x.salesRepId, cur);
  }
  const reps = repsRows
    .map((r) => {
      const c = commByRep.get(r.id) || {};
      const st = stlByRep.get(r.id) || { active: 0, overdue: 0 };
      return {
        salesRepId: r.id,
        name: r.user?.name || r.code,
        code: r.code,
        boxesHeld: heldByRep.get(r.id) || 0,
        salesToday: round2(sToday.get(r.id) || 0),
        salesMonth: round2(sMonth.get(r.id) || 0),
        commissionAvailable: round2(c.available || 0),
        activeOrders: st.active,
        overdueOrders: st.overdue,
      };
    })
    .sort((a, b) => b.salesMonth - a.salesMonth);

  // ── Attention ──
  const onHandTotals = new Map();
  val.items.forEach((it) => onHandTotals.set(it.productId, it.totalBase));
  const outOfStock = products.filter((p) => (onHandTotals.get(p.id) || 0) <= 0).length;
  const supplierDue = round2(supplierRows.reduce((x, sup) => x + sup.outstanding, 0));

  // ── Inventory split ──
  const warehouseBoxes = val.items.reduce((x, it) => x + it.warehouseBase, 0);
  const repBoxes = val.items.reduce((x, it) => x + it.repBase, 0);

  const charts = await chartsPromise;

  return {
    accounts: fin.accounts,
    totalFunds: fin.cashPosition,
    today: {
      revenue: fin.revenue,
      grossProfit: fin.grossProfit,
      expenses: fin.expenses,
      netProfit: fin.netProfit,
      // Boxes sold before a buying price was set: in revenue, not in profit (said on the page).
      noCost: fin.noCost || { boxes: 0, revenue: 0 },
      moneyIn: fin.flow.today.moneyIn,
      moneyOut: fin.flow.today.moneyOut,
      netCash: fin.flow.today.net,
      boxesSold: fin.boxesSold ?? 0,
    },
    // This week, Monday to Sunday in Tanzania time. Same source as the month
    // beside it, so the two are always the same kind of figure.
    week: periods?.week
      ? {
        revenue: periods.week.revenue,
        grossProfit: periods.week.profit,
        boxes: periods.week.boxes,
        noCost: periods.week.noCost || { boxes: 0, revenue: 0 },
        start: periods.week.range.start,
        end: periods.week.range.end,
      }
      : null,
    month: { revenue: profMonth.totals.revenue, grossProfit: profMonth.totals.profit, boxes: profMonth.totals.boxes, noCost: profMonth.totals.noCost || { boxes: 0, revenue: 0 } },
    brands,
    reps,
    attention: {
      stockRequests: pendCounts[0],
      settlements: pendCounts[1],
      returns: pendCounts[2],
      returnsToday: retSubmittedToday,
      returnsTodayBoxes: retSubmittedTodayBoxes._sum.quantity || 0,
      overdueSettlements: stl.overdueCount,
      overdueValue: stl.overdueValue,
      lowStock: { count: low.length, items: low.slice(0, 5).map((l) => ({ name: l.name, onHand: l.onHand })) },
      outOfStock,
      supplierDue,
      commissionRequests: {
        count: pendingWithdrawals.length,
        total: round2(pendingWithdrawals.reduce((n, w) => n + toNumber(w.amount), 0)),
        items: pendingWithdrawals.map((w) => {
          // A BONUS withdrawal (14 Nov 2026) comes out of the bonus, not commission: no commission figures on it.
          const source = w.source || 'COMMISSION';
          const bal = source === 'BONUS' ? null : (commAll.items || []).find((c) => c.salesRepId === w.salesRepId);
          return {
            id: w.id,
            status: w.status,
            source,
            salesRepId: w.salesRepId,
            repName: w.salesRep?.user?.name || w.salesRep?.code || 'Rep',
            repCode: w.salesRep?.code || null,
            amount: round2(toNumber(w.amount)),
            // Where the rep asked for it to go — name, number and method.
            payTo: w.notes || null,
            requestedAt: w.requestedAt,
            // What they have earned and what is left after this request, so the
            // decision does not need a second screen.
            available: bal ? round2(toNumber(bal.available)) : null,
            earned: bal ? round2(toNumber(bal.earned)) : null,
          };
        }),
      },
    },
    inventory: {
      costValue: val.totals.totalValue,
      sellingValue: val.totals.retailValue,
      units: val.totals.totalBaseUnits,
      warehouseBoxes,
      repBoxes,
      returnedToday: (retTodayAgg._sum.baseQuantity || 0) + (refundTodayAgg._sum.baseQuantity || 0),
      refundedToday: refundTodayAgg._sum.baseQuantity || 0,
    },
    // The shape behind the totals. Everything here is scoped to the same month
    // range the rest of the payload uses, except the trend, which is a rolling
    // 30 days so the line does not restart on the 1st.
    charts,
  };
}

module.exports = { overview, recentActivity, outstandingRepStock, paymentsCollected, brandBreakdown, command, analysis, yearAgainstLast };
