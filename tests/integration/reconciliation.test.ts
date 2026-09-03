import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { checkout } from "@/lib/services/checkout";
import { listUnconfirmedMpesa, refundSale, voidSale } from "@/lib/services/sales";
import { marginReport, salesSummary } from "@/lib/services/reports";
import type { CurrentUser } from "@/lib/session";

/**
 * Do the figures agree with each other?
 *
 * Every report in this application is a different way of adding up the same
 * sale rows. When two of them disagree, nobody can tell which one is lying, and
 * the shop stops trusting all of them. These tests take one path through the
 * counter and then check that the receipts, the summary, the margin report and
 * the M-Pesa list all describe the same day.
 */

let cashier: CurrentUser;
let admin: CurrentUser;
let cutId: string;
let counter = 0;
const key = () => `rec-${Date.now().toString(36)}-${counter++}`;

beforeAll(async () => {
  const cashierRow = await db.user.findUniqueOrThrow({ where: { staffCode: "4001" } });
  const adminRow = await db.user.findUniqueOrThrow({ where: { staffCode: "1000" } });
  cashier = { id: cashierRow.id, name: cashierRow.name, staffCode: "4001", role: "CASHIER" };
  admin = { id: adminRow.id, name: adminRow.name, staffCode: "1000", role: "ADMIN" };
  cutId = (await db.product.findUniqueOrThrow({ where: { sku: "BEEF-BONELESS-CUBES" } })).id;
});

describe("the summary agrees with the sale rows it is built from", () => {
  it("nets gross minus discount, every time", async () => {
    const from = new Date();
    const product = await db.product.findUniqueOrThrow({ where: { id: cutId } });
    const grams = 1_500;
    const gross = Math.round((product.price * grams) / 1000);

    await checkout(
      {
        lines: [
          {
            lineId: "l1",
            productId: cutId,
            weightGrams: grams,
            discount: { kind: "AMOUNT", value: 5_000, reason: "Price set at the counter" },
          },
        ],
        tenders: [{ method: "MPESA", amount: gross - 5_000 }],
        idempotencyKey: key(),
      },
      cashier,
    );

    const to = new Date();
    const summary = await salesSummary(from, to);
    const sales = await db.sale.findMany({
      where: { createdAt: { gte: from, lte: to }, status: { not: "VOIDED" } },
    });

    expect(summary.net).toBe(sales.reduce((t, s) => t + s.total, 0));
    expect(summary.gross).toBe(sales.reduce((t, s) => t + s.gross, 0));
    expect(summary.discount).toBe(sales.reduce((t, s) => t + s.discount, 0));
    // The reduction given at the counter is reported, not swallowed.
    expect(summary.givenAway).toBeGreaterThanOrEqual(5_000);
  });

  it("does not count a voided sale in the takings", async () => {
    const from = new Date();
    const product = await db.product.findUniqueOrThrow({ where: { id: cutId } });
    const gross = Math.round((product.price * 1_000) / 1000);

    const sale = await checkout(
      {
        lines: [{ lineId: "l1", productId: cutId, weightGrams: 1_000 }],
        tenders: [{ method: "MPESA", amount: gross }],
        idempotencyKey: key(),
      },
      cashier,
    );

    const before = await salesSummary(from, new Date());
    await voidSale(
      { saleId: sale.saleId, reason: "Reconciliation test", approval: { pin: "907143" } },
      admin,
    );
    const after = await salesSummary(from, new Date());

    expect(after.net).toBe(before.net - sale.total);
    expect(after.saleCount).toBe(before.saleCount - 1);
  });

  it("reports the margin against the cost stamped on the line", async () => {
    const from = new Date();
    await db.product.update({
      where: { id: cutId },
      data: { stockGrams: 50_000, costPerKg: 50_000 },
    });
    const product = await db.product.findUniqueOrThrow({ where: { id: cutId } });
    const gross = Math.round((product.price * 2_000) / 1000);

    await checkout(
      {
        lines: [{ lineId: "l1", productId: cutId, weightGrams: 2_000 }],
        tenders: [{ method: "MPESA", amount: gross }],
        idempotencyKey: key(),
      },
      cashier,
    );

    const rows = await marginReport(from, new Date());
    const row = rows.find((r) => r.sku === "BEEF-BONELESS-CUBES");
    expect(row).toBeDefined();

    const lines = await db.saleLine.findMany({
      where: { productId: cutId, sale: { completedAt: { gte: from } } },
    });
    expect(row!.revenue).toBe(lines.reduce((t, l) => t + l.net, 0));
    expect(row!.cost).toBe(lines.reduce((t, l) => t + l.cost, 0));
    expect(row!.margin).toBe(row!.revenue - row!.cost);
  });
});

