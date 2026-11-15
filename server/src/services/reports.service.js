'use strict';

const prisma = require('../config/prisma');
const inventory = require('./inventory.service');
const credit = require('./credit.service');
const { toNumber, round2 } = require('../utils/money');
const { dayjs, resolveRange, EAT_OFFSET_H } = require('../utils/dates');
const { DEFAULT_REGION, repRegions, regionWhere } = require('../constants/regions');
const { lineFinancials, newTally, addLine, profitOf, netProfitOf } = require('../utils/profitMath');

const NON_CANCELLED = { status: { not: 'CANCELLED' } };

// Days, weeks and months on the business's clock (Tanzania), like every range they sit in (audit #82).
// dayjs(date) read the server's own clock — UTC on Vercel — so a sale at 01:30 EAT on the 1st was
// charted on the last day of the month before.
function bucketKey(date, granularity) {
  const d = dayjs.utc(date).add(EAT_OFFSET_H, 'hour');
  switch (granularity) {
    case 'month':
      return d.format('YYYY-MM');
    case 'week':
      return `${d.isoWeekYear()}-W${String(d.isoWeek()).padStart(2, '0')}`;
    case 'day':
    default:
      return d.format('YYYY-MM-DD');
  }
}

function pickGranularity(range, requested) {
  if (requested) return requested;
  const days = dayjs(range.end).diff(dayjs(range.start), 'day');
  if (days <= 1) return 'day';
  if (days <= 92) return 'day';
  if (days <= 366) return 'week';
  return 'month';
}

// Time-bucketed sales with revenue, cost and profit. Powers daily/weekly/
// monthly/annual reports depending on the period + granularity supplied.
async function salesReport(params = {}) {
  const range = await clampToEpoch(resolveRange(params));
  const granularity = pickGranularity(range, params.groupBy);

  const where = { ...NON_CANCELLED, soldAt: { gte: range.start, lte: range.end } };
  if (params.salesRepId) where.salesRepId = params.salesRepId;
  const regionClause = regionWhere(params.region);
  if (regionClause) where.AND = [...(where.AND || []), regionClause];
  if (params.type) where.type = params.type;

  const [sales, noCostRows] = await Promise.all([
    prisma.sale.findMany({
      where,
      select: { id: true, soldAt: true, total: true, costTotal: true, discount: true, type: true },
      orderBy: { soldAt: 'asc' },
    }),
    noCostLines(where),
  ]);
  // Revenue of boxes sold before a buying price was set, per sale: counted as revenue, never as profit.
  const noCostBySale = new Map();
  noCostRows.forEach((r) => noCostBySale.set(r.saleId, (noCostBySale.get(r.saleId) || 0) + r.revenue));

  const buckets = new Map();
  let revenue = 0;
  let cost = 0;
  let noCostRevenue = 0;
  let discounts = 0;
  let cashRevenue = 0;
  let creditRevenue = 0;

  for (const s of sales) {
    const key = bucketKey(s.soldAt, granularity);
    const tot = toNumber(s.total);
    const cst = toNumber(s.costTotal);
    const unknown = noCostBySale.get(s.id) || 0;
    revenue += tot;
    cost += cst;
    noCostRevenue += unknown;
    discounts += toNumber(s.discount);
    if (s.type === 'CASH') cashRevenue += tot;
    else creditRevenue += tot;

    const b = buckets.get(key) || { period: key, revenue: 0, cost: 0, profit: 0, orders: 0, noCostRevenue: 0 };
    b.revenue = round2(b.revenue + tot);
    b.cost = round2(b.cost + cst);
    b.noCostRevenue = round2(b.noCostRevenue + unknown);
    b.profit = round2(b.revenue - b.noCostRevenue - b.cost);
    b.orders += 1;
    buckets.set(key, b);
  }

  const series = [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period));
  const costedRevenue = round2(revenue - noCostRevenue);

  return {
    range: { start: range.start, end: range.end, label: range.label, granularity },
    totals: {
      revenue: round2(revenue),
      cost: round2(cost),
      grossProfit: round2(costedRevenue - cost),
      margin: costedRevenue > 0 ? round2(((costedRevenue - cost) / costedRevenue) * 100) : 0,
      noCost: sumNoCost(noCostRows),
      discounts: round2(discounts),
      orders: sales.length,
      cashRevenue: round2(cashRevenue),
      creditRevenue: round2(creditRevenue),
      averageOrderValue: sales.length ? round2(revenue / sales.length) : 0,
    },
    series,
  };
}

