'use strict';

// Audit ui-ad01 / reps-01 (15 Nov 2026): the reorder list told warehouse staff what each line and the whole order
// cost at the buying price — a line's cost divided by its boxes was the product's buying price. Staff get the boxes.

const test = require('node:test');
const assert = require('node:assert/strict');

const install = (path, exports) => {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};
const line = (id, qty, value) => ({ productId: id, recommendedQty: qty, recommendedValue: value, urgency: 'HIGH' });
const sample = () => {
  const items = [line('a', 8, 220000), line('b', 0, 0)];
  return { summary: { reorderCount: 1, estimatedReorderValue: 220000, urgentValue: 220000, highCount: 1 }, recommendations: [items[0]], items };
};
install('../src/services/reorder.service', { reorderAnalysis: async () => sample(), lowStock: async () => [] });
const ctrl = require('../src/controllers/reorder.controller');

const call = (role) => new Promise((resolve, reject) => {
  const res = { status() { return this; }, json: resolve };
  ctrl.analysis({ query: {}, user: { id: 'u', role } }, res, reject);
});

test('staff get the boxes to order and no money; the owner gets both', async () => {
  const staff = (await call('WAREHOUSE_STAFF')).data;
  assert.deepEqual(staff.summary, { reorderCount: 1, highCount: 1 });
  assert.deepEqual(staff.recommendations.map((r) => [r.productId, r.recommendedQty, 'recommendedValue' in r]), [['a', 8, false]]);
  assert.ok(staff.items.every((r) => !('recommendedValue' in r)));
  const owner = (await call('ADMIN')).data;
  assert.equal(owner.summary.estimatedReorderValue, 220000);
  assert.equal(owner.summary.urgentValue, 220000);
  assert.equal(owner.items[0].recommendedValue, 220000);
});
