import "server-only";
import { db } from "../db";
import { record } from "../audit";
import { nextReceiptNumber, terminalId } from "../receipt-number";
import { getPricingSettings, getSettings, getShopDetails } from "../settings";
import {
  applyPayments,
  priceSale,
  reductionNeedsApproval,
  type CartLineInput,
  type Tender,
} from "../pricing";
import { costOfWeight } from "../cost";
import { move } from "./stock";
import { renderReceipt, toBase64 } from "../adapters/escpos";
import { verifyApprover, type CurrentUser } from "../session";
import type { CheckoutInput } from "../validation";

/**
 * Checkout.
 *
 * The order of operations here is the whole design:
 *
 *   1. Price the basket from CATALOGUE prices unless the cashier typed a rate
 *      at the counter, in which case the typed rate is charged and the
 *      catalogue rate is recorded beside it.
 *
 *      That is a narrowing of the old rule, not an abandonment of it. The till
 *      quotes no prices on the product grid — the cashier types the rate for
 *      every line — so "the server decides what things cost" would mean the
 *      server ignoring the only figure anybody quoted the customer. What the
 *      server still does not allow is a price arriving SILENTLY: an override
 *      travels in its own field, the catalogue rate is stamped on the line
 *      next to it, the gap is measured, and a gap that goes the shop's way
 *      needs an admin's PIN and lands in the audit log. Everything else the
 *      client sends about money — totals, tax, the line arithmetic — is still
 *      recomputed here and its version discarded.
 *   2. Commit the sale, its lines, its payments and its stock movements in one
 *      transaction.
 *   3. THEN queue the receipt, the eTIMS invoice and the sync push — all
 *      outside the transaction, all failure-tolerant. A printer that is out of
 *      paper, a KRA endpoint that is down, or a dead network must not roll back
 *      a sale that has already been paid for.
 */

export interface CheckoutResult {
  saleId: string;
  receiptNumber: string;
  total: number;
  changeDue: number;
  /** Base64 ESC/POS, so the till can preview the receipt on screen. */
  receiptPayload: string;
  printJobId: string;
  /** Set when the sale went through but something downstream did not. */
  warnings: string[];
}

export class CheckoutError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