// Per-product units sold, revenue and profit. Returns both top sellers and the
// slowest movers (active products ranked by units sold ascending).
async function productPerformance(params = {}) {
  const range = await clampToEpoch(resolveRange(params));
  const limit = params.limit || 10;

  const items = await prisma.saleItem.findMany({
    where: { sale: { is: { ...NON_CANCELLED, soldAt: { gte: range.start, lte: range.end } } } },
    select: {
      productId: true,
      baseQuantity: true,
      lineTotal: true,
      unitCost: true,
      // The sale's discount, so a product's revenue is what it really brought in (lineFinancials).
      sale: { select: { discount: true, subtotal: true } },
      product: { select: { name: true, sku: true, baseUnitName: true, brand: { select: { name: true } } } },
    },
  });

  const agg = new Map();
  for (const it of items) {
    const cur =
      agg.get(it.productId) ||
      newTally({
        productId: it.productId,
        name: it.product.name,
        sku: it.product.sku,
        brand: it.product.brand?.name,
        baseUnitName: it.product.baseUnitName,
      });
    addLine(cur, lineFinancials(it));
    agg.set(it.productId, cur);
  }

  const ranked = [...agg.values()].map(({ noCostRevenue, noCostBoxes, boxes, ...r }) => {
    const p = profitOf({ revenue: r.revenue, cost: r.cost, noCostRevenue, noCostBoxes });
    return {
      ...r,
      unitsSold: boxes,
      revenue: p.revenue,
      cost: p.cost,
      profit: p.profit,
      margin: p.margin,
      noCost: p.noCost,
    };
  });

  // "Top selling · By revenue" (sale11): ranked by what the product brought in, the figure the chart plots.
  const topSelling = [...ranked].sort((a, b) => b.revenue - a.revenue || b.unitsSold - a.unitsSold).slice(0, limit);

  // Slow movers: every active product, including those with zero sales.
  const activeProducts = await prisma.product.findMany({
    where: { isActive: true },
    select: { id: true, name: true, sku: true, baseUnitName: true, brand: { select: { name: true } } },
  });
  const slowMoving = activeProducts
    .map((p) => {
      const sold = agg.get(p.id);
      return {
        productId: p.id,
        name: p.name,
        sku: p.sku,
        brand: p.brand?.name,
        baseUnitName: p.baseUnitName,
        unitsSold: sold ? sold.unitsSold : 0,
        revenue: sold ? sold.revenue : 0,
      };
    })
    .sort((a, b) => a.unitsSold - b.unitsSold)
    .slice(0, limit);

  return {
    range: { start: range.start, end: range.end, label: range.label },
    topSelling,
    slowMoving,
    all: ranked.sort((a, b) => b.revenue - a.revenue),
  };
}

