'use strict';

const crypto = require('crypto');

// One press = one record, for the rep's Settle, Request and Return (audit ui-r00 / ui-r01, 15 Nov 2026).
//
// The app makes one `clientKey` each time such a window opens and sends it with the press. A second press of
// the same window — a double tap, or a retry after the first answer was lost on a weak line — must find what
// the first one saved instead of saving it again.
//
// The key becomes the new row's own id: a hash of what it is, who sent it and the key, so it has the same
// shape as every other id, one person can never reach another person's row with it, and the primary key
// itself makes a second row with it impossible — no new column, nothing a schema change has to add. The
// services look the id up first (under the order's lock where there is one) and hand back the first record.
//
// `part` numbers the rows one press creates (one per product on a several-at-once settle).
function keyedId(kind, ownerId, clientKey, part = 0) {
  if (!clientKey || !ownerId) return null;
  const digest = crypto.createHash('sha256').update(`${kind}|${ownerId}|${String(clientKey)}|${part}`).digest('hex');
  return `k${digest.slice(0, 24)}`;
}

// True when a write failed only because a row with this id already exists: two presses with the same key
// that ran at the very same moment, where the first commit won. The caller then reads that row back.
function isIdClash(err) {
  if (!err || err.code !== 'P2002') return false;
  const target = Array.isArray(err.meta?.target) ? err.meta.target.join(',') : String(err.meta?.target || '');
  return target === 'id' || target.endsWith('_pkey') || /(^|,)\s*id\s*(,|$)/.test(target);
}

module.exports = { keyedId, isIdClash };
