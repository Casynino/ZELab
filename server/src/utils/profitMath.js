'use strict';

// The pure profit maths every sales figure goes through. Kept apart from reports.service (15 Nov 2026) so the
// dashboard, Finance, the PDFs and the sales list all use the very same rules without loading the reports.
const { toNumber, round2 } = require('./money');

// What one sold line was worth, and what it cost. Every figure on the
// dashboard and in the reports comes through here, so "revenue this week" and
// "revenue this month" can never mean two different things.
//
// Revenue is net of the sale-level discount, allocated to each line by its
// share of the subtotal — lineTotal alone is pre-discount, so summing it would
// report money the customer never owed.
//
// Cost is the cost frozen when the box sold (SaleItem.unitCost) and nothing else
// (15 Nov 2026). A line saved with cost 0 was sold before its product had a
// buying price (Pepa: "buying price 0 until the first purchase order"): its cost
// is NOT KNOWN. It still counts in revenue and boxes, but never in profit or
// margin — every screen says it apart instead ("N boxes sold before a buying
// price was set — not in profit"). It used to fall back to today's purchase
// price (0 for Pepa = 100% profit; after a purchase order, a price that did not
// exist when the box sold — so Finance and the saved-cost reports disagreed).
// Past sales are never rewritten. `product` is still accepted from old callers.
function lineFinancials(it, product) { // eslint-disable-line no-unused-vars
  const saleDiscount = toNumber(it.sale?.discount);
  const saleSubtotal = toNumber(it.sale?.subtotal);
  const gross = toNumber(it.lineTotal);
  const revenue = saleDiscount > 0 && saleSubtotal > 0
    ? round2(gross - saleDiscount * (gross / saleSubtotal))
    : gross;
  const unitCost = toNumber(it.unitCost);
  const boxes = it.baseQuantity || 0;
  const costKnown = unitCost > 0 || boxes === 0;
  return { revenue, cost: costKnown ? boxes * unitCost : 0, boxes, costKnown };
}

// A running total of lines, and its profit with the no-cost lines kept out.
function newTally(extra = {}) {
  return { revenue: 0, cost: 0, boxes: 0, noCostRevenue: 0, noCostBoxes: 0, ...extra };
}
function addLine(t, f) {
  t.revenue += f.revenue;
  t.boxes += f.boxes;
  if (f.costKnown) t.cost += f.cost;
  else { t.noCostRevenue += f.revenue; t.noCostBoxes += f.boxes; }
  return t;
}
// revenue = everything sold; profit = (revenue of boxes with a known cost) − their cost; margin is over that same
// costed revenue, so a box with no buying price never shows as 100% kept. `noCost` says what was left out.
function profitOf(t) {
  const revenue = round2(t.revenue);
  const cost = round2(t.cost);
  const noCostRevenue = round2(t.noCostRevenue || 0);
  const costedRevenue = round2(revenue - noCostRevenue);
  const profit = round2(costedRevenue - cost);
  return {
    revenue,
    cost,
    profit,
    margin: costedRevenue > 0 ? round2((profit / costedRevenue) * 100) : 0,
    noCost: { boxes: t.noCostBoxes || 0, revenue: noCostRevenue },
  };
}

// ── Net profit: ONE definition (15 Nov 2026) ─────────────────────────────────
// The Dashboard, Finance (overview, report, PDFs) and Reports > Profit all print
//   Net profit = gross profit (boxes with a known cost)
//              − expenses (every EXPENSE paid out, rep payouts from an account included)
//              − stock lost (written off — damage, a count that came up short — and
//                boxes paid for on a purchase order that arrived damaged or never came).
// Stock lost is a real cost: the money left an account for boxes that will never
// sell, so no sale will ever carry their cost (it is a STOCK_PURCHASE, never an
// expense, so nothing else counts it). Commission is reported, never deducted here.
function netProfitOf({ grossProfit = 0, expenses = 0, stockLoss = 0 } = {}) {
  return round2(toNumber(grossProfit) - toNumber(expenses) - toNumber(stockLoss));
}

module.exports = { lineFinancials, newTally, addLine, profitOf, netProfitOf };
