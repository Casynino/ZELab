'use strict';

// What a sales rep must not see in a shared record: ZELab's own costs and margins (Rule: stock levels and
// purchase costs stay with the owner). Removes these keys at any depth of plain objects and arrays; Prisma
// Decimals, Dates and other class instances are left untouched.
const COST_KEYS = new Set([
  'unitCost', 'costTotal', 'purchasePrice', 'costPrice', 'profit', 'grossProfit', 'stockValue', 'margin',
  // Added 11 Nov 2026 (GET /sales summaries carried these): the cost of goods and the margins by any name.
  'cost', 'landedUnitCost', 'cogs', 'costOfSold', 'inventoryValue', 'grossMargin', 'netProfit',
]);

function stripWhere(value, drop) {
  if (Array.isArray(value)) return value.map((v) => stripWhere(v, drop));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (drop(k)) continue;
      out[k] = stripWhere(v, drop);
    }
    return out;
  }
  return value;
}
const stripKeys = (value, keys) => stripWhere(value, (k) => keys.has(k));

const stripCosts = (value) => stripKeys(value, COST_KEYS);

// A rep also never sees the stock-control levels (audit perm06): they came along inside the product of every
// stock request and return, though GET /products already left them out.
const REP_KEYS = new Set([...COST_KEYS, 'minStockLevel', 'reorderQuantity']);

// Warehouse staff see no purchase price, cost, profit or margin either (audit perm05 / ui-r03 / purc07, 15 Nov 2026:
// "what it cost is the owner's" — the purchase-order rule, now on every answer): products, sales, inventory and the
// dashboard carried them. Matched by name as well as by the list, so a figure under another name (costMonth,
// profitMonth, marginWeek, stockAtCost…) is covered too, and so is stock valued at cost.
const STAFF_KEYS = new Set([...COST_KEYS, 'costValue', 'stockPotential']);
const staffDrop = (k) => STAFF_KEYS.has(k) || /cost|profit|margin/i.test(k);

// Applied to every JSON answer (app.js): a rep gets the rep view; anyone else who is not the owner gets the staff view.
const forRole = (req, data) => {
  const role = req.user && req.user.role;
  if (!role || role === 'ADMIN') return data;
  if (role === 'SALES_REP') return stripKeys(data, REP_KEYS);
  return stripWhere(data, staffDrop);
};

// What a sales rep must not see on a product (audit 11 Nov 2026, rep-app-2): how many boxes the
// warehouses hold, the minimum and reorder levels, and which other reps hold boxes of it and how many.
// Only the products answers carry these; a rep's own stock comes from his own endpoints, and the request
// sheet learns what is in stock from /stock-requests/available-products.
const PRODUCT_STOCK_KEYS = ['onHandBase', 'warehouseBase', 'lowStock', 'minStockLevel', 'reorderQuantity', 'warehouseBalances', 'repBalances'];

function stripProductStock(product) {
  if (Array.isArray(product)) return product.map(stripProductStock);
  if (!product || typeof product !== 'object') return product;
  const out = { ...product };
  for (const k of PRODUCT_STOCK_KEYS) delete out[k];
  return out;
}

const productsForRole = (req, data) => (req.user && req.user.role === 'SALES_REP' ? stripProductStock(data) : data);

module.exports = { stripCosts, forRole, COST_KEYS, stripProductStock, productsForRole, PRODUCT_STOCK_KEYS };
