-- Cash-only purchasing with partial receiving (15 Nov 2026). Two new purchase-order statuses, new
-- nullable/defaulted columns, two new tables, one column widened. Nothing is renamed, narrowed or removed.
-- AlterEnum


ALTER TYPE "PurchaseStatus" ADD VALUE IF NOT EXISTS 'PURCHASED';
ALTER TYPE "PurchaseStatus" ADD VALUE IF NOT EXISTS 'PARTLY_RECEIVED';

-- AlterTable
ALTER TABLE "purchase_order_items" ADD COLUMN     "damagedBase" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "missingBase" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "receivedBase" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: the cost per box keeps six places (a carton price divided by its boxes adds back up exactly).
-- Widening only — every stored value fits unchanged.
ALTER TABLE "purchase_order_items" ALTER COLUMN "unitCost" SET DATA TYPE DECIMAL(18,6);

-- AlterTable
ALTER TABLE "purchase_orders" ADD COLUMN     "dispatchedAt" TIMESTAMP(3),
ADD COLUMN     "purchasedAt" TIMESTAMP(3),
ADD COLUMN     "purchasedById" TEXT;

-- CreateTable
CREATE TABLE "purchase_receipts" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "clientKey" TEXT NOT NULL,
    "arrivedAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "receivedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_receipt_items" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT NOT NULL,
    "receivedQty" INTEGER NOT NULL DEFAULT 0,
    "damagedQty" INTEGER NOT NULL DEFAULT 0,
    "missingQty" INTEGER NOT NULL DEFAULT 0,
    "receivedBase" INTEGER NOT NULL DEFAULT 0,
    "damagedBase" INTEGER NOT NULL DEFAULT 0,
    "missingBase" INTEGER NOT NULL DEFAULT 0,
    "acceptedBase" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,

    CONSTRAINT "purchase_receipt_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipts_clientKey_key" ON "purchase_receipts"("clientKey");

-- CreateIndex
CREATE INDEX "purchase_receipts_purchaseOrderId_idx" ON "purchase_receipts"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "purchase_receipt_items_receiptId_idx" ON "purchase_receipt_items"("receiptId");

-- CreateIndex
CREATE INDEX "purchase_receipt_items_purchaseOrderItemId_idx" ON "purchase_receipt_items"("purchaseOrderItemId");

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_items" ADD CONSTRAINT "purchase_receipt_items_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "purchase_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_items" ADD CONSTRAINT "purchase_receipt_items_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- History: an order received before this change brought every box it bought in, so its lines say so.
-- (Uses only the existing RECEIVED value, never the values added above.)
UPDATE "purchase_order_items" AS i
SET "receivedBase" = i."baseQuantity"
FROM "purchase_orders" AS p
WHERE p."id" = i."purchaseOrderId" AND p."status" = 'RECEIVED' AND i."receivedBase" = 0;