// ONE rule for the region a sale's revenue belongs to (sale04, 15 Nov 2026), used by Reports > Regional AND the
// Dashboard's revenue-by-region chart, so the two never disagree:
//   • a rep's sale → the rep's CURRENT main (first) region (live join: editing a rep's region re-buckets their
//     sales, and a rep with several regions counts under the main one — owner, 10 Nov 2026);
//   • a direct sale (no rep) → the region saved on the sale, which resolveSaleRegion filled from the customer or
//     the warehouse it actually left (a sale from a warehouse in Arusha is Arusha's, not the primary warehouse's);
//   • nothing known → Dar es Salaam (DEFAULT_REGION: blank means Dar es Salaam, where the warehouse is).
async function revenueByRegionRule(range) {
  const saleWhere = { ...NON_CANCELLED, soldAt: { gte: range.start, lte: range.end } };
  const [grouped, reps, noCostRows] = await Promise.all([
    prisma.sale.groupBy({
      by: ['salesRepId', 'region'],
      where: saleWhere,
      _sum: { total: true, costTotal: true },
      _count: true,
    }),
    prisma.salesRepresentative.findMany({ select: { id: true, region: true, regions: true } }),
    noCostLines(saleWhere),
  ]);
  const regionByRep = new Map(reps.map((r) => [r.id, repRegions(r)[0] || null]));
  const regionOf = (salesRepId, saved) => (salesRepId
    ? regionByRep.get(salesRepId) || DEFAULT_REGION
    : (saved || '').trim() || DEFAULT_REGION);

  const byRegion = new Map();
  const bucket = (region) => byRegion.get(region) || { region, revenue: 0, cost: 0, orders: 0, noCostRevenue: 0, noCostBoxes: 0 };
  for (const g of grouped) {
    const cur = bucket(regionOf(g.salesRepId, g.region));
    cur.revenue += toNumber(g._sum.total);
    cur.cost += toNumber(g._sum.costTotal);
    cur.orders += g._count;
    byRegion.set(cur.region, cur);
  }
  for (const r of noCostRows) {
    const cur = bucket(regionOf(r.sale?.salesRepId, r.sale?.region));
    cur.noCostRevenue += r.revenue;
    cur.noCostBoxes += r.boxes;
    byRegion.set(cur.region, cur);
  }
  return [...byRegion.values()]
    .map((x) => {
      const p = profitOf(x);
      return { region: x.region, revenue: p.revenue, cost: p.cost, profit: p.profit, orders: x.orders, noCost: p.noCost };
    })
    .sort((a, b) => b.revenue - a.revenue);
}

async function regionalPerformance(params = {}) {
  const range = await clampToEpoch(resolveRange(params));
  const items = await revenueByRegionRule(range);
  return { range: { start: range.start, end: range.end, label: range.label }, items };
}

async function salesRepPerformance(params = {}) {
  const range = await clampToEpoch(resolveRange(params));

  const saleWhere = { ...NON_CANCELLED, soldAt: { gte: range.start, lte: range.end } };
  const [grouped, reps, commissionSummary, noCostRows] = await Promise.all([
    prisma.sale.groupBy({
      by: ['salesRepId'],
      where: saleWhere,
      _sum: { total: true, costTotal: true },
      _count: true,
    }),
    prisma.salesRepresentative.findMany({
      where: { isActive: true },
      include: { user: { select: { name: true } } },
    }),
    require('./commission.service').summaryAllReps().catch(() => ({ items: [] })),
    noCostLines(saleWhere),
  ]);

  const salesMap = new Map(grouped.map((g) => [g.salesRepId, g]));
  const commMap = new Map((commissionSummary.items || []).map((c) => [c.salesRepId, toNumber(c.available)]));
  const noCostByRep = new Map();
  for (const r of noCostRows) {
    const k = r.sale?.salesRepId || null;
    const cur = noCostByRep.get(k) || { revenue: 0, boxes: 0 };
    cur.revenue += r.revenue; cur.boxes += r.boxes;
    noCostByRep.set(k, cur);
  }

  const items = reps.map((rep) => {
    const s = salesMap.get(rep.id);
    const nc = noCostByRep.get(rep.id) || { revenue: 0, boxes: 0 };
    const p = profitOf({
      revenue: s ? toNumber(s._sum.total) : 0,
      cost: s ? toNumber(s._sum.costTotal) : 0,
      noCostRevenue: nc.revenue,
      noCostBoxes: nc.boxes,
    });
    const target = toNumber(rep.monthlyTarget);
    // Commission `available` goes below zero when fines are bigger than what was earned: that is the rep owing the
    // business, never commission owed to him (sale12). The two are said apart.
    const available = round2(commMap.get(rep.id) || 0);
    const revenue = p.revenue;
    return {
      salesRepId: rep.id,
      name: rep.user?.name,
      code: rep.code,
      region: rep.region,
      revenue,
      cost: p.cost,
      profit: p.profit,
      noCost: p.noCost,
      orders: s ? s._count : 0,
      commissionOwed: Math.max(0, available),
      repOwes: available < 0 ? round2(-available) : 0,
      monthlyTarget: target,
      attainment: target > 0 ? round2((revenue / target) * 100) : null,
    };
  });

  items.sort((a, b) => b.revenue - a.revenue);
  return { range: { start: range.start, end: range.end, label: range.label }, items };
}

