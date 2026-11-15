'use strict';

// Audit ui-a12 (15 Nov 2026): the dashboard's "Boxes this year against last" plotted the months of this year
// that have not come yet as 0, so on 15 Nov the red line climbed to November and crashed to the floor in
// December. Those months are null now (the chart stops the line); last year stays whole.
const test = require('node:test');
const assert = require('node:assert/strict');
const { yearAgainstLast } = require('../src/services/dashboard.service');

const LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// The 24 months analysis() builds, oldest first, ending with the current one.
function last24(year, monthIndex) {
  const out = [];
  for (let i = 23; i >= 0; i -= 1) {
    const total = year * 12 + monthIndex - i;
    const y = Math.floor(total / 12);
    const m = total % 12;
    out.push({ key: `${y}-${m}`, label: LABELS[m], year: y, monthIndex: m });
  }
  return out;
}

test('in November, December of this year is null (not yet), every month before it is a figure, last year is whole', () => {
  const months = last24(2026, 10);
  const rows = yearAgainstLast(months, 2026, (m) => (m.year === 2026 ? 50 + m.monthIndex : 10));
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.map((r) => r.period), LABELS);
  assert.equal(rows[10].thisYear, 60); // November, the month we are in
  assert.equal(rows[11].thisYear, null); // December has not happened
  assert.ok(rows.slice(0, 11).every((r) => typeof r.thisYear === 'number'));
  assert.ok(rows.every((r) => r.lastYear === 10));
});

test('a month of this year that sold nothing is still 0, not null', () => {
  const months = last24(2026, 10);
  const rows = yearAgainstLast(months, 2026, () => 0);
  assert.equal(rows[3].thisYear, 0);
  assert.equal(rows[11].thisYear, null);
});

test('in January only January of this year has a figure', () => {
  const months = last24(2027, 0);
  const rows = yearAgainstLast(months, 2027, () => 5);
  assert.equal(rows[0].thisYear, 5);
  assert.ok(rows.slice(1).every((r) => r.thisYear === null));
  assert.ok(rows.every((r) => r.lastYear === 5));
});
