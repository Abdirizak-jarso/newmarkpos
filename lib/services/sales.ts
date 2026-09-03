import "server-only";
import { db } from "../db";
import { record } from "../audit";
import { nextReceiptNumber, terminalId } from "../receipt-number";
import { getSettings, getShopDetails } from "../settings";
import { renderReceipt, toBase64 } from "../adapters/escpos";
import { roundHalfUp } from "../money";
import { weightLineTotal } from "../weight";
import { verifyApprover, type CurrentUser } from "../session";
import { move } from "./stock";
import type { CartLine, SaleTotals, TaxBucket, Tender } from "../pricing";
import type { z } from "zod";
import type { RecordMpesaCodeInput, refundSchema, voidSaleSchema } from "../validation";

/**
 * Voids, refunds and reprints.
 *
 * A void or a refund never edits the original sale. The original stands
 * exactly as it was rung up, and the reversal is a separate record pointing
 * back at it. That is what makes the day's takings reconstructable, and it is
 * why `status` on the original is the only field either operation touches.
 */

export async function voidSale(
  input: z.infer<typeof voidSaleSchema>,
  actor: CurrentUser,
): Promise<{ saleId: string; reversed: number }> {
  const approver = await verifyApprover(input.approval.pin, "sale.void");

  const sale = await db.sale.findUnique({
    where: { id: input.saleId },
    include: { lines: true, payments: true },
  });
  if (!sale) throw new Error("Sale not found");
  if (sale.status === "VOIDED") throw new Error("This sale has already been voided");
  if (sale.status === "REFUNDED") throw new Error("This sale has been refunded; it cannot also be voided");

  const before = { status: sale.status, total: sale.total };

  await db.$transaction(async (tx) => {
    await tx.sale.update({
      where: { id: sale.id },
      data: { status: "VOIDED", voidReason: input.reason },
    });

    // The meat goes back in the case, through the one function that moves
    // stock, so a void leaves the same shape of history as the sale it undoes.
    // No cost is passed: meat coming back was already costed on the way out,
    // and re-costing it would shift the basis of everything still in the case.
    for (const line of sale.lines) {
      if (line.stockGrams === 0) continue;
      await move(tx, {
        productId: line.productId,
        deltaGrams: line.stockGrams,
        reason: "REFUND",
        note: `Void of ${sale.receiptNumber}: ${input.reason}`,
        actorId: actor.id,
        saleId: sale.id,
      });
    }

    // A voided sale's invoice must not be submitted to KRA afterwards.
    await tx.taxInvoice.updateMany({
      where: { saleId: sale.id, status: "PENDING" },
      data: { status: "NOT_APPLICABLE" },
    });
  });

  await record({
    action: "VOID_SALE",
    entity: "Sale",
    entityId: sale.id,
    before,
    after: { status: "VOIDED", reason: input.reason },
    actorId: actor.id,
    approverId: approver.id,
    reason: input.reason,
  });

  return { saleId: sale.id, reversed: sale.total };
}

/**
 * A partial or full refund, recorded as its own sale with negative figures so
 * it flows through the same reports and the same eTIMS credit-note path.
 */