// Gross & net profit for Reports > Profit — the same net profit as Finance and the Dashboard (netProfitOf):
// gross profit − expenses − stock lost (written off, or bought on an order and damaged/never received).
async function profitReport(params = {}) {
  const range = await clampToEpoch(resolveRange(params));
  const saleWhere = { ...NON_CANCELLED, soldAt: { gte: range.start, lte: range.end } };

  const [salesAgg, noCostRows, expenses, losses] = await Promise.all([
    prisma.sale.aggregate({
      where: saleWhere,
      _sum: { total: true, costTotal: true, discount: true },
      _count: true,
    }),
    noCostLines(saleWhere),
    expensesBetween(range),
    stockLosses(range),
  ]);

  const revenue = round2(toNumber(salesAgg._sum.total));
  const cogs = round2(toNumber(salesAgg._sum.costTotal));
  // Boxes sold before a buying price was set are in revenue, never in profit (lineFinancials).
  const noCost = sumNoCost(noCostRows);
  const costedRevenue = round2(revenue - noCost.revenue);
  const grossProfit = round2(costedRevenue - cogs);

  return {
    range: { start: range.start, end: range.end, label: range.label },
    revenue,
    cogs,
    grossProfit,
    grossMargin: costedRevenue > 0 ? round2((grossProfit / costedRevenue) * 100) : 0,
    noCost,
    // Already inside revenue (sales are recorded net of discount) — a note, never a line taken off profit.
    discounts: round2(toNumber(salesAgg._sum.discount)),
    expenses,
    stockLoss: losses.total,
    writtenOff: losses.writtenOff,
    receivingLoss: losses.receivingLoss,
    // Kept for old readers (exports): the same figure as stockLoss.
    shrinkageAndDamageValue: losses.total,
    netProfit: netProfitOf({ grossProfit, expenses, stockLoss: losses.total }),
    orders: salesAgg._count,
  };
}

// Full profit picture for The Doctor. COGS is computed from each product's
// CURRENT cost price × boxes sold (deterministic, works even for sales recorded
// before cost prices existed). Profit is only counted on actual sales (settled
// boxes create CASH sales) — never on stock requests, transfers or warehouse
// inventory. period: today | week | month | year | all.
// --- Finance epoch -----------------------------------------------------------
// The Finance go-live moment (setting `finance.epochAt`). Revenue, profit and
// money-flow figures count ONLY from this instant — everything before it is
// kept in the database for audit but excluded from financial aggregates.
// Null (unset) = no cutoff. Cached briefly to avoid a query per request.
let _epochCache = { at: 0, value: undefined };
async function financeEpoch() {
  if (Date.now() - _epochCache.at < 60_000 && _epochCache.value !== undefined) return _epochCache.value;
  const row = await prisma.setting.findUnique({ where: { key: 'finance.epochAt' } }).catch(() => null);
  // A bare date like "2026-07-05" is parsed as UTC midnight, which is 03:00
  // in Dar es Salaam — so the first three hours of that business day fell
  // outside the books, and the same setting meant a different instant on a
  // developer's machine than on the server. A date-only value is read as the
  // start of that day in Tanzania; a full timestamp is respected as given.
  const raw = row?.value ? String(row.value).trim() : null;
  const value = !raw
    ? null
    : /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? new Date(`${raw}T00:00:00+03:00`)
      : new Date(raw);
  _epochCache = { at: Date.now(), value };
  return value;
}

