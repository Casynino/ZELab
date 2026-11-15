'use strict';

// Invoice numbers (sale10, 15 Nov 2026). The invoice tool used to count in each browser's own storage, so the
// owner's phone, his PC and a staff browser each handed out INV-2026-001, and a cleared browser started again —
// two customers could get invoices with the same number. The server now gives every number out, once:
// one counter per year in the settings table (no schema change), moved on by a single UPDATE … RETURNING, which
// Postgres runs one at a time per row — two devices at the same instant get two different numbers.
const crypto = require('crypto');
const prisma = require('../config/prisma');
const { eatNow } = require('../utils/dates');

const MAX_AFTER = 1_000_000;
const keyFor = (year) => `invoice.seq.${year}`;
const format = (year, n) => `INV-${year}-${String(n).padStart(3, '0')}`;

// `after` = the highest number this device had already handed out on its own (the old per-device counter), so
// the server never gives out a number a customer may already hold. The counter only ever goes up.
async function nextInvoiceNumber({ after = 0 } = {}, client = prisma) {
  const year = eatNow().year(); // the business's year (EAT), not the server's
  const key = keyFor(year);
  const floor = Math.min(Math.max(Math.trunc(Number(after) || 0), 0), MAX_AFTER);
  // The year's counter exists from its first number on; a second device creating it at the same moment does nothing.
  await client.$executeRaw`
    INSERT INTO "settings" ("id", "key", "value", "type", "group", "description", "createdAt", "updatedAt")
    VALUES (${crypto.randomUUID()}, ${key}, '0', 'NUMBER', 'invoices', ${`Last invoice number given out in ${year} (set by the server)`}, now(), now())
    ON CONFLICT ("key") DO NOTHING`;
  const rows = await client.$queryRaw`
    UPDATE "settings"
       SET "value" = (GREATEST(COALESCE(NULLIF("value", '')::int, 0), ${floor}::int) + 1)::text, "updatedAt" = now()
     WHERE "key" = ${key}
     RETURNING "value"`;
  const n = Number(rows?.[0]?.value);
  if (!Number.isFinite(n) || n < 1) throw new Error('Could not give out an invoice number');
  return { number: format(year, n), year, seq: n };
}

module.exports = { nextInvoiceNumber, keyFor, format };
