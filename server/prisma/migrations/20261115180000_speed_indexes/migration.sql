-- Speed (15 Nov 2026): indexes for the filters every order, sweep, commission and Finance read uses.
-- Additive only: no column, row or constraint changes, and safe to run twice. The tables are small
-- (hundreds of rows), so a plain CREATE INDEX holds its lock for milliseconds.

-- sales filtered by their order: order breakdowns, the order list's box counts, commission, the fine sweep.
CREATE INDEX IF NOT EXISTS "sales_settlementId_idx" ON "sales"("settlementId");

-- returns filtered by their order (breakdowns, the fine sweep's pause) and by rep.
CREATE INDEX IF NOT EXISTS "returns_settlementId_idx" ON "returns"("settlementId");
CREATE INDEX IF NOT EXISTS "returns_salesRepId_idx" ON "returns"("salesRepId");

-- ledger rows looked up by what they record (the Finance missing-row check, purchase-order payments).
CREATE INDEX IF NOT EXISTS "finance_transactions_refType_refId_idx" ON "finance_transactions"("refType", "refId");
