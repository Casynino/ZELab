'use strict';

// A count of boxes in a sentence: "1 box", "2 boxes", "0 boxes" — never "box(es)" (audit ui-re03, 15 Nov 2026:
// the rep's notices read "1 box(es) of OHIS …" and "1 box(es) × TSh 5,000").
function boxCount(n) {
  const v = Number(n) || 0;
  return `${v} ${v === 1 ? 'box' : 'boxes'}`;
}

// The verb that goes with it: "1 box is", "2 boxes are".
const isAre = (n) => (Number(n) === 1 ? 'is' : 'are');

module.exports = { boxCount, isAre };