// Clamp a report range to the finance epoch so every revenue/profit figure
// counts only real post-go-live activity. Stock/debt reports are not clamped.
async function clampToEpoch(range) {
  const epoch = await financeEpoch();
  if (!epoch || !range) return range;
  return range.start < epoch ? { ...range, start: epoch } : range;
}

// The lines sold with no known cost inside `saleWhere`, valued like every other line — for the reports that add up
// whole sales (sale.total / sale.costTotal) rather than lines. Few rows: only boxes sold before a buying price.
async function noCostLines(saleWhere) {
  const rows = await prisma.saleItem.findMany({
    where: { unitCost: { lte: 0 }, baseQuantity: { gt: 0 }, sale: { is: saleWhere } },
    select: {
      saleId: true, productId: true, baseQuantity: true, lineTotal: true, unitCost: true,
      sale: { select: { soldAt: true, discount: true, subtotal: true, salesRepId: true, region: true } },
    },
  });
  return rows.map((r) => ({ ...lineFinancials(r), saleId: r.saleId, productId: r.productId, sale: r.sale }));
}
const sumNoCost = (rows) => ({
  boxes: rows.reduce((n, r) => n + r.boxes, 0),
  revenue: round2(rows.reduce((n, r) => n + r.revenue, 0)),
});

// The window clamped to the finance epoch; no range = since the epoch (or all time with no epoch).
async function epochWindow(range) {
  const epoch = await financeEpoch();
  const start = range && range.start ? (epoch && range.start < epoch ? epoch : range.start) : epoch || null;
  const end = range && range.end ? range.end : null;
  return { start, end };
}
const whenWhere = (field, w) => (w.start || w.end
  ? { [field]: { ...(w.start ? { gte: w.start } : {}), ...(w.end ? { lte: w.end } : {}) } }
  : {});

// What the business paid out as expenses in a window — EXACTLY the population every P&L counts.
async function expensesBetween(range) {
  const w = await epochWindow(range);
  const agg = await prisma.financeTransaction.aggregate({
    where: { direction: 'OUT', type: 'EXPENSE', ...whenWhere('occurredAt', w) },
    _sum: { amount: true },
  });
  return round2(toNumber(agg._sum.amount));
}

// Stock lost in a window, valued at what the boxes cost: written off (DAMAGE, and STOCK_COUNT shortages — the
// rows that take boxes away), and boxes bought on a purchase order that arrived damaged or never came (valued at
// the order line's landed cost). byBrand lets a brand's own net take its own losses.
async function stockLosses(range) {
  const w = await epochWindow(range);
  const [lossRows, receivingRows] = await Promise.all([
    prisma.inventoryTransaction.findMany({
      where: { type: { in: ['DAMAGE', 'STOCK_COUNT'] }, baseQuantity: { lt: 0 }, ...whenWhere('occurredAt', w) },
      select: { baseQuantity: true, unitCost: true, product: { select: { brandId: true } } },
    }),
    prisma.purchaseReceiptItem.findMany({
      where: {
        ...(w.start || w.end ? { receipt: { is: whenWhere('arrivedAt', w) } } : {}),
        OR: [{ damagedBase: { gt: 0 } }, { missingBase: { gt: 0 } }],
      },
      select: {
        damagedBase: true, missingBase: true,
        purchaseOrderItem: { select: { landedUnitCost: true, unitCost: true, product: { select: { brandId: true } } } },
      },
    }),
  ]);
  const byBrand = new Map();
  const add = (brandId, v) => byBrand.set(brandId || 'none', (byBrand.get(brandId || 'none') || 0) + v);
  let writtenOff = 0;
  for (const r of lossRows) {
    const v = Math.abs(r.baseQuantity) * toNumber(r.unitCost);
    writtenOff += v;
    add(r.product?.brandId, v);
  }
  let receivingLoss = 0;
  for (const r of receivingRows) {
    const unit = toNumber(r.purchaseOrderItem?.landedUnitCost) || toNumber(r.purchaseOrderItem?.unitCost);
    const v = (r.damagedBase + r.missingBase) * unit;
    receivingLoss += v;
    add(r.purchaseOrderItem?.product?.brandId, v);
  }
  return {
    writtenOff: round2(writtenOff),
    receivingLoss: round2(receivingLoss),
    total: round2(writtenOff + receivingLoss),
    byBrand: new Map([...byBrand].map(([k, v]) => [k, round2(v)])),
  };
}

