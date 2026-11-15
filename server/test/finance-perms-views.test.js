'use strict';

// ── What staff and reps are sent, and the shape checks on money bodies (audit 15 Nov 2026) ─────────────
// perm05 / ui-r03 / purc07: warehouse staff get no purchase price, cost, profit or margin under any name, and the
// dashboard sends them no accounts, money flows, supplier debt or stock at cost. perm06: a rep never gets the
// stock-control levels. fina12 / fina13 / perm08 / sale15: amounts are whole shillings and real numbers,
// quantities have a ceiling, Ledger filters are checked, and a counter sale cannot be dated by hand.
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub@localhost:1/none';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only';

const { forRole } = require('../src/utils/repView');

const sale = () => ({
  id: 's1', total: 30000, costTotal: 12000, profit: 18000, margin: 60, sellingPrice: 30000,
  items: [{ unitPrice: 30000, unitCost: 12000, lineTotal: 30000, product: { name: 'OHIS', purchasePrice: '12000', minStockLevel: 50, reorderQuantity: 50 } }],
  brand: { profitMonth: 1, marginWeek: 2, costMonth: 3, stockAtCost: 4, stockPotential: 5, costValue: 6, salesMonth: 7 },
});

test('staff are sent no cost, profit or margin under any name; the owner gets everything', () => {
  const staff = forRole({ user: { role: 'WAREHOUSE_STAFF' } }, sale());
  const text = JSON.stringify(staff);
  assert.doesNotMatch(text, /cost|profit|margin|purchasePrice|stockPotential/i);
  assert.equal(staff.total, 30000);
  assert.equal(staff.items[0].lineTotal, 30000);
  assert.equal(staff.items[0].product.minStockLevel, 50, 'staff still see the reorder levels');
  assert.equal(staff.brand.salesMonth, 7);
  assert.deepEqual(forRole({ user: { role: 'ADMIN' } }, sale()), sale());
  assert.deepEqual(forRole({}, sale()), sale(), 'no one signed in (sign-in answer): untouched');
});

test('a rep is sent no cost and no stock-control levels', () => {
  const rep = forRole({ user: { role: 'SALES_REP' } }, sale());
  assert.equal(rep.items[0].product.minStockLevel, undefined);
  assert.equal(rep.items[0].product.reorderQuantity, undefined);
  assert.equal(rep.items[0].unitCost, undefined);
  assert.equal(rep.costTotal, undefined);
  assert.equal(rep.total, 30000);
});

// ── The dashboard for staff ──────────────────────────────────────────────────────────────────────────
const install = (path, exports) => {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
const command = () => ({
  accounts: [{ id: 'a1', name: 'M-Pesa', balance: 500000 }],
  totalFunds: 500000,
  today: { revenue: 90000, grossProfit: 54000, expenses: 1000, netProfit: 53000, moneyIn: 90000, moneyOut: 1000, netCash: 89000, boxesSold: 3 },
  week: { revenue: 1, grossProfit: 1, boxes: 1 },
  month: { revenue: 2, grossProfit: 2, boxes: 2 },
  brands: [{ name: 'OHIS', revenueMonth: 5, grossProfitMonth: 3, marginMonth: 60, inventoryValue: 9 }],
  reps: [],
  attention: { stockRequests: 1, supplierDue: 70000, lowStock: { count: 0, items: [] } },
  inventory: { costValue: 1000000, sellingValue: 2500000, units: 80 },
  charts: { daily: [{ date: 'x', revenue: 5, profit: 3, boxes: 1 }] },
});
install('../src/services/dashboard.service', { command: async () => command(), analysis: async () => ({}) });
const dashCtrl = require('../src/controllers/dashboard.controller');
const callAs = (handler, role) => new Promise((resolve, reject) => {
  const req = { user: { id: 'u', role }, query: {}, params: {} };
  const res = { status: () => res, json: (payload) => resolve(forRole(req, payload)) }; // as app.js sends it
  handler(req, res, (err) => (err ? reject(err) : resolve(null)));
});

test('staff home: the work, the sales and the boxes; none of the money', async () => {
  const { data } = await callAs(dashCtrl.command, 'WAREHOUSE_STAFF');
  assert.deepEqual(data.accounts, []);
  assert.equal(data.totalFunds, undefined);
  assert.deepEqual(data.today, { revenue: 90000, boxesSold: 3 });
  assert.equal(data.attention.supplierDue, undefined);
  assert.equal(data.attention.stockRequests, 1);
  assert.deepEqual(data.inventory, { sellingValue: 2500000, units: 80 });
  assert.doesNotMatch(JSON.stringify(data), /profit|margin|cost|inventoryValue/i);
  const owner = await callAs(dashCtrl.command, 'ADMIN');
  assert.deepEqual(owner.data, command());
});

// ── Shape checks ─────────────────────────────────────────────────────────────────────────────────────
const fv = require('../src/validators/finance.validator');
const { money, lineQuantity } = require('../src/validators/common.validator');
const { saleCreate } = require('../src/validators/sales.validator');

test('typed money is whole shillings; a Ledger filter the database cannot read is refused in words', () => {
  assert.equal(fv.financeMoney.body.safeParse({ amount: 100.555 }).success, false);
  assert.equal(fv.financeMoney.body.safeParse({ amount: '2500' }).data.amount, 2500);
  assert.equal(fv.financeAccountCreate.body.safeParse({ name: 'x', openingBalance: 10.5 }).success, false);
  const q = (query) => fv.financeTxnQuery.query.safeParse(query);
  for (const bad of [{ type: 'FOO' }, { direction: 'sideways' }, { minAmount: 'abc' }, { from: '2026-13-45' }]) {
    assert.equal(q(bad).success, false, JSON.stringify(bad));
  }
  const ok = q({ type: 'REP_COMMISSION', direction: 'OUT', from: '2026-11-01', to: '', minAmount: '', limit: '500', page: '2' });
  assert.equal(ok.success, true);
  assert.equal(ok.data.to, undefined);
  assert.equal(ok.data.limit, 500, 'a big page is cut by the pager, as before, not refused');
});

test('amounts are real numbers and quantities have a ceiling', () => {
  for (const bad of ['Infinity', '1e400', 1e15]) assert.equal(money.safeParse(bad).success, false, String(bad));
  assert.equal(money.safeParse('30000').data, 30000);
  assert.equal(lineQuantity.safeParse(2147483647).success, false);
  assert.equal(lineQuantity.safeParse(50).success, true);
});

test('a counter sale cannot be dated by hand', () => {
  const body = saleCreate.body.parse({
    type: 'CASH',
    warehouseId: 'cmwh0000000000000000000a',
    items: [{ productId: 'cmwh0000000000000000000b', packagingUnitId: 'cmwh0000000000000000000c', quantity: 1 }],
    soldAt: '2026-11-10T08:00:00Z',
  });
  assert.equal(body.soldAt, undefined);
});
