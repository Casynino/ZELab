-- Business money only (15 Nov 2026). Additive: two nullable columns with unique indexes. Nothing is changed or removed.
-- clientKey: one entry per press of a form. reversalOfId: a reversal names the entry it undoes (once).
-- AlterTable
ALTER TABLE "finance_transactions" ADD COLUMN     "clientKey" TEXT,
ADD COLUMN     "reversalOfId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "finance_transactions_clientKey_key" ON "finance_transactions"("clientKey");

-- CreateIndex
CREATE UNIQUE INDEX "finance_transactions_reversalOfId_key" ON "finance_transactions"("reversalOfId");

