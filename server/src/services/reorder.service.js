'use strict';

const prisma = require('../config/prisma');
const env = require('../config/env');
const inventory = require('./inventory.service');
const { toNumber, round2 } = require('../utils/money');
const { dayjs } = require('../utils/dates');

// Urgency bands, in days of cover. These are the numbers to argue about, and
// they are deliberately about time, not about the minimum-stock levels: a
// restock takes the better part of a week to land, two weeks is one ordering
// cycle, and past the target cover we already hold there is nothing to rush.
const CRITICAL_DAYS = 7;
const HIGH_DAYS = 14;

const groupDigits = (n) => Number(n || 0).toLocaleString('en-US');

// Orders that are bought (or, for an order from before Confirm purchase, ordered) and not all in yet — the
// same orders the Purchases page counts as "on the way". A draft is not bought; a cancelled or completed
// order brings nothing more.
const ON_THE_WAY = ['ORDERED', 'PURCHASED', 'IN_TRANSIT', 'PARTLY_RECEIVED'];

// Boxes per product already bought and still to come: what each line bought, less what was received and
// what was marked missing (will never come). Cargo takes about 35 days, so without this the page asked
// for the same goods again the day after they were paid for (audit purc02, 15 Nov 2026).
async function onTheWayByProduct(client) {
  const lines = await client.purchaseOrderItem.findMany({
    where: { purchaseOrder: { status: { in: ON_THE_WAY } } },
    select: { productId: true, baseQuantity: true, receivedBase: true, missingBase: true },
  });
  const map = new Map();
  for (const l of lines) {
    const left = Math.max(0, (l.baseQuantity || 0) - (l.receivedBase || 0) - (l.missingBase || 0));
    if (left > 0) map.set(l.productId, (map.get(l.productId) || 0) + left);
  }
  return map;
}

