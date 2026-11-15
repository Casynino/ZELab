'use strict';

// ── Cash-only purchasing: money moves at Confirm purchase, never at create ───
// A purchase used to be able to carry its own payment at the moment it was
// created (and before that could only be a debt). Since 15 Nov 2026 a new
// order is always a draft: nothing is owed for it and no money moves until
// Confirm purchase pays the whole order from one account (purchase.service
// confirmPurchase — covered against a real database in po-cash-flow.db.test.js).
// These tests hold the create side of that rule.

const test = require('node:test');
const assert = require('node:assert');

let tables;
let txCalls;

const model = (name) => ({
  create: async ({ data }) => {
    const row = { id: `${name}-${tables[name].length + 1}`, ...data };
    tables[name].push(row);
    txCalls.push(`${name}.create`);
    return row;
  },
  findUnique: async ({ where }) => tables[name].find((r) => r.id === where.id) || null,
  count: async () => tables[name].length,
  findMany: async () => tables[name], // document numbers read today's numbers
});

const tx = {
  purchaseOrder: model('purchaseOrder'),
  financeTransaction: model('financeTransaction'),
  supplier: { findUnique: async () => ({ name: 'OHIS yiwu', brandId: 'brand-ohis' }) },
  product: { findMany: async () => [] }, // none switched off (audit purc08)
  businessAccount: { findUnique: async () => ({ id: 'acct-1', isActive: true, type: 'CASH' }) },
};

const prismaStub = {
  $transaction: async (work) => work(tx),
  // The finance service reads these at module load through its own handle.
  businessAccount: tx.businessAccount,
  financeTransaction: tx.financeTransaction,
};

const install = (path, exports) => {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
install('../src/config/prisma', prismaStub);
install('../src/services/inventory.service', {
  convertToBase: async (_c, _p, _u, quantity) => ({ baseQuantity: quantity }),
});

const purchase = require('../src/services/purchase.service');

const payload = (over = {}) => ({
  supplierId: 'sup-1',
  orderedAt: '2026-09-26T12:00:00.000Z',
  items: [{ productId: 'p1', packagingUnitId: 'u1', quantity: 50, unitCost: 14_000 }],
  ...over,
});

test.beforeEach(() => {
  tables = { purchaseOrder: [], financeTransaction: [] };
  txCalls = [];
});

test('a new order is a draft and moves no money, even with an order date', async () => {
  await purchase.createPurchaseOrder(payload(), { id: 'admin-1' });
  assert.equal(tables.financeTransaction.length, 0);
  assert.equal(tables.purchaseOrder[0].status, 'DRAFT');
  assert.equal(tables.purchaseOrder[0].totalCost, 700_000); // 50 boxes x 14,000
});

test('a payment sent with a new order is refused, and nothing is written', async () => {
  // An older screen (a cached page) may still send one: it is refused outright, not half-obeyed.
  await assert.rejects(
    purchase.createPurchaseOrder(payload({ payment: { accountId: 'acct-1' } }), { id: 'admin-1' }),
    (e) => e.statusCode === 400 && /Confirm purchase/.test(e.message),
  );
  assert.equal(tables.purchaseOrder.length, 0);
  assert.equal(tables.financeTransaction.length, 0);
});
