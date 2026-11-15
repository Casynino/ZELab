'use strict';

// 15 Nov 2026 audit fixes in sales, refunds, credit and profit (batch sales-profit). The money paths (contra
// rows, payments into an account) are pinned in sale-refund.test.js; the profit maths in profit-periods.test.js.
// Here: the smaller rules — each was also run once against a real copy of the database.

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (rel, exports) => { const f = require.resolve(rel); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
const fresh = (rel) => { delete require.cache[require.resolve(rel)]; return require(rel); };

// ── sale07: the old customer-return type is refused; a customer's boxes come back as a refund on the sale ──
test('a CUSTOMER_RETURN return can no longer be created or approved', async () => {
  let wrote = 0;
  stub('../src/config/prisma', {
    return: {
      findUnique: async () => ({ id: 'r1', status: 'PENDING', type: 'CUSTOMER_RETURN' }),
      updateMany: async () => { wrote += 1; return { count: 1 }; },
      create: async () => { wrote += 1; return {}; },
    },
    $transaction: async () => { wrote += 1; },
  });
  const returns = fresh('../src/services/returns.service');
  await assert.rejects(
    returns.createReturn({ type: 'CUSTOMER_RETURN', warehouseId: 'w1', items: [{ productId: 'p', packagingUnitId: 'b', quantity: 1 }] }, { id: 'u' }),
    (e) => e.statusCode === 400 && /refund on the sale/.test(e.message),
  );
  await assert.rejects(returns.approveReturn('r1', { id: 'u' }), (e) => e.statusCode === 400 && /refund/.test(e.message));
  assert.equal(wrote, 0, 'nothing written');
});

// ── sale10: invoice numbers from one counter on the server ──
test('invoice numbers: one counter a year, never below what a device already handed out', async () => {
  const calls = [];
  let value = 0;
  const client = {
    $executeRaw: async (strings, ...vals) => { calls.push({ sql: strings.join('?'), vals }); return 0; },
    $queryRaw: async (strings, ...vals) => {
      calls.push({ sql: strings.join('?'), vals });
      const floor = vals[0];
      value = Math.max(value, floor) + 1; // what GREATEST(value, floor) + 1 does
      return [{ value: String(value) }];
    },
  };
  const inv = fresh('../src/services/invoice.service');
  const a = await inv.nextInvoiceNumber({}, client);
  const b = await inv.nextInvoiceNumber({ after: 40 }, client);
  const c = await inv.nextInvoiceNumber({ after: 5 }, client);
  assert.match(a.number, /^INV-\d{4}-001$/);
  assert.equal(b.seq, 41);
  assert.equal(c.seq, 42, 'a device behind the counter never takes a number twice');
  assert.match(calls[0].sql, /ON CONFLICT \("key"\) DO NOTHING/);
  assert.match(calls[1].sql, /UPDATE "settings"[\s\S]*RETURNING "value"/);
  assert.equal(inv.format(2026, 7), 'INV-2026-007');
  // A silly floor is clamped, never trusted.
  await inv.nextInvoiceNumber({ after: 1e12 }, client);
  assert.equal(calls[calls.length - 1].vals[0], 1_000_000);
});

// ── purc01: a late cost on a partly received order — the share of boxes already accepted ──
test('a late cost is shared by goods value; only boxes already accepted take their share now', () => {
  const { lateCostOnAccepted } = fresh('../src/services/purchase.service');
  const po = {
    items: [
      // 10 boxes at 12,000 (120,000), 4 received, 1 of them damaged → 3 accepted.
      { productId: 'a', unitCost: 12000, baseQuantity: 10, receivedBase: 4, damagedBase: 1, missingBase: 0 },
      // 20 boxes at 4,000 (80,000), none in yet.
      { productId: 'b', unitCost: 4000, baseQuantity: 20, receivedBase: 0, damagedBase: 0, missingBase: 0 },
    ],
  };
  const m = lateCostOnAccepted(po, 10000);
  // Line a carries 120/200 of the 10,000 = 6,000 over its 10 boxes = 600 a box; 3 accepted → 1,800.
  assert.equal(Math.round(m.get('a')), 1800);
  assert.equal(m.has('b'), false);
});
