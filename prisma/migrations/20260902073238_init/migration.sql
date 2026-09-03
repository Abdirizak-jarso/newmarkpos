-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "colour" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "categoryId" TEXT NOT NULL,
    "pricingMode" TEXT NOT NULL DEFAULT 'PER_KG',
    "price" INTEGER NOT NULL,
    "comparePrice" INTEGER,
    "unitWeightGrams" INTEGER,
    "taxClass" TEXT NOT NULL DEFAULT 'EXEMPT',
    "stockGrams" INTEGER NOT NULL DEFAULT 0,
    "reorderLevelGrams" INTEGER,
    "costPerKg" INTEGER NOT NULL DEFAULT 0,
    "isByProduct" BOOLEAN NOT NULL DEFAULT false,
    "isBreakdownSource" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "showOnTill" BOOLEAN NOT NULL DEFAULT true,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "imageUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "staffCode" TEXT NOT NULL,
    "pinHash" TEXT NOT NULL,
    "pinSalt" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'CASHIER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSeen" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "terminalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "openingFloat" INTEGER NOT NULL DEFAULT 0,
    "countedCash" INTEGER,
    "variance" INTEGER,
    "notes" TEXT,
    CONSTRAINT "Shift_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CashEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shiftId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CashEvent_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "receiptNumber" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "userId" TEXT NOT NULL,
    "shiftId" TEXT,
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
    CONSTRAINT "Sale_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Sale_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SaleLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "saleId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pricingMode" TEXT NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "weightGrams" INTEGER NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "stockGrams" INTEGER NOT NULL DEFAULT 0,
    "gross" INTEGER NOT NULL,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "net" INTEGER NOT NULL,
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

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "saleId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Payment_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productId" TEXT NOT NULL,
    "deltaGrams" INTEGER NOT NULL,
    "balanceGrams" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "costPerKg" INTEGER,
    "actorId" TEXT NOT NULL,
    "saleId" TEXT,
    "breakdownId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "StockMovement_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CarcassBreakdown" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceProductId" TEXT NOT NULL,
    "inputWeightGrams" INTEGER NOT NULL,
    "inputCost" INTEGER NOT NULL DEFAULT 0,
    "outputWeightGrams" INTEGER NOT NULL,
    "lossGrams" INTEGER NOT NULL,
    "lossPercentTenths" INTEGER NOT NULL,
    "supplier" TEXT,
    "notes" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CarcassBreakdown_sourceProductId_fkey" FOREIGN KEY ("sourceProductId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CarcassBreakdown_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BreakdownOutput" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "breakdownId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "weightGrams" INTEGER NOT NULL,
    "yieldTenths" INTEGER NOT NULL,
    "costAllocated" INTEGER NOT NULL DEFAULT 0,
    "costPerKg" INTEGER NOT NULL DEFAULT 0,
    "isByProduct" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "BreakdownOutput_breakdownId_fkey" FOREIGN KEY ("breakdownId") REFERENCES "CarcassBreakdown" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BreakdownOutput_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TaxInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "saleId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "invoiceNumber" TEXT,
    "signature" TEXT,
    "qrUrl" TEXT,
    "submittedAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TaxInvoice_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PrintJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "saleId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "PrintJob_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncQueue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME
);

-- CreateTable
CREATE TABLE "ReceiptCounter" (
    "terminalId" TEXT NOT NULL PRIMARY KEY,
    "prefix" TEXT NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "before" TEXT,
    "after" TEXT,
    "actorId" TEXT NOT NULL,
    "approverId" TEXT,
    "reason" TEXT,
    "terminalId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AuditEvent_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_name_key" ON "Category"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");

-- CreateIndex
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");

-- CreateIndex
CREATE INDEX "Product_active_showOnTill_idx" ON "Product"("active", "showOnTill");

-- CreateIndex
CREATE UNIQUE INDEX "User_staffCode_key" ON "User"("staffCode");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Shift_terminalId_openedAt_idx" ON "Shift"("terminalId", "openedAt");

-- CreateIndex
CREATE INDEX "CashEvent_shiftId_idx" ON "CashEvent"("shiftId");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_receiptNumber_key" ON "Sale"("receiptNumber");

-- CreateIndex
CREATE INDEX "Sale_status_completedAt_idx" ON "Sale"("status", "completedAt");

-- CreateIndex
CREATE INDEX "Sale_terminalId_createdAt_idx" ON "Sale"("terminalId", "createdAt");

-- CreateIndex
CREATE INDEX "Sale_shiftId_idx" ON "Sale"("shiftId");

-- CreateIndex
CREATE INDEX "SaleLine_saleId_idx" ON "SaleLine"("saleId");

-- CreateIndex
CREATE INDEX "SaleLine_productId_idx" ON "SaleLine"("productId");

-- CreateIndex
CREATE INDEX "Payment_saleId_idx" ON "Payment"("saleId");

-- CreateIndex
CREATE INDEX "StockMovement_productId_createdAt_idx" ON "StockMovement"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_reason_createdAt_idx" ON "StockMovement"("reason", "createdAt");

-- CreateIndex
CREATE INDEX "CarcassBreakdown_createdAt_idx" ON "CarcassBreakdown"("createdAt");

-- CreateIndex
CREATE INDEX "BreakdownOutput_breakdownId_idx" ON "BreakdownOutput"("breakdownId");

-- CreateIndex
CREATE UNIQUE INDEX "TaxInvoice_saleId_key" ON "TaxInvoice"("saleId");

-- CreateIndex
CREATE INDEX "TaxInvoice_status_idx" ON "TaxInvoice"("status");

-- CreateIndex
CREATE INDEX "PrintJob_status_createdAt_idx" ON "PrintJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SyncQueue_status_createdAt_idx" ON "SyncQueue"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_createdAt_idx" ON "AuditEvent"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_entity_entityId_idx" ON "AuditEvent"("entity", "entityId");