// The same P&L over several windows at once — today, this week, this month —
// read in ONE pass over the widest of them. Three separate profitOverview
// calls would each re-read the sales and re-value the whole warehouse, on a
// dashboard that refreshes every 30 seconds.
//
// Commission and stock valuation are deliberately left out: these are the
// headline revenue/profit/boxes figures, and the full picture is still one
// call to profitOverview.
async function profitByPeriods(periods = ['today', 'week', 'month']) {
  const epoch = await financeEpoch();
  const ranges = {};
  for (const period of periods) {
    let range = resolveRange({ period });
    if (epoch && range.start < epoch) range = { ...range, start: epoch };
    ranges[period] = range;
  }
  const list = Object.values(ranges);
  // This week can begin in the month before it — a Monday that falls on the
  // 29th — so the read starts at the earliest of the windows, not the month's.
  const from = new Date(Math.min(...list.map((r) => r.start.getTime())));
  const to = new Date(Math.max(...list.map((r) => r.end.getTime())));

  const [items, products] = await Promise.all([
    prisma.saleItem.findMany({
      where: { sale: { is: { ...NON_CANCELLED, soldAt: { gte: from, lte: to } } } },
      select: {
        baseQuantity: true,
        lineTotal: true,
        unitCost: true,
        productId: true,
        sale: { select: { soldAt: true, discount: true, subtotal: true } },
      },
    }),
    prisma.product.findMany({ select: { id: true, name: true, purchasePrice: true, brand: { select: { id: true, name: true } } } }),
  ]);
  const pMap = new Map(products.map((p) => [p.id, p]));

  const blank = () => newTally({ byBrand: new Map(), byProduct: new Map() });
  const buckets = new Map(periods.map((period) => [period, blank()]));
  for (const it of items) {
    const p = pMap.get(it.productId);
    if (!p) continue;
    const f = lineFinancials(it, p);
    const soldAt = new Date(it.sale.soldAt).getTime();
    for (const period of periods) {
      const r = ranges[period];
      if (soldAt < r.start.getTime() || soldAt > r.end.getTime()) continue;
      const b = buckets.get(period);
      addLine(b, f);
      const bId = p.brand?.id || 'none';
      const row = b.byBrand.get(bId) || newTally({ brandId: bId, name: p.brand?.name || '—' });
      addLine(row, f);
      b.byBrand.set(bId, row);
      // Per product too, so a brand's top product can be named for THIS window (audit admin-ops-1).
      const pr = b.byProduct.get(it.productId) || { productId: it.productId, name: p.name, brandId: p.brand?.id || null, revenue: 0, boxes: 0 };
      pr.revenue += f.revenue; pr.boxes += f.boxes;
      b.byProduct.set(it.productId, pr);
    }
  }
  const shape = (o) => {
    const x = profitOf(o);
    return { revenue: x.revenue, profit: x.profit, boxes: o.boxes, margin: x.margin, noCost: x.noCost };
  };
  const out = {};
  for (const period of periods) {
    const b = buckets.get(period);
    out[period] = {
      ...shape(b),
      range: { start: ranges[period].start, end: ranges[period].end },
      byBrand: [...b.byBrand.values()].map((r) => ({ brandId: r.brandId, name: r.name, ...shape(r) })),
      byProduct: [...b.byProduct.values()]
        .map((r) => ({ productId: r.productId, name: r.name, brandId: r.brandId, revenue: round2(r.revenue), boxes: r.boxes }))
        .sort((a, b2) => b2.revenue - a.revenue),
    };
  }
  return out;
}