export async function refundSale(
  input: z.infer<typeof refundSchema>,
  actor: CurrentUser,
): Promise<{ refundSaleId: string; receiptNumber: string; amount: number; receiptPayload: string }> {
  const approver = await verifyApprover(input.approval.pin, "sale.refund");

  const original = await db.sale.findUnique({
    where: { id: input.saleId },
    include: { lines: true },
  });
  if (!original) throw new Error("Sale not found");
  if (original.status === "VOIDED") throw new Error("A voided sale has nothing to refund");

  // Empty means the whole sale comes back.
  const requested =
    input.lines.length > 0
      ? input.lines
      : original.lines.map((line) => ({
          saleLineId: line.id,
          weightGrams: line.weightGrams > 0 ? line.weightGrams : undefined,
          quantity: line.weightGrams > 0 ? undefined : line.quantity,
        }));

  const byId = new Map(original.lines.map((l) => [l.id, l]));
  const refundLines = requested.map((ask) => {
    const line = byId.get(ask.saleLineId);
    if (!line) throw new Error("That line is not on this sale");

    // Refund proportionally to what is coming back, so half a kilo of a
    // 1.2 kg line returns half a kilo's money and not the whole line's.
    const isWeighed = line.pricingMode === "PER_KG";
    const returningGrams = isWeighed ? (ask.weightGrams ?? line.weightGrams) : 0;
    const returningQty = isWeighed ? 1 : (ask.quantity ?? line.quantity);

    if (isWeighed && returningGrams > line.weightGrams) {
      throw new Error(`More ${line.name} is being returned than was sold`);
    }
    if (!isWeighed && returningQty > line.quantity) {
      throw new Error(`More ${line.name} is being returned than was sold`);
    }

    const share = isWeighed
      ? returningGrams / Math.max(1, line.weightGrams)
      : returningQty / Math.max(1, line.quantity);

    // The one rounding rule, same as the sale this reverses — so a full
    // refund cancels the original to the cent rather than to within one.
    const net = roundHalfUp(line.net * share);
    const stockGrams = roundHalfUp(line.stockGrams * share);

    return { line, net, stockGrams, returningGrams, returningQty };
  });

  const amount = refundLines.reduce((total, r) => total + r.net, 0);
  if (amount <= 0) throw new Error("Nothing to refund");

  const settings = await getSettings();
  const shop = await getShopDetails();
  const at = new Date();

  const refund = await db.$transaction(async (tx) => {
    const receiptNumber = await nextReceiptNumber(tx);

    const created = await tx.sale.create({
      data: {
        receiptNumber,
        terminalId: terminalId(),
        status: "COMPLETED",
        userId: actor.id,
        reversesSaleId: original.id,
        voidReason: input.reason,
        // Negative throughout: a refund is a sale of negative meat, and every
        // report that sums sales then handles refunds without special cases.
        gross: -amount,
        subtotal: -amount,
        total: -amount,
        tax: -refundLines.reduce((t, r) => t + roundHalfUp(r.line.tax * (r.net / Math.max(1, r.line.net))), 0),
        totalWeightGrams: -refundLines.reduce((t, r) => t + r.stockGrams, 0),
        completedAt: at,
        lines: {
          create: refundLines.map((r, index) => ({
            productId: r.line.productId,
            sku: r.line.sku,
            name: r.line.name,
            pricingMode: r.line.pricingMode,
            // Whatever was charged, at whatever rate — a refund is not a fresh
            // pricing decision, so the original's rates come across unchanged.
            unitPrice: r.line.unitPrice,
            catalogueUnitPrice: r.line.catalogueUnitPrice,
            priceOverridden: r.line.priceOverridden,
            weightGrams: -r.returningGrams,
            quantity: -r.returningQty,
            stockGrams: -r.stockGrams,
            gross: -r.net,
            net: -r.net,
            taxClass: r.line.taxClass,
            taxRatePercent: r.line.taxRatePercent,
            tax: -roundHalfUp(r.line.tax * (r.net / Math.max(1, r.line.net))),
            sortOrder: index,
          })),
        },
        payments: {
          create: [{ method: input.method, amount: -amount, status: "CONFIRMED" }],
        },
      },
    });

    for (const r of refundLines) {
      if (r.stockGrams === 0) continue;
      await move(tx, {
        productId: r.line.productId,
        deltaGrams: r.stockGrams,
        reason: "REFUND",
        note: `Refund of ${original.receiptNumber}: ${input.reason}`,
        actorId: actor.id,
        saleId: created.id,
      });
    }

    const fullyRefunded = amount >= original.total;
    await tx.sale.update({
      where: { id: original.id },
      data: { status: fullyRefunded ? "REFUNDED" : original.status },
    });

    return created;
  });

  await record({
    action: "REFUND",
    entity: "Sale",
    entityId: original.id,
    before: { total: original.total, status: original.status },
    after: { refundSaleId: refund.id, amount, method: input.method },
    actorId: actor.id,
    approverId: approver.id,
    reason: input.reason,
  });

  const totals = totalsFromSaleLines(
    refundLines.map((r) => ({
      lineId: r.line.id,
      productId: r.line.productId,
      sku: r.line.sku,
      name: r.line.name,
      pricingMode: r.line.pricingMode as CartLine["pricingMode"],
      unitPrice: r.line.unitPrice,
      catalogueUnitPrice: r.line.catalogueUnitPrice ?? r.line.unitPrice,
      priceOverridden: r.line.priceOverridden,
      // A refund reverses money that was already taken; it gives nothing else
      // away, so there is no fresh gap against the board to report here.
      priceOverride: 0,
      weightGrams: -r.returningGrams,
      quantity: -r.returningQty,
      gross: -r.net,
      discount: 0,
      net: -r.net,
      taxClass: r.line.taxClass as CartLine["taxClass"],
      taxRatePercent: r.line.taxRatePercent,
      tax: 0,
      stockGrams: -r.stockGrams,
    })),
  );

  const payload = toBase64(
    renderReceipt(
      {
        shop,
        receiptNumber: refund.receiptNumber,
        terminalId: refund.terminalId,
        cashier: actor.name,
        at,
        totals,
        tenders: [{ method: input.method, amount: -amount } as Tender],
        changeDue: 0,
        copyLabel: `Refund of ${original.receiptNumber}`,
      },
      settings.paperWidthMm,
    ),
  );

  await db.printJob.create({
    data: { saleId: refund.id, kind: "RECEIPT", payload, status: "QUEUED" },
  });

  return {
    refundSaleId: refund.id,
    receiptNumber: refund.receiptNumber,
    amount,
    receiptPayload: payload,
  };
}

