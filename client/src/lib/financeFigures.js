// Small money figures the Finance screens work out from what the server sends. Pure, so they are tested
// without a browser (financeFigures.test.mjs).

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// An account statement, newest first: the balance after each row, walked back from today's balance.
// Page 2 onwards starts below the rows on the pages before it (newerNet = their in minus out, counted
// by the server from go-live only). Rows from before the books started (epochAt) are listed as history
// but are in no balance: they get balanceAfter null and beforeBooks true, and never move `running`.
export function statementRows(rows, balanceNow, newerNet, epochAt) {
  const epochMs = epochAt ? Date.parse(epochAt) : NaN;
  let running = r2(Number(balanceNow || 0) - Number(newerNet || 0));
  return (rows || []).map((t) => {
    if (Number.isFinite(epochMs) && Date.parse(t.occurredAt) < epochMs) {
      return { ...t, balanceAfter: null, beforeBooks: true };
    }
    const after = running;
    running = r2(after - (t.direction === 'IN' ? Number(t.amount) : -Number(t.amount)));
    return { ...t, balanceAfter: after, beforeBooks: false };
  });
}

// The most a purchase order can be paid: what is left on that order AND what the supplier is still owed
// overall (balance payments and goods returned already count). Never below zero.
export function poPayCap(orderOutstanding, supplierOutstanding) {
  const cap = Math.min(Number(orderOutstanding || 0), Number(supplierOutstanding ?? orderOutstanding ?? 0));
  return cap > 0 ? r2(cap) : 0;
}

// One sale's profit as a list row shows it, by the same rule as the sale's own detail (audit money02 / ui-ad02): only
// the lines with a known buying price count. A line saved with cost 0 was sold before its product had a buying
// price — its profit is not known, never "100% kept". `profit` is null when no line has a known cost;
// `unknownBoxes` says how many boxes were left out.
export function saleProfit(s) {
  const items = s?.items || [];
  const unknown = items.filter((it) => !(Number(it.unitCost) > 0) && Number(it.baseQuantity) > 0);
  const unknownBoxes = unknown.reduce((n, it) => n + Number(it.baseQuantity), 0);
  if (!unknown.length) return { profit: r2(Number(s?.total || 0) - Number(s?.costTotal || 0)), unknownBoxes: 0 };
  const known = items.filter((it) => Number(it.unitCost) > 0);
  if (!known.length) return { profit: null, unknownBoxes };
  // Revenue is net of the sale's discount, shared by line value — the server's lineFinancials rule.
  const subtotal = Number(s.subtotal) || 0;
  const share = subtotal > 0 ? (subtotal - Number(s.discount || 0)) / subtotal : 1;
  const knownRevenue = known.reduce((n, it) => n + Number(it.lineTotal || 0) * share, 0);
  return { profit: r2(knownRevenue - Number(s.costTotal || 0)), unknownBoxes };
}

// What each kind of ledger row is called (Finance and the owner's wallet card on Home).
export const TXN_TYPE_LABEL = {
  SETTLEMENT: 'Settlement received', WAREHOUSE_SALE: 'Warehouse sale', INCOME: 'Income',
  EXPENSE: 'Expense', STOCK_PURCHASE: 'Stock purchase', COMMISSION_PAYMENT: 'Commission paid',
  // Rep commission and bonuses paid from a business account (15 Nov 2026), shown apart from other expenses.
  REP_COMMISSION: 'Rep commissions',
  TRANSFER: 'Transfer', ADJUSTMENT: 'Adjustment',
  // the owner's own money, in the words of the Overview buttons ("Put my money in" / "Take profit out")
  OWNER_CONTRIBUTION: 'Your money in', OWNER_DRAWING: 'Profit taken out',
};