// Accepts a period string ('today'|'week'|'month'|'year'|'all') or an options
// object { period, from, to } for custom date ranges. All ranges are clamped
// to the finance epoch — pre-epoch sales never count toward profit figures.
async function profitOverview(opts = 'month') {
  const o = typeof opts === 'string' ? { period: opts } : opts || {};
  let range = o.start && o.end
    ? resolveRange({ start: o.start, end: o.end })
    : o.from || o.to
      ? resolveRange({ from: o.from, to: o.to })
      : o.period && o.period !== 'all' ? resolveRange({ period: o.period }) : null;
  const epoch = await financeEpoch();
  if (epoch) {
    if (!range) range = { start: epoch, end: new Date() };
    else if (range.start < epoch) range = { ...range, start: epoch };
  }
  const period = o.period || 'custom';
  const where = { sale: { is: { ...NON_CANCELLED } } };
  if (range) where.sale.is.soldAt = { gte: range.start, lte: range.end };

  const [items, products, reps, val] = await Promise.all([
    prisma.saleItem.findMany({
      where,
      select: {
        baseQuantity: true,
        lineTotal: true,
        unitCost: true,
        productId: true,
        sale: {
          select: {
            salesRepId: true,
            discount: true,
            subtotal: true,
            settlementId: true,
            settlement: { select: { issuedAt: true, createdAt: true } },
          },
        },
      },
    }),
    prisma.product.findMany({ select: { id: true, name: true, purchasePrice: true, sellingPrice: true, createdAt: true, brand: { select: { id: true, name: true } } } }),
    prisma.salesRepresentative.findMany({ include: { user: { select: { name: true } } } }),
    inventory.valuation(prisma),
  ]);

  const pMap = new Map(products.map((p) => [p.id, p]));
  const repName = new Map(reps.map((r) => [r.id, r.user?.name || r.code]));
  const fin = (o) => {
    // Boxes sold before a buying price was set are in revenue and boxes, never in profit or margin (lineFinancials).
    const x = profitOf(o);
    const commission = round2(o.commission || 0);
    const { noCostRevenue, noCostBoxes, ...rest } = o; // eslint-disable-line no-unused-vars
    return {
      ...rest,
      revenue: x.revenue,
      cost: x.cost,
      profit: x.profit,
      margin: x.margin,
      noCost: x.noCost,
      // Reported, never deducted. The owner pays every rep from his own
      // pocket, so commission never comes out of the business's money and has
      // no business reducing what the business made. It is carried here so a
      // screen can say what the boxes earned reps, as information.
      commission,
      // What the business keeps: the money in, less what the boxes cost.
      contribution: x.profit,
      contributionMargin: x.margin,
    };
  };

  const total = newTally({ commission: 0 });
  const byBrand = new Map();
  const byProduct = new Map();
  const byRep = new Map();

  const commission = require('./commission.service');
  for (const it of items) {
    const p = pMap.get(it.productId);
    if (!p) continue;
    // Revenue net of discount, cost frozen at the sale — see lineFinancials.
    const f = lineFinancials(it, p);
    // Commission accrues the moment a box settles, priced by the ORDER's date
    // — so it is a real cost of these very boxes, not of some later payout.
    // Direct warehouse sales have no settlement and no commission.
    const comm = it.sale?.settlementId
      ? it.baseQuantity * (await commission.rateForBrandAt(p.brand?.name, it.sale.settlement?.issuedAt || it.sale.settlement?.createdAt, p.createdAt))
      : 0;
    addLine(total, f); total.commission += comm;

    const bId = p.brand?.id || 'none';
    const b = byBrand.get(bId) || newTally({ brandId: bId, name: p.brand?.name || '—', commission: 0 });
    addLine(b, f); b.commission += comm; byBrand.set(bId, b);

    const pr = byProduct.get(it.productId) || newTally({
      productId: it.productId, name: p.name, brandName: p.brand?.name || '—', commission: 0,
      catalogueProfitPerBox: toNumber(p.sellingPrice) - toNumber(p.purchasePrice),
      // No buying price on the product today: its catalogue profit is not known either.
      catalogueCostKnown: toNumber(p.purchasePrice) > 0,
    });
    addLine(pr, f); pr.commission += comm; byProduct.set(it.productId, pr);

    const rid = it.sale?.salesRepId || 'direct';
    const r = byRep.get(rid) || newTally({ salesRepId: rid, name: rid === 'direct' ? 'Direct (admin)' : (repName.get(rid) || '—'), commission: 0 });
    addLine(r, f); r.commission += comm; byRep.set(rid, r);
  }

  return {
    period: period || 'custom',
    // The window the figures actually cover — with an epoch set, "All time"
    // is really "since go-live", and the client must be able to say so.
    range: range ? { start: range.start, end: range.end } : null,
    epochAt: epoch || null,
    totals: { ...fin(total), boxes: total.boxes },
    byBrand: [...byBrand.values()].map(fin).sort((a, b) => b.profit - a.profit),
    byProduct: [...byProduct.values()]
      .map((p) => {
        const x = fin(p);
        const costedBoxes = p.boxes - (p.noCostBoxes || 0);
        return {
          ...x,
          // Actual money per box in THIS period, not today's catalogue spread —
          // the catalogue figure is returned alongside, labelled as such. Only
          // boxes with a known cost count (no buying price = no profit per box).
          profitPerBox: costedBoxes > 0 ? round2(x.profit / costedBoxes) : 0,
          catalogueProfitPerBox: p.catalogueCostKnown ? round2(p.catalogueProfitPerBox) : null,
        };
      })
      .sort((a, b) => b.profit - a.profit),
    byRep: [...byRep.values()].filter((r) => r.boxes > 0).map(fin).sort((a, b) => b.profit - a.profit),
    inventoryValue: {
      costValue: val.totals.totalValue,
      potentialRevenue: val.totals.retailValue,
      potentialProfit: round2(toNumber(val.totals.retailValue) - toNumber(val.totals.totalValue)),
      units: val.totals.totalBaseUnits,
    },
  };
}