/**
 * The stored columns a sale line needs to be rebuilt into a priced line.
 *
 * Structural rather than the Prisma row type, so the eTIMS flush and the
 * reprint path can both pass their own selections without either of them
 * having to widen its query.
 */
export interface StoredSaleLine {
  id: string;
  productId: string;
  sku: string;
  name: string;
  pricingMode: string;
  unitPrice: number;
  catalogueUnitPrice: number | null;
  priceOverridden: boolean;
  weightGrams: number;
  quantity: number;
  gross: number;
  discount: number;
  net: number;
  taxClass: string;
  taxRatePercent: number;
  tax: number;
  stockGrams: number;
  requestedAmount?: number | null;
  notes?: string | null;
}

/**
 * Rebuild a priced line from what was banked.
 *
 * Read back, never recomputed: the catalogue moves, and a receipt reprinted
 * next month has to show the rate the customer actually paid, not today's.
 * `catalogueUnitPrice` is null on sales banked before the counter started
 * typing its own rates, and for those the rate charged WAS the board rate.
 */
export function cartLineFromSaleLine(line: StoredSaleLine): CartLine {
  const catalogueUnitPrice = line.catalogueUnitPrice ?? line.unitPrice;
  const quantity = line.pricingMode === "PER_KG" ? 1 : line.quantity;
  const catalogueGross =
    line.pricingMode === "PER_KG"
      ? weightLineTotal(catalogueUnitPrice, line.weightGrams)
      : roundHalfUp(catalogueUnitPrice * quantity);

  return {
    lineId: line.id,
    productId: line.productId,
    sku: line.sku,
    name: line.name,
    pricingMode: line.pricingMode as CartLine["pricingMode"],
    unitPrice: line.unitPrice,
    catalogueUnitPrice,
    priceOverridden: line.priceOverridden,
    priceOverride: line.priceOverridden ? line.gross - catalogueGross : 0,
    weightGrams: line.weightGrams,
    quantity: line.quantity,
    gross: line.gross,
    discount: line.discount,
    net: line.net,
    taxClass: line.taxClass as CartLine["taxClass"],
    taxRatePercent: line.taxRatePercent,
    tax: line.tax,
    stockGrams: line.stockGrams,
    requestedAmount: line.requestedAmount ?? undefined,
    notes: line.notes ?? undefined,
  };
}

