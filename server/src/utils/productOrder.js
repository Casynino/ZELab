'use strict';

// The fixed product order, the same as the client's src/lib/productOrder.js (keep the two lists in step).
// Pepa first (15 Nov 2026), then OHIS, then Civlily; within a brand the curated order, never alphabetical.
// Matching is by name, normalised so dash / space / case variants (names lost their dash on 12 Nov 2026) and the old long names
// ("OHIS Pepa Ndogo …", "(Mix Colors)") match today's short ones. A product not in the list sorts after
// the listed ones, alphabetically.

const CANONICAL = [
  // ── Pepa (listed first, 15 Nov 2026) ──
  'Pepa Ndogo',
  'Pepa Ndogo Kubwa',
  // ── OHIS ──
  'OHIS Ndogo (Brown) Bila Filter',
  'OHIS Ndogo (White) Bila Filter',
  'OHIS Ndogo (Brown) Na Filter',
  'OHIS Kubwa (Brown) Na Filter',
  'OHIS Kubwa (Brown) Bila Filter',
  // ── Civlily ──
  'Civlily Ndogo (Brown) Bila Filter',
  'Civlily Ndogo (White) Bila Filter',
  'Civlily Ndogo (Brown) Na Filter',
  'Civlily Kubwa (Brown) Bila Filter',
  'Civlily Kubwa (White) Bila Filter',
  'Civlily Kubwa (Brown) Na Filter',
  'Civlily Kubwa (Mix) Na Filter',
  'Civlily Ndogo (Mix) Bila Filter',
];

function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    // The old long names ("OHIS Pepa Ndogo …") said "Pepa" after the brand; Pepa as a brand of its own keeps it.
    .replace(/\b(ohis|civlily)\s+pepa\s+/g, '$1 ')
    .replace(/\(mix colou?rs\)/g, '(mix)')
    .replace(/\s+[-‒–—―]+\s+/g, ' ') // "(Brown) – Bila Filter" (the old names) = "(Brown) Bila Filter"
    .replace(/\s+/g, ' ')
    .trim();
}

const RANK = new Map(CANONICAL.map((n, i) => [normalizeName(n), i]));

function productRank(name) {
  const r = RANK.get(normalizeName(name));
  return r === undefined ? Number.MAX_SAFE_INTEGER : r;
}

function compareProducts(a, b) {
  const ra = productRank(a);
  const rb = productRank(b);
  if (ra !== rb) return ra - rb;
  return String(a || '').localeCompare(String(b || ''));
}

// Brands in the owner's order: Pepa, OHIS, then Civlily, then any other brand alphabetically, no brand last.
const BRAND_RANK = { pepa: 0, ohis: 1, civlily: 2 };
function compareBrands(a, b) {
  const ka = String(a || '').trim().toLowerCase();
  const kb = String(b || '').trim().toLowerCase();
  const ra = BRAND_RANK[ka] ?? (ka ? 3 : 4);
  const rb = BRAND_RANK[kb] ?? (kb ? 3 : 4);
  if (ra !== rb) return ra - rb;
  return ka.localeCompare(kb);
}

module.exports = { CANONICAL, normalizeName, productRank, compareProducts, compareBrands };
