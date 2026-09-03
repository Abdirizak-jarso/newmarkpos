-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SaleLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "saleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pricingMode" TEXT NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "catalogueUnitPrice" INTEGER,
    "priceOverridden" BOOLEAN NOT NULL DEFAULT false,
    "weightGrams" INTEGER NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "stockGrams" INTEGER NOT NULL DEFAULT 0,
    "gross" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "net" INTEGER NOT NULL,
    "cost" INTEGER NOT NULL DEFAULT 0,
    "costPerKg" INTEGER NOT NULL DEFAULT 0,
    "taxClass" TEXT NOT NULL,
    "taxRatePercent" INTEGER NOT NULL DEFAULT 0,
    "tax" INTEGER NOT NULL DEFAULT 0,
    "requestedAmount" INTEGER,
    "discountReason" TEXT,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "SaleLine_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SaleLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_SaleLine" ("cost", "costPerKg", "discount", "discountReason", "gross", "id", "name", "net", "notes", "pricingMode", "productId", "quantity", "requestedAmount", "saleId", "sku", "sortOrder", "stockGrams", "tax", "taxClass", "taxRatePercent", "unitPrice", "weightGrams") SELECT "cost", "costPerKg", "discount", "discountReason", "gross", "id", "name", "net", "notes", "pricingMode", "productId", "quantity", "requestedAmount", "saleId", "sku", "sortOrder", "stockGrams", "tax", "taxClass", "taxRatePercent", "unitPrice", "weightGrams" FROM "SaleLine";
DROP TABLE "SaleLine";
ALTER TABLE "new_SaleLine" RENAME TO "SaleLine";
CREATE INDEX "SaleLine_saleId_idx" ON "SaleLine"("saleId");
CREATE INDEX "SaleLine_productId_idx" ON "SaleLine"("productId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
