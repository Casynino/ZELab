'use strict';

// What a sales rep must not see in a shared record: ZELab's own costs and margins (Rule: stock levels and
// purchase costs stay with the owner). Removes these keys at any depth of plain objects and arrays; Prisma
// Decimals, Dates and other class instances are left untouched.
const COST_KEYS = new Set([
  'unitCost', 'costTotal', 'purchasePrice', 'costPrice', 'profit', 'grossProfit', 'stockValue', 'margin',
  // Added 11 Nov 2026 (GET /sales summaries carried these): the cost of goods and the margins by any name.
  'cost', 'landedUnitCost', 'cogs', 'costOfSold', 'inventoryValue', 'grossMargin', 'netProfit',
]);

// CallMeBot keys (audit ui-r02 / perm02): anyone holding a rep's key and number can send his phone WhatsApp
// messages that look like ZELab's alerts. Every rep row a service includes carries it, so it went to warehouse
// staff (every rep's) and to each rep (his own) in ordinary lists. Only the owner sets and reads them — on the
// rep's profile and in Settings — so they leave every other answer here.
const SECRET_KEYS = new Set(['whatsappApiKey', 'apiKey', 'apikey', 'toApiKey']);
const REP_HIDDEN = new Set([...COST_KEYS, ...SECRET_KEYS]);

function stripKeys(value, keys) {
  if (Array.isArray(value)) return value.map((v) => stripKeys(v, keys));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (keys.has(k)) continue;
      out[k] = stripKeys(v, keys);
    }
    return out;
  }
  return value;
}

const stripCosts = (value) => stripKeys(value, COST_KEYS);
const stripSecrets = (value) => stripKeys(value, SECRET_KEYS);

// A rep loses costs and keys, staff lose keys, the owner (ADMIN) sees everything.
const forRole = (req, data) => {
  const role = req.user && req.user.role;
  if (!role || role === 'ADMIN') return data;
  return stripKeys(data, role === 'SALES_REP' ? REP_HIDDEN : SECRET_KEYS);
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