// Compute sales velocity and project days-of-cover for every active product,
// then recommend reorder quantities. "Days remaining" = on-hand / avg daily
// sales over the lookback window.
async function reorderAnalysis(options = {}) {
  const lookbackDays = options.lookbackDays || env.business.reorderLookbackDays;
  const coverDays = options.coverDays || 30; // target days of stock to hold
  const since = dayjs().subtract(lookbackDays, 'day').toDate();

  const [products, soldRows, onHandMap, warehouseMap, comingMap] = await Promise.all([
    prisma.product.findMany({
      where: { isActive: true },
      include: { brand: { select: { name: true } }, category: { select: { name: true } } },
    }),
    prisma.inventoryTransaction.groupBy({
      by: ['productId'],
      where: { type: { in: ['CASH_SALE', 'CREDIT_SALE'] }, occurredAt: { gte: since } },
      _sum: { baseQuantity: true }, // negative numbers (outflows)
    }),
    inventory.productOnHand(prisma),
    inventory.warehouseOnHand(prisma),
    onTheWayByProduct(prisma),
  ]);

  const soldMap = new Map(soldRows.map((r) => [r.productId, Math.abs(r._sum.baseQuantity || 0)]));

  const items = products.map((p) => {
    const onHand = onHandMap.get(p.id) || 0;
    // The minimum is a warehouse level (as the stock alerts measure it); boxes with reps still count
    // towards days of cover, since the pace includes what the reps settle.
    const inWarehouse = warehouseMap.get(p.id) || 0;
    const withReps = onHand - inWarehouse;
    // Bought and on its way: not on the shelf yet (so it does not change the cover or the urgency), but
    // never to be bought a second time.
    const onTheWay = comingMap.get(p.id) || 0;
    const soldBase = soldMap.get(p.id) || 0;
    const avgDaily = round2(soldBase / lookbackDays);
    const daysRemaining = avgDaily > 0 ? Math.floor(onHand / avgDaily) : null;

    const target = Math.ceil(avgDaily * coverDays);
    const belowMin = p.minStockLevel > 0 && inWarehouse <= p.minStockLevel;
    const minNote = withReps > 0
      ? `${groupDigits(inWarehouse)} in the warehouse, below your minimum of ${groupDigits(p.minStockLevel)}`
      : `below your minimum of ${groupDigits(p.minStockLevel)}`;
    const shortCover = daysRemaining !== null && daysRemaining <= coverDays;

    // Days of cover decides the rank, and nothing else does. The minimum-stock
    // levels were set once and never checked against real selling pace, so
    // letting belowMin force HIGH put four years of cover in the same band as
    // stock that runs dry on Friday — and a list where everything shouts ranks
    // nothing. Below the minimum is still worth topping up, so it earns LOW and
    // says so in its reason; it no longer overrides the clock.
    let urgency = 'OK';
    if (shortCover && daysRemaining <= CRITICAL_DAYS) urgency = 'CRITICAL';
    else if (shortCover && daysRemaining <= HIGH_DAYS) urgency = 'HIGH';
    else if (shortCover) urgency = 'MEDIUM';
    else if (onHand <= 0 && belowMin) urgency = 'MEDIUM'; // nothing on the shelf to sell at all
    else if (belowMin) urgency = 'LOW';

    // What to buy: the gap to the target cover (and to the warehouse minimum, where the cargo lands), less
    // what is already on its way. The supplier's pack size is a floor only where cover is genuinely short —
    // rounding a one-box top-up up to a 50-box pack is how a product with years of cover came to ask for
    // millions of shillings of stock — and only while something is still missing after the cargo.
    let recommendedQty = 0;
    if (urgency !== 'OK') {
      const gap = Math.max(target - onHand - onTheWay, p.minStockLevel - inWarehouse - onTheWay, 0);
      if (onTheWay > 0 && gap <= 0) recommendedQty = 0;
      else recommendedQty = urgency === 'LOW' ? gap : Math.max(gap, p.reorderQuantity || 0);
    }
    // Fully covered by cargo on the way: nothing to buy, so it is not a reorder (nor a reorder alert). Its
    // cover and urgency still say how soon the shelf runs dry.
    const covered = onTheWay > 0 && recommendedQty === 0;
    const needsReorder = urgency !== 'OK' && !covered;

    // One line saying why this row is on the list, so long cover reads as long
    // cover instead of hiding behind a colour.
    let reason;
    if (shortCover && daysRemaining <= 0) {
      reason = `out of stock — was selling ${avgDaily}/day`;
    } else if (shortCover) {
      reason = `runs out in ${groupDigits(daysRemaining)} day${daysRemaining === 1 ? '' : 's'} at ${avgDaily}/day`;
      if (belowMin) reason += `, and ${minNote}`;
    } else if (onHand <= 0) {
      reason = `out of stock, and nothing sold in the last ${lookbackDays} days`;
    } else if (belowMin) {
      reason = daysRemaining !== null
        ? `${minNote}, but ${groupDigits(daysRemaining)} days of cover`
        : `${minNote}, but nothing sold in the last ${lookbackDays} days`;
    } else {
      reason = daysRemaining !== null
        ? `${groupDigits(daysRemaining)} days of cover left`
        : `nothing sold in the last ${lookbackDays} days`;
    }
    if (onTheWay > 0) reason += `; ${groupDigits(onTheWay)} already bought and on the way`;

    let message = `${p.name} has ${onHand} ${p.baseUnitName}(s) on hand`;
    if (avgDaily > 0 && daysRemaining !== null) {
      message += `, selling ~${avgDaily}/day — projected to run out in approximately ${daysRemaining} day(s).`;
    } else {
      message += ' with no recent sales activity.';
    }
    if (onTheWay > 0) message += ` ${onTheWay} more already bought and on the way.`;

    return {
      productId: p.id,
      name: p.name,
      sku: p.sku,
      brand: p.brand?.name,
      category: p.category?.name,
      baseUnitName: p.baseUnitName,
      onHand,
      inWarehouse,
      withReps,
      onTheWay,
      minStockLevel: p.minStockLevel,
      avgDailySales: avgDaily,
      daysRemaining,
      belowMin,
      covered,
      needsReorder,
      urgency,
      reason,
      recommendedQty,
      recommendedValue: round2(recommendedQty * toNumber(p.purchasePrice)),
      message,
    };
  });

  const urgencyRank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, OK: 4 };
  items.sort((a, b) => {
    if (urgencyRank[a.urgency] !== urgencyRank[b.urgency]) {
      return urgencyRank[a.urgency] - urgencyRank[b.urgency];
    }
    const da = a.daysRemaining ?? Infinity;
    const db = b.daysRemaining ?? Infinity;
    return da - db;
  });

  const recommendations = items.filter((i) => i.needsReorder);
  const countOf = (u) => recommendations.filter((i) => i.urgency === u).length;
  // What it costs to fix only the rows that are actually running out — the
  // whole-list total is inflated by top-ups nobody needs to buy this month.
  const urgentValue = recommendations
    .filter((i) => i.urgency === 'CRITICAL' || i.urgency === 'HIGH')
    .reduce((s, i) => s + i.recommendedValue, 0);

  return {
    summary: {
      lookbackDays,
      coverDays,
      criticalDays: CRITICAL_DAYS,
      highDays: HIGH_DAYS,
      productsAnalyzed: items.length,
      reorderCount: recommendations.length,
      criticalCount: countOf('CRITICAL'),
      highCount: countOf('HIGH'),
      mediumCount: countOf('MEDIUM'),
      lowCount: countOf('LOW'),
      belowMinCount: items.filter((i) => i.belowMin).length,
      // Short of stock, but what is already bought and on the way covers it: nothing to buy for these.
      coveredCount: items.filter((i) => i.covered).length,
      noVelocityCount: items.filter((i) => i.avgDailySales === 0).length,
      estimatedReorderValue: round2(recommendations.reduce((s, i) => s + i.recommendedValue, 0)),
      urgentValue: round2(urgentValue),
    },
    recommendations,
    items,
  };
}

// Products at or below their configured minimum stock level in the warehouse — the level the stock
// alerts use. `onHand` is that warehouse figure; `withReps` is what is out with the reps on top of it.
async function lowStock() {
  const products = await prisma.product.findMany({
    where: { isActive: true },
    select: { id: true, name: true, sku: true, minStockLevel: true, baseUnitName: true },
  });
  const [total, inWarehouse] = await Promise.all([inventory.productOnHand(prisma), inventory.warehouseOnHand(prisma)]);
  return products
    .map((p) => {
      const onHand = inWarehouse.get(p.id) || 0;
      return { ...p, onHand, withReps: (total.get(p.id) || 0) - onHand };
    })
    .filter((p) => p.minStockLevel > 0 && p.onHand <= p.minStockLevel)
    .sort((a, b) => a.onHand - b.onHand);
}

module.exports = { reorderAnalysis, lowStock };
