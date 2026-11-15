'use strict';

// Several products in one stock adjustment or damage entry (Nino, 15 Nov 2026: "I should be able to adjust more
// than one product"). The one-product body still works; the list is moved in one transaction, product by product
// in a fixed order; each product once.

const test = require('node:test');
const assert = require('node:assert/strict');

const install = (path, exports) => {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const moved = [];
const audits = [];
const saved = new Set(); // clientKeys already on the ledger
const tx = {
  inventoryTransaction: { findFirst: async ({ where }) => (saved.has(where.referenceId) ? { id: 'row' } : null) },
  settlement: { findMany: async () => [] },
  product: {
    findUnique: async () => ({ name: 'Pepa', purchasePrice: 1000 }),
    findMany: async ({ where }) => where.id.in.map((id) => ({ id, purchasePrice: id === 'pB' ? 2000 : 1000 })),
  },
};
install('../src/config/prisma', { $transaction: async (fn) => fn(tx) });
install('../src/services/audit.service', { record: async (_req, a) => { audits.push(a); } });
install('../src/services/settlement.service', { productOutstanding: async () => 0 });
install('../src/services/inventory.service', {
  LOCATION: { WAREHOUSE: 'WAREHOUSE', SALES_REP: 'SALES_REP' },
  convertToBase: async (_c, _p, _u, quantity) => ({ baseQuantity: quantity }),
  getBalance: async () => 0,
  increaseStock: async (_c, o) => { moved.push({ dir: 'in', ...o }); return { id: `in-${o.productId}` }; },
  decreaseStock: async (_c, o) => { moved.push({ dir: 'out', ...o }); return { id: `out-${o.productId}` }; },
});

const ctrl = require('../src/controllers/inventory.controller');
const { adjustment, damage } = require('../src/validators/inventory.validator');

function call(handler, body, role = 'ADMIN') {
  return new Promise((resolve) => {
    const res = { status() { return this; }, json: (payload) => resolve({ ok: payload }) };
    handler({ body, user: { id: 'admin', role } }, res, (err) => resolve({ err }));
  });
}
const place = { type: 'WAREHOUSE', warehouseId: 'w1' };
const reset = () => { moved.length = 0; audits.length = 0; };

test('an adjustment with several products moves every one, in product order, each with its own cost and audit line', async () => {
  reset();
  const items = [{ productId: 'pB', packagingUnitId: 'u', quantity: 3 }, { productId: 'pA', packagingUnitId: 'u', quantity: 10 }];
  const { ok, err } = await call(ctrl.adjust, { location: place, items, direction: 'DECREASE', reason: 'Counted wrong' });
  assert.equal(err, undefined);
  assert.deepEqual(ok.data.movements.map((m) => m.id), ['out-pA', 'out-pB']);
  assert.deepEqual(moved.map((m) => [m.productId, m.quantity, m.unitCost, m.type, m.notes]), [['pA', 10, 1000, 'ADJUSTMENT', 'Counted wrong'], ['pB', 3, 2000, 'ADJUSTMENT', 'Counted wrong']]);
  assert.deepEqual(audits.map((a) => [a.action, a.entityId, a.newValues.quantity, a.newValues.products]), [['ADJUSTMENT', 'pA', 10, 2], ['ADJUSTMENT', 'pB', 3, 2]]);
});

test('add boxes and record damage take a list too', async () => {
  reset();
  const items = [{ productId: 'pA', packagingUnitId: 'u', quantity: 2 }, { productId: 'pB', packagingUnitId: 'u', quantity: 1 }];
  await call(ctrl.adjust, { location: place, items, direction: 'INCREASE', reason: 'Found', clientKey: 'press-found-1' });
  assert.deepEqual(moved.map((m) => m.dir), ['in', 'in']);
  reset();
  const { ok } = await call(ctrl.damage, { location: place, items, reason: 'Wet' });
  assert.deepEqual(moved.map((m) => [m.dir, m.type]), [['out', 'DAMAGE'], ['out', 'DAMAGE']]);
  assert.equal(ok.data.movements.length, 2);
});

test('the one-product body still works and still answers with the one movement', async () => {
  reset();
  const { ok } = await call(ctrl.adjust, { location: place, productId: 'pA', packagingUnitId: 'u', quantity: 4, direction: 'DECREASE', reason: 'x' });
  assert.equal(ok.data.id, 'out-pA');
  assert.equal(moved.length, 1);
});

test('the request is checked: one product or a list, never both or neither; each product once; at least one', () => {
  const ok = (schema, body) => schema.body.safeParse({ location: place, reason: 'r', ...body }).success;
  const line = (productId, quantity = 1) => ({ productId, packagingUnitId: 'cku000000000000000000unit', quantity });
  const A = 'cku000000000000000000000a';
  const B = 'cku000000000000000000000b';
  assert.ok(ok(adjustment, { direction: 'DECREASE', items: [line(A), line(B)] }));
  assert.ok(ok(adjustment, { direction: 'DECREASE', productId: A, packagingUnitId: A, quantity: 2 }));
  assert.ok(!ok(adjustment, { direction: 'DECREASE' }), 'neither');
  assert.ok(!ok(adjustment, { direction: 'DECREASE', items: [line(A)], productId: A, packagingUnitId: A, quantity: 1 }), 'both');
  assert.ok(!ok(adjustment, { direction: 'DECREASE', items: [line(A), line(A, 2)] }), 'the same product twice');
  assert.ok(!ok(adjustment, { direction: 'DECREASE', items: [] }), 'empty list');
  assert.ok(!ok(adjustment, { direction: 'DECREASE', items: [line(A, 0)] }), 'zero');
  assert.ok(ok(damage, { items: [line(A), line(B)] }));
  assert.ok(!ok(damage, { items: [line(A), line(A)] }));
});

// Audit reps-02 (15 Nov 2026): staff added stock outside the purchase orders with Adjust "Add boxes" — into the
// warehouse or into a rep's stock — and a double tap added it twice. Adding is the owner's, once per press.
test('only the owner adds boxes, and each press of the form adds once', async () => {
  reset();
  const line = { location: place, productId: 'pA', packagingUnitId: 'u', quantity: 2, direction: 'INCREASE', reason: 'Found' };
  const staff = await call(ctrl.adjust, { ...line, clientKey: 'press-staff-1' }, 'WAREHOUSE_STAFF');
  assert.equal(staff.err.statusCode, 403);
  const staffRep = await call(ctrl.adjust, { ...line, location: { type: 'SALES_REP', salesRepId: 'r1' }, clientKey: 'press-staff-2' }, 'WAREHOUSE_STAFF');
  assert.equal(staffRep.err.statusCode, 403);
  assert.equal((await call(ctrl.adjust, line)).err.statusCode, 400, 'the owner\'s press carries its key');
  assert.equal(moved.length, 0, 'nothing moved');

  const first = await call(ctrl.adjust, { ...line, clientKey: 'press-owner-1' });
  assert.equal(first.err, undefined);
  assert.equal(moved[0].referenceId, 'press-owner-1', 'the key is kept on the ledger row');
  saved.add('press-owner-1');
  const again = await call(ctrl.adjust, { ...line, clientKey: 'press-owner-1' });
  assert.equal(again.err.statusCode, 409);
  assert.equal(again.err.details.alreadySaved, true);
  assert.equal(moved.length, 1, 'added once');
});

test('staff still take boxes off and record damage, each press once', async () => {
  reset();
  const off = { location: place, productId: 'pA', packagingUnitId: 'u', quantity: 1, direction: 'DECREASE', reason: 'Counted wrong', clientKey: 'press-off-1' };
  assert.equal((await call(ctrl.adjust, off, 'WAREHOUSE_STAFF')).err, undefined);
  saved.add('press-off-1');
  assert.equal((await call(ctrl.adjust, off, 'WAREHOUSE_STAFF')).err.statusCode, 409);
  assert.equal((await call(ctrl.damage, { location: place, productId: 'pA', packagingUnitId: 'u', quantity: 1, reason: 'Wet' }, 'WAREHOUSE_STAFF')).err, undefined, 'a key is optional on a decrease');
  assert.deepEqual(moved.map((m) => [m.dir, m.type, m.referenceId]), [['out', 'ADJUSTMENT', 'press-off-1'], ['out', 'DAMAGE', null]]);
  const blank = adjustment.body.safeParse({ location: place, productId: 'cku000000000000000000000a', packagingUnitId: 'cku000000000000000000000a', quantity: 1, direction: 'DECREASE', reason: '   ' });
  assert.equal(blank.success, false, 'a reason of spaces is no reason');
});
