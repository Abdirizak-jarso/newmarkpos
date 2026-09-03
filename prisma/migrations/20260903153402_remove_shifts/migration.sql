-- DropIndex
DROP INDEX "CashEvent_shiftId_idx";

-- DropIndex
DROP INDEX "Shift_terminalId_openedAt_idx";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "CashEvent";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Shift";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Sale" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "receiptNumber" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "userId" TEXT NOT NULL,
    "gross" INTEGER NOT NULL DEFAULT 0,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "subtotal" INTEGER NOT NULL DEFAULT 0,
    "roundingAdjustment" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "tax" INTEGER NOT NULL DEFAULT 0,
    "taxBreakdown" TEXT,
    "totalWeightGrams" INTEGER NOT NULL DEFAULT 0,
    "saleDiscountKind" TEXT,
    "saleDiscountValue" INTEGER,
    "saleDiscountReason" TEXT,
    "customerName" TEXT,
    "customerPhone" TEXT,
    "customerPin" TEXT,
    "reversesSaleId" TEXT,
    "voidReason" TEXT,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Sale_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Sale" ("completedAt", "createdAt", "customerName", "customerPhone", "customerPin", "discount", "gross", "id", "receiptNumber", "reversesSaleId", "roundingAdjustment", "saleDiscountKind", "saleDiscountReason", "saleDiscountValue", "status", "subtotal", "tax", "taxBreakdown", "terminalId", "total", "totalWeightGrams", "updatedAt", "userId", "voidReason") SELECT "completedAt", "createdAt", "customerName", "customerPhone", "customerPin", "discount", "gross", "id", "receiptNumber", "reversesSaleId", "roundingAdjustment", "saleDiscountKind", "saleDiscountReason", "saleDiscountValue", "status", "subtotal", "tax", "taxBreakdown", "terminalId", "total", "totalWeightGrams", "updatedAt", "userId", "voidReason" FROM "Sale";
DROP TABLE "Sale";
ALTER TABLE "new_Sale" RENAME TO "Sale";
CREATE UNIQUE INDEX "Sale_receiptNumber_key" ON "Sale"("receiptNumber");
CREATE INDEX "Sale_status_completedAt_idx" ON "Sale"("status", "completedAt");
CREATE INDEX "Sale_terminalId_createdAt_idx" ON "Sale"("terminalId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