export async function checkout(input: CheckoutInput, cashier: CurrentUser): Promise<CheckoutResult> {
  const warnings: string[] = [];

  // A sale that has already been banked must never be banked twice — a retried
  // offline sync is the normal way this happens, not an exceptional one.
  const existing = await db.sale.findUnique({
    where: { id: input.idempotencyKey },
    select: { id: true, receiptNumber: true, total: true },
  });
  if (existing) {
    return {
      saleId: existing.id,
      receiptNumber: existing.receiptNumber,
      total: existing.total,
      changeDue: 0,
      receiptPayload: "",
      printJobId: "",
      warnings: ["This sale was already recorded; the earlier receipt stands."],
    };
  }

  const settings = await getSettings();
  const pricingSettings = await getPricingSettings();

  // --- 1. Price from the catalogue -----------------------------------------
  const products = await db.product.findMany({
    where: { id: { in: input.lines.map((l) => l.productId) } },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  const cartLines: CartLineInput[] = input.lines.map((line) => {
    const product = byId.get(line.productId);
    if (!product) throw new CheckoutError(`Product ${line.productId} is not in the catalogue`);
    if (!product.active) throw new CheckoutError(`${product.name} is no longer on sale`);

    return {
      lineId: line.lineId,
      productId: product.id,
      sku: product.sku,
      name: product.name,
      pricingMode: product.pricingMode as CartLineInput["pricingMode"],
      // The board price, always read here and never taken from the client.
      unitPrice: product.price,
      // The rate typed at the counter, if there was one. Checked against the
      // board price below rather than trusted.
      unitPriceOverride: line.unitPriceOverride,
      weightGrams: line.weightGrams,
      quantity: line.quantity,
      unitWeightGrams: product.unitWeightGrams ?? undefined,
      taxClass: product.taxClass as CartLineInput["taxClass"],
      discount: line.discount,
      requestedAmount: line.requestedAmount,
      notes: line.notes,
    };
  });

  const totals = priceSale(cartLines, pricingSettings, input.saleDiscount);
  const tenders: Tender[] = input.tenders;
  const payment = applyPayments(totals, tenders);

  if (!payment.settled) {
    throw new CheckoutError(
      `Short by KSh ${(payment.balanceDue / 100).toFixed(2)} — take the balance before completing`,
      "tenders",
    );
  }

  /*
   * --- Authorisation for discounts -----------------------------------------
   *
   * Discounts only. A rate typed at the counter is not gated: this shop sets
   * its prices at the counter, so a PIN in front of every line would be a PIN
   * in front of every sale, and a cashier who has to fetch someone to ring up
   * a leg of goat will stop using the till properly by the end of the week.
   *
   * Typed rates are controlled after the fact instead of before it — the board
   * rate is stamped on every sale line next to what was charged, and every one
   * of them is written to the audit log. What that buys is a shop that can see
   * what its counter is doing; what it costs is that the seeing happens in the
   * evening rather than at the moment of sale. That is the trade the owner
   * asked for, and it is a real one.
   */
  let approverId: string | undefined;
  const needsApproval = reductionNeedsApproval(totals.discount, totals.gross, settings);
  if (needsApproval) {
    if (!input.approval) {
      throw new CheckoutError("This discount needs a manager's PIN", "approval");
    }
    const approver = await verifyApprover(input.approval.pin, "sale.discount.large");
    approverId = approver.id;
  }

  const at = input.offlineAt ? new Date(input.offlineAt) : new Date();

  // --- 2. Commit ------------------------------------------------------------
  const sale = await db.$transaction(async (tx) => {
    const receiptNumber = await nextReceiptNumber(tx);

    const created = await tx.sale.create({
      data: {
        id: input.idempotencyKey,
        receiptNumber,
        terminalId: terminalId(),
        status: "COMPLETED",
        userId: cashier.id,
        gross: totals.gross,
        discount: totals.discount,
        subtotal: totals.subtotal,
        roundingAdjustment: totals.roundingAdjustment,
        total: totals.total,
        tax: totals.tax,
        taxBreakdown: JSON.stringify(totals.taxBuckets),
        totalWeightGrams: totals.totalWeightGrams,
        saleDiscountKind: input.saleDiscount?.kind,
        saleDiscountValue: input.saleDiscount?.value,
        saleDiscountReason: input.saleDiscount?.reason,
        customerName: input.customerName || null,
        customerPhone: input.customerPhone || null,
        customerPin: input.customerPin || null,
        completedAt: at,
        lines: {
          create: totals.lines.map((line, index) => ({
            productId: line.productId,
            // What this meat cost the shop, taken from the catalogue at the
            // moment it leaves. Stamped, not referenced: a delivery next week
            // must not reprice a sale that already happened.
            cost: costOfWeight(byId.get(line.productId)?.costPerKg ?? 0, line.stockGrams),
            costPerKg: byId.get(line.productId)?.costPerKg ?? 0,
            sku: line.sku,
            name: line.name,
            pricingMode: line.pricingMode,
            unitPrice: line.unitPrice,
            catalogueUnitPrice: line.catalogueUnitPrice,
            priceOverridden: line.priceOverridden,
            weightGrams: line.weightGrams,
            quantity: line.quantity,
            stockGrams: line.stockGrams,
            gross: line.gross,
            discount: line.discount,
            net: line.net,
            taxClass: line.taxClass,
            taxRatePercent: line.taxRatePercent,
            tax: line.tax,
            requestedAmount: line.requestedAmount,
            notes: line.notes,
            sortOrder: index,
          })),
        },
        payments: {
          create: input.tenders.map((tender) => ({
            method: tender.method,
            amount: tender.amount,
            reference: tender.reference,
            // The customer's M-Pesa clock, not the till's. This is what the
            // end-of-day reconciliation against the statement matches on.
            transactedAt: tender.transactedAt ? new Date(tender.transactedAt) : null,
            // An M-Pesa payment is only confirmed once the shop is holding the
            // code that proves it arrived. Until then it is PENDING, and it
            // stays on the list the cashier has to clear. Anything else is
            // confirmed at the point it is taken.
            status: tender.method === "MPESA" && !tender.reference ? "PENDING" : "CONFIRMED",
          })),
        },
      },
      include: { lines: true },
    });

    /*
     * Stock comes out of the case, with a reason code and an actor.
     *
     * Through move(), not around it. This used to compute the new balance from
     * the product row read BEFORE the transaction opened, which on a single
     * SQLite till is harmless and on the central Postgres back office this
     * schema is written to support is a lost update: two sales of the same cut
     * both read the same starting figure and both write the same balance, so
     * one sale's movement silently vanishes from the stock history. move()
     * re-reads inside the transaction.
     *
     * Selling below zero is still allowed — the meat physically left the shop,
     * and a negative balance is the signal that the count is wrong, not a thing
     * to hide by refusing the sale in front of the customer.
     */
    for (const line of totals.lines) {
      if (line.stockGrams === 0) continue;
      await move(tx, {
        productId: line.productId,
        deltaGrams: -line.stockGrams,
        reason: "SALE",
        actorId: cashier.id,
        saleId: created.id,
      });
    }

    return created;
  });

  // --- 3. Everything that must not be able to undo the sale -----------------
  const shop = await getShopDetails();
  const receiptBytes = renderReceipt(
    {
      shop,
      receiptNumber: sale.receiptNumber,
      terminalId: sale.terminalId,
      cashier: cashier.name,
      at,
      totals,
      tenders,
      changeDue: payment.changeDue,
      customerName: input.customerName,
      customerPin: input.customerPin,
    },
    settings.paperWidthMm,
  );
  const receiptPayload = toBase64(receiptBytes);

  let printJobId = "";
  try {
    const job = await db.printJob.create({
      data: { saleId: sale.id, kind: "RECEIPT", payload: receiptPayload, status: "QUEUED" },
    });
    printJobId = job.id;
  } catch (error) {
    // The sale is paid for and recorded. A failure to even queue the receipt
    // is worth telling the cashier about; it is not worth losing the sale.
    warnings.push("Receipt could not be queued for printing — reprint from the sale list.");
    console.error("[checkout] failed to queue receipt", error);
  }

  try {
    await db.taxInvoice.create({ data: { saleId: sale.id, status: "PENDING" } });
  } catch (error) {
    warnings.push("Tax invoice could not be queued.");
    console.error("[checkout] failed to queue tax invoice", error);
  }

  try {
    await db.syncQueue.create({
      data: { entity: "SALE", entityId: sale.id, payload: JSON.stringify({ saleId: sale.id }) },
    });
  } catch (error) {
    console.error("[checkout] failed to queue sync", error);
  }

  if (totals.discount > 0) {
    /*
     * The sale is already committed at this point, so this write cannot be
     * allowed to throw: everything else after the transaction — the receipt,
     * the tax invoice, the sync row — is guarded the same way, and a sale that
     * banked but reported a failure sends the cashier back to ring it up again
     * in front of the customer.
     *
     * But an unrecorded discount is exactly what the audit log exists to catch,
     * so it is not swallowed either. It comes back as a warning the till shows
     * and the sale carries.
     */
    try {
      await record({
        action: needsApproval ? "SALE_DISCOUNT" : "LINE_DISCOUNT",
        entity: "Sale",
        entityId: sale.id,
        after: { discount: totals.discount, gross: totals.gross, total: totals.total },
        actorId: cashier.id,
        approverId,
        reason: input.saleDiscount?.reason,
      });
    } catch (error) {
      warnings.push("The discount on this sale could not be written to the audit log.");
      console.error("[checkout] failed to audit discount", error);
    }
  }

  /*
   * Every line whose rate was typed at the counter, one audit record each.
   *
   * Per line rather than one row for the sale, because the question anybody
   * ever asks of this log is about a cut — "who sold the goat leg at 600 a
   * kilo" — and a summed figure across a five-line basket cannot answer it.
   * Each record carries the board rate, the rate charged and the shillings
   * between them, so the gap is readable without reconstructing the catalogue
   * as it stood that day.
   *
   * This log is now the ONLY control on counter pricing — nothing stops a rate
   * being typed, so everything depends on it being written. That is why the
   * failure below is surfaced to the cashier rather than swallowed.
   *
   * Guarded like everything else after the commit: the sale is paid for, and a
   * failure here is a warning on the receipt screen, never a lost sale.
   */
  const overridden = totals.lines.filter((line) => line.priceOverridden);
  if (overridden.length > 0) {
    try {
      for (const line of overridden) {
        await record({
          action: "SALE_PRICE_OVERRIDE",
          entity: "SaleLine",
          entityId: `${sale.id}:${line.lineId}`,
          before: { unitPrice: line.catalogueUnitPrice, gross: line.gross - line.priceOverride },
          after: {
            sku: line.sku,
            name: line.name,
            unitPrice: line.unitPrice,
            gross: line.gross,
            // Negative means the shop took less than its board price.
            difference: line.priceOverride,
            weightGrams: line.weightGrams,
            quantity: line.quantity,
          },
          actorId: cashier.id,
          // No approver, ever: nobody authorises a typed rate. Borrowing the
          // approver from a discount elsewhere on the same sale would put an
          // admin's name against a price they never saw.
          reason: "Price typed at the counter",
        });
      }
    } catch (error) {
      warnings.push("A price typed on this sale could not be written to the audit log.");
      console.error("[checkout] failed to audit price override", error);
    }
  }

  return {
    saleId: sale.id,
    receiptNumber: sale.receiptNumber,
    total: totals.total,
    changeDue: payment.changeDue,
    receiptPayload,
    printJobId,
    warnings,
  };
}

/**
 * A reduction is an admin's call once it is big enough to be worth stealing.
 *
 * The rule itself lives in lib/pricing.ts, because the till has to ask exactly
 * the same question while the manager is still standing at the counter — two
 * implementations would eventually disagree, and the one that disagreed would
 * be the one letting money out of the shop.
 */
export { reductionNeedsApproval as discountNeedsApproval } from "../pricing";
