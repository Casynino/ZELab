'use strict';

// ── Pepa gets every alert the other brands get (Nino, 15 Nov 2026) ──────────────────────────────────
// "Pepa should work as normal as other brands, get notifications just like others — always make sure of
// that." Pepa is listed first, under its own heading, with its full product names, in every WhatsApp list.

const test = require('node:test');
const assert = require('node:assert/strict');
const wt = require('../src/services/whatsappText');

const P1 = 'Pepa Ndogo (Brown) Bila Filter';
const P2 = 'Pepa Ndogo Kubwa (Brown) Bila Filter';
const O = 'OHIS Ndogo (Brown) Bila Filter';
const C = 'Civlily Kubwa (Brown) Na Filter';
const order = (text, words) => words.map((w) => text.indexOf(w));
const rising = (xs) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]));

test('a stock request lists Pepa first, under its own heading, then OHIS and Civlily', () => {
  const text = wt.owner.stockRequest({
    by: 'Nyoya', city: 'Dar es Salaam', total: 365000,
    items: [{ name: O, qty: 10, unit: 'Box', boxes: 10 }, { name: C, qty: 1, unit: 'Box', boxes: 1 }, { name: P2, qty: 1, unit: 'Box', boxes: 1 }, { name: P1, qty: 1, unit: 'Box', boxes: 1 }],
  });
  assert.ok(rising(order(text, ['\nPepa\n', 'Ndogo (Brown) Bila Filter: 1 Box', 'Ndogo Kubwa (Brown) Bila Filter: 1 Box', '\nOHIS\n', '\nCivlily\n'])), text);
  assert.match(text, /Total Boxes: 13/);
});

test('low stock lists the Pepa products first, by their full names', () => {
  const [part] = wt.owner.stockAlerts({ items: [
    { name: O, brand: 'OHIS', remaining: 13, restock: 87 },
    { name: P2, brand: 'Pepa', remaining: 0, restock: 50 },
    { name: P1, brand: 'Pepa', remaining: 4, restock: 46 },
  ] });
  assert.ok(rising(order(part.text, [`(1) ${P1}`, `(2) ${P2}`, `(3) ${O}`])), part.text);
});

test('a rep approval, a return and a settlement carry the Pepa products too', () => {
  const approved = wt.repText({ kind: 'STOCK_REQUEST_APPROVED', request: 'REQ-1', items: [{ name: O, approved: 10, requested: 10, unit: 'Box' }, { name: P1, approved: 1, requested: 1, unit: 'Box' }] });
  assert.ok(rising(order(approved, ['\nPepa\n', '(1) Ndogo (Brown) Bila Filter: 1 Box', '\nOHIS\n'])), approved);
  const ret = wt.owner.returnRequest({ by: 'Nyoya', items: [{ name: P2, quantity: 2 }] });
  assert.match(ret, /Pepa\n\(1\) Ndogo Kubwa \(Brown\) Bila Filter: 2 Boxes/);
  const settled = wt.owner.settlementSubmitted({ by: 'Nyoya', order: 'REQ-1', product: P1, boxes: 3, amount: 90000, method: 'Airtel Money', commission: 18000 });
  assert.match(settled, /\(1\) Pepa Ndogo \(Brown\) Bila Filter\nBoxes Sold: 3/);
  assert.match(settled, /Commission: TSh 18,000/);
});
