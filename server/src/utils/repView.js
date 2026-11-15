'use strict';

// What a sales rep must not see in a shared record: ZELab's own costs and margins (Rule: stock levels and
// purchase costs stay with the owner). Removes these keys at any depth of plain objects and arrays; Prisma
// Decimals, Dates and other class instances are left untouched.
const COST_KEYS = new Set([
  'unitCost', 'costTotal', 'purchasePrice', 'costPrice', 'profit', 'grossProfit', 'stockValue', 'margin',
  // Added 11 Nov 2026 (GET /sales summaries carried these): the cost of goods and the margins by any name.
  'cost', 'landedUnitCost', 'cogs', 'costOfSold', 'inventoryValue', 'grossMargin', 'netProfit',
  // Added 15 Nov 2026 (audit ui-re06): the boxes sold before a buying price was set — the owner's accounting
  // figure, carried in the GET /sales summary.
  'noCost', 'noCostRevenue', 'noCostBoxes',
]);

// CallMeBot keys (audit ui-r02 / perm02): anyone holding a rep's key and number can send his phone WhatsApp
// messages that look like ZELab's alerts. Every rep row a service includes carries it, so it went to warehouse
// staff (every rep's) and to each rep (his own) in ordinary lists. Only the owner sets and reads them — on the
// rep's profile and in Settings — so they leave every other answer here.
const SECRET_KEYS = new Set(['whatsappApiKey', 'apiKey', 'apikey', 'toApiKey']);

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

const stripSecrets = (value) => stripKeys(value, SECRET_KEYS);

// A rep also never sees the stock-control levels (audit perm06): they came along inside the product of every
// stock request and return, though GET /products already left them out. Nor anyone's WhatsApp key.
const REP_KEYS = new Set([...COST_KEYS, ...SECRET_KEYS, 'minStockLevel', 'reorderQuantity']);

// Warehouse staff see no purchase price, cost, profit or margin either (audit perm05 / ui-r03 / purc07, 15 Nov 2026:
// "what it cost is the owner's" — the purchase-order rule, now on every answer): products, sales, inventory and the
// dashboard carried them. Matched by name as well as by the list, so a figure under another name (costMonth,
// profitMonth, marginWeek, stockAtCost…) is covered too, and so is stock valued at cost. No WhatsApp keys either.
const STAFF_KEYS = new Set([...COST_KEYS, ...SECRET_KEYS, 'costValue', 'stockPotential']);
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

module.exports = { stripCosts, stripSecrets, forRole, COST_KEYS, SECRET_KEYS, stripProductStock, productsForRole, PRODUCT_STOCK_KEYS };