async function inventoryMovementReport(params = {}) {
  const range = resolveRange(params);
  const where = { occurredAt: { gte: range.start, lte: range.end } };
  if (params.productId) where.productId = params.productId;
  if (params.type) where.type = params.type;
  if (params.warehouseId) where.warehouseId = params.warehouseId;
  if (params.salesRepId) where.salesRepId = params.salesRepId;

  const [rows, byType] = await Promise.all([
    prisma.inventoryTransaction.findMany({
      where,
      include: {
        product: { select: { name: true, sku: true, baseUnitName: true } },
        packagingUnit: { select: { name: true } },
        warehouse: { select: { name: true } },
        salesRep: { include: { user: { select: { name: true } } } },
        user: { select: { name: true } },
      },
      orderBy: { occurredAt: 'desc' },
      take: params.limit || 500,
    }),
    prisma.inventoryTransaction.groupBy({
      by: ['type'],
      where,
      _sum: { baseQuantity: true },
      _count: true,
    }),
  ]);

  return {
    range: { start: range.start, end: range.end, label: range.label },
    summaryByType: byType.map((t) => ({
      type: t.type,
      netBase: t._sum.baseQuantity || 0,
      count: t._count,
    })),
    movements: rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt,
      type: r.type,
      product: r.product.name,
      sku: r.product.sku,
      quantity: r.quantity,
      unit: r.packagingUnit?.name,
      baseQuantity: r.baseQuantity,
      location:
        r.locationType === 'WAREHOUSE' ? r.warehouse?.name : r.salesRep?.user?.name,
      user: r.user?.name,
      notes: r.notes,
    })),
  };
}

// Convenience bundle for the debt report screen / export.
async function debtReport() {
  return credit.debtSummary();
}

async function inventoryValuationReport() {
  return inventory.valuation(prisma);
}

module.exports = {
  salesReport,
  productPerformance,
  regionalPerformance,
  salesRepPerformance,
  profitReport,
  profitOverview,
  profitByPeriods,
  lineFinancials,
  newTally,
  addLine,
  profitOf,
  noCostLines,
  netProfitOf,
  expensesBetween,
  stockLosses,
  revenueByRegionRule,
  financeEpoch,
  inventoryMovementReport,
  debtReport,
  inventoryValuationReport,
};