/**
 * The two places a payment can quietly go missing.
 */
describe("a payment that never gets its code", () => {
  it("drops off the waiting list when the sale is voided", async () => {
    // Otherwise the shop chases a code for money it gave back, forever.
    const product = await db.product.findUniqueOrThrow({ where: { id: cutId } });
    const gross = Math.round((product.price * 1_000) / 1000);

    const sale = await checkout(
      {
        lines: [{ lineId: "l1", productId: cutId, weightGrams: 1_000 }],
        tenders: [{ method: "MPESA", amount: gross }],
        idempotencyKey: key(),
      },
      cashier,
    );
    const payment = await db.payment.findFirstOrThrow({ where: { saleId: sale.saleId } });

    const before = await listUnconfirmedMpesa(500);
    expect(before.map((r) => r.paymentId)).toContain(payment.id);

    await voidSale(
      { saleId: sale.saleId, reason: "Voided before the code arrived", approval: { pin: "907143" } },
      admin,
    );

    const after = await listUnconfirmedMpesa(500);
    expect(after.map((r) => r.paymentId)).not.toContain(payment.id);
  });
});

/**
 * Refunding a line that was haggled down.
 *
 * The customer paid the agreed price, not the board price. Refunding the board
 * price hands back money the shop never took — the single most expensive
 * arithmetic mistake a POS can make, because it looks generous rather than wrong.
 */
describe("refunding a line whose price was set at the counter", () => {
  it("gives back what was paid, not what was on the board", async () => {
    const product = await db.product.findUniqueOrThrow({ where: { id: cutId } });
    const grams = 2_000;
    const gross = Math.round((product.price * grams) / 1000);
    const off = 20_000;
    const paid = gross - off;

    const sale = await checkout(
      {
        lines: [
          {
            lineId: "l1",
            productId: cutId,
            weightGrams: grams,
            discount: { kind: "AMOUNT", value: off, reason: "Price set at the counter" },
          },
        ],
        tenders: [{ method: "MPESA", amount: paid }],
        approval: { pin: "907143" },
        idempotencyKey: key(),
      },
      cashier,
    );
    expect(sale.total).toBe(paid);

    const line = await db.saleLine.findFirstOrThrow({ where: { saleId: sale.saleId } });

    const refund = await refundSale(
      {
        saleId: sale.saleId,
        reason: "Customer returned it",
        lines: [{ saleLineId: line.id, weightGrams: grams }],
        method: "MPESA",
        approval: { pin: "907143" },
      },
      admin,
    );

    // The refund is the discounted figure, to the cent.
    expect(Math.abs(refund.amount)).toBe(paid);
  });

  it("refunds half a haggled line at half the price actually paid", async () => {
    const product = await db.product.findUniqueOrThrow({ where: { id: cutId } });
    const grams = 2_000;
    const gross = Math.round((product.price * grams) / 1000);
    const off = 20_000;
    const paid = gross - off;

    const sale = await checkout(
      {
        lines: [
          {
            lineId: "l1",
            productId: cutId,
            weightGrams: grams,
            discount: { kind: "AMOUNT", value: off, reason: "Price set at the counter" },
          },
        ],
        tenders: [{ method: "MPESA", amount: paid }],
        approval: { pin: "907143" },
        idempotencyKey: key(),
      },
      cashier,
    );
    const line = await db.saleLine.findFirstOrThrow({ where: { saleId: sale.saleId } });

    const refund = await refundSale(
      {
        saleId: sale.saleId,
        reason: "Half returned",
        lines: [{ saleLineId: line.id, weightGrams: grams / 2 }],
        method: "MPESA",
        approval: { pin: "907143" },
      },
      admin,
    );

    // Half the meat, half of what was paid for it — never half the board price.
    expect(Math.abs(refund.amount)).toBe(Math.round(paid / 2));
  });
});