/** Rebuild the printable totals from stored sale lines, for reprints. */
export function totalsFromSaleLines(lines: CartLine[]): SaleTotals {
  const buckets = new Map<string, TaxBucket>();
  for (const line of lines) {
    const key = `${line.taxClass}:${line.taxRatePercent}`;
    const bucket = buckets.get(key) ?? {
      taxClass: line.taxClass,
      ratePercent: line.taxRatePercent,
      net: 0,
      tax: 0,
    };
    bucket.net += line.net;
    bucket.tax += line.tax;
    buckets.set(key, bucket);
  }

  const priceOverrideReduction = lines.reduce(
    (t, l) => t + (l.priceOverride < 0 ? -l.priceOverride : 0),
    0,
  );
  const priceOverrideIncrease = lines.reduce((t, l) => t + Math.max(0, l.priceOverride), 0);

  return {
    lines,
    gross: lines.reduce((t, l) => t + l.gross, 0),
    catalogueGross:
      lines.reduce((t, l) => t + l.gross, 0) + priceOverrideReduction - priceOverrideIncrease,
    priceOverrideReduction,
    priceOverrideIncrease,
    discount: lines.reduce((t, l) => t + l.discount, 0),
    subtotal: lines.reduce((t, l) => t + l.net, 0),
    roundingAdjustment: 0,
    total: lines.reduce((t, l) => t + l.net, 0),
    tax: lines.reduce((t, l) => t + l.tax, 0),
    taxBuckets: [...buckets.values()],
    totalWeightGrams: lines.reduce((t, l) => t + l.stockGrams, 0),
    itemCount: lines.length,
  };
}

/** Queue a duplicate receipt. Reprints are audited — they enable walk-outs. */
export async function reprintReceipt(saleId: string, actor: CurrentUser): Promise<string> {
  const sale = await db.sale.findUnique({
    where: { id: saleId },
    include: { lines: { orderBy: { sortOrder: "asc" } }, payments: true, user: true, invoice: true },
  });
  if (!sale) throw new Error("Sale not found");

  const settings = await getSettings();
  const shop = await getShopDetails();

  const totals = totalsFromSaleLines(sale.lines.map(cartLineFromSaleLine));
  totals.roundingAdjustment = sale.roundingAdjustment;
  totals.total = sale.total;

  const payload = toBase64(
    renderReceipt(
      {
        shop,
        receiptNumber: sale.receiptNumber,
        terminalId: sale.terminalId,
        cashier: sale.user.name,
        at: sale.completedAt ?? sale.createdAt,
        totals,
        tenders: sale.payments.map((p) => ({
          method: p.method as Tender["method"],
          amount: p.amount,
          reference: p.reference ?? undefined,
        })),
        changeDue: 0,
        customerName: sale.customerName ?? undefined,
        customerPin: sale.customerPin ?? undefined,
        taxInvoiceNumber: sale.invoice?.invoiceNumber ?? undefined,
        taxSignature: sale.invoice?.signature ?? undefined,
        copyLabel: sale.status === "VOIDED" ? "VOIDED COPY" : "Duplicate",
      },
      settings.paperWidthMm,
    ),
  );

  const job = await db.printJob.create({
    data: { saleId: sale.id, kind: "DUPLICATE", payload, status: "QUEUED" },
  });

  return job.id;
}

/**
 * The list of M-Pesa payments still waiting for their code.
 *
 * This is the shop's exposure: every row is money that has left the customer's
 * phone and gone into a sale, with nothing on file yet to match it against the
 * Safaricom statement. It is deliberately ordered oldest first — the ones that
 * have been sitting longest are the ones most likely to be forgotten.
 */
export async function listUnconfirmedMpesa(limit = 50): Promise<UnconfirmedPayment[]> {
  const payments = await db.payment.findMany({
    where: {
      method: "MPESA",
      status: "PENDING",
      // A voided sale is not owed a code; the money went back.
      sale: { status: "COMPLETED" },
    },
    include: { sale: { select: { receiptNumber: true, total: true, createdAt: true } } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  return payments.map((payment) => ({
    paymentId: payment.id,
    saleId: payment.saleId,
    receiptNumber: payment.sale.receiptNumber,
    amount: payment.amount,
    saleTotal: payment.sale.total,
    takenAt: payment.sale.createdAt.toISOString(),
  }));
}

export type UnconfirmedPayment = {
  paymentId: string;
  saleId: string;
  receiptNumber: string;
  amount: number;
  saleTotal: number;
  takenAt: string;
};

export async function countUnconfirmedMpesa(): Promise<number> {
  return db.payment.count({
    where: { method: "MPESA", status: "PENDING", sale: { status: "COMPLETED" } },
  });
}

/**
 * Record the M-Pesa code against a payment that was taken earlier.
 *
 * This is the second half of a sale that was banked and printed before the
 * customer's confirmation message arrived. It writes the code and the time off
 * that message and moves the payment to CONFIRMED.
 *
 * It does NOT touch the sale, its lines, its total or its stock — none of that
 * is in question. The only thing that changes is whether the shop can prove the
 * money came in, which is why the whole operation is one field, one status and
 * an audit row naming who cleared it.
 *
 * A code already recorded is not overwritten. If the wrong code went in, that
 * is a correction an admin makes deliberately, not something a second cashier
 * does by accident on a busy counter.
 */
export async function recordMpesaCode(
  input: RecordMpesaCodeInput,
  actor: CurrentUser,
): Promise<{ saleId: string; receiptNumber: string; reference: string }> {
  const payment = await db.payment.findUnique({
    where: { id: input.paymentId },
    include: { sale: { select: { id: true, receiptNumber: true, status: true } } },
  });

  if (!payment || payment.saleId !== input.saleId) {
    throw new Error("That payment is not on this sale");
  }
  if (payment.method !== "MPESA") {
    throw new Error("Only an M-Pesa payment carries a transaction code");
  }
  if (payment.sale.status !== "COMPLETED") {
    throw new Error("That sale is no longer live, so it is not owed a code");
  }
  if (payment.reference) {
    throw new Error(`That payment is already recorded as ${payment.reference}`);
  }

  // Safaricom codes are unique. The same one on two sales means the cashier
  // has copied the wrong message, and catching it here is the whole point of
  // collecting the code at all.
  const clash = await db.payment.findFirst({
    where: { reference: input.reference, id: { not: payment.id } },
    include: { sale: { select: { receiptNumber: true } } },
  });
  if (clash) {
    throw new Error(`Code ${input.reference} is already on receipt ${clash.sale.receiptNumber}`);
  }

  const before = { reference: payment.reference, status: payment.status };

  await db.payment.update({
    where: { id: payment.id },
    data: {
      reference: input.reference,
      transactedAt: new Date(input.transactedAt),
      status: "CONFIRMED",
    },
  });

  await record({
    action: "RECORD_MPESA_CODE",
    entity: "Payment",
    entityId: payment.id,
    before,
    after: {
      reference: input.reference,
      status: "CONFIRMED",
      transactedAt: input.transactedAt,
      // Carried on the row so the audit log reads without a join back to the
      // sale — the log is the record of last resort.
      receiptNumber: payment.sale.receiptNumber,
    },
    actorId: actor.id,
  });

  return {
    saleId: payment.saleId,
    receiptNumber: payment.sale.receiptNumber,
    reference: input.reference,
  };
}
