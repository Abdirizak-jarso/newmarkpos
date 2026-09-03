import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { checkout } from "@/lib/services/checkout";
import type { CurrentUser } from "@/lib/session";

/**
 * The counter under pressure, and at the edges.
 *
 * A butchery till is not a calm environment. Sales land on top of each other,
 * the network comes and goes, and a cashier will eventually type a weight with
 * one digit too many. None of that may produce a receipt number that repeats, a
 * sale banked twice, or a total nobody can explain.
 */

let cashier: CurrentUser;
let cutId: string;
let counter = 0;
const key = () => `str-${Date.now().toString(36)}-${counter++}`;

beforeAll(async () => {
  const row = await db.user.findUniqueOrThrow({ where: { staffCode: "4001" } });
  cashier = { id: row.id, name: row.name, staffCode: "4001", role: "CASHIER" };
  cutId = (await db.product.findUniqueOrThrow({ where: { sku: "BEEF-BONELESS-CUBES" } })).id;
});

async function sell(idempotencyKey: string, grams = 1_000) {
  const product = await db.product.findUniqueOrThrow({ where: { id: cutId } });
  return checkout(
    {
      lines: [{ lineId: "l1", productId: cutId, weightGrams: grams }],
      tenders: [{ method: "MPESA", amount: Math.round((product.price * grams) / 1000) }],
      idempotencyKey,
    },
    cashier,
  );
}

describe("sales landing on top of each other", () => {
  it("never issues the same receipt number twice", async () => {
    const results = await Promise.all(Array.from({ length: 25 }, () => sell(key())));
    const numbers = results.map((r) => r.receiptNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("banks a replayed key once, however many times it is sent at once", async () => {
    // The offline outbox retrying while the first attempt is still in flight.
    const shared = key();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => sell(shared)));
    const banked = results.filter((r) => r.status === "fulfilled");

    // Whatever happens to the losers, exactly one sale exists.
    const rows = await db.sale.findMany({ where: { id: shared } });
    expect(rows).toHaveLength(1);
    expect(banked.length).toBeGreaterThanOrEqual(1);

    // And it moved stock exactly once.
    const movements = await db.stockMovement.findMany({ where: { saleId: shared } });
    expect(movements).toHaveLength(1);
  });

  it("takes stock out once per sale, not once per attempt", async () => {
    await db.product.update({ where: { id: cutId }, data: { stockGrams: 100_000 } });
    const before = await db.product.findUniqueOrThrow({ where: { id: cutId } });

    await Promise.all(Array.from({ length: 10 }, () => sell(key(), 1_000)));

    const after = await db.product.findUniqueOrThrow({ where: { id: cutId } });
    expect(before.stockGrams - after.stockGrams).toBe(10_000);
  });
});

describe("at the edges of what a cashier can type", () => {
  it("sells a whole carcass's worth in one line without losing precision", async () => {
    const grams = 250_000; // 250 kg
    const sale = await sell(key(), grams);
    const line = await db.saleLine.findFirstOrThrow({ where: { saleId: sale.saleId } });
    expect(line.weightGrams).toBe(grams);

    const product = await db.product.findUniqueOrThrow({ where: { id: cutId } });
    expect(line.gross).toBe(Math.round((product.price * grams) / 1000));
  });

  it("sells a single gram without rounding it to nothing", async () => {
    const sale = await sell(key(), 1);
    const line = await db.saleLine.findFirstOrThrow({ where: { saleId: sale.saleId } });
    expect(line.weightGrams).toBe(1);
    expect(line.net).toBeGreaterThanOrEqual(0);
  });

  it("handles a basket far longer than a real one", async () => {
    const product = await db.product.findUniqueOrThrow({ where: { id: cutId } });
    const lines = Array.from({ length: 60 }, (_, i) => ({
      lineId: `l${i}`,
      productId: cutId,
      weightGrams: 137, // an awkward weight, sixty times over
    }));
    const expected = lines.length * Math.round((product.price * 137) / 1000);

    const sale = await checkout(
      { lines, tenders: [{ method: "MPESA", amount: expected }], idempotencyKey: key() },
      cashier,
    );

    // Rounded once per line and then summed — never rounded again at the end.
    expect(sale.total).toBe(expected);
    const saved = await db.saleLine.findMany({ where: { saleId: sale.saleId } });
    expect(saved).toHaveLength(60);
    expect(saved.reduce((t, l) => t + l.net, 0)).toBe(expected);
  });

  it("clamps a discount to the line rather than turning a sale into a payout", async () => {
    // One cut given away alongside one paid for — the realistic shape, and the
    // only one that can be banked, since a sale worth nothing has no payment.
    const product = await db.product.findUniqueOrThrow({ where: { id: cutId } });
    const paidGross = Math.round((product.price * 1_000) / 1000);
    const freeGross = Math.round((product.price * 500) / 1000);

    const sale = await checkout(
      {
        lines: [
          { lineId: "paid", productId: cutId, weightGrams: 1_000 },
          {
            lineId: "free",
            productId: cutId,
            weightGrams: 500,
            // Twice what the line is worth. It must come off at the line total
            // and stop there.
            discount: { kind: "AMOUNT", value: freeGross * 2, reason: "Written off" },
          },
        ],
        tenders: [{ method: "MPESA", amount: paidGross }],
        approval: { pin: "907143" },
        idempotencyKey: key(),
      },
      cashier,
    );

    const lines = await db.saleLine.findMany({ where: { saleId: sale.saleId } });
    const free = lines.find((l) => l.weightGrams === 500)!;
    expect(free.net).toBe(0);
    expect(free.discount).toBe(free.gross);
    expect(free.discount).toBeLessThanOrEqual(free.gross);
    expect(sale.total).toBe(paidGross);
  });

  it("refuses to bank a sale worth nothing", async () => {
    /*
     * A basket discounted to zero cannot be completed, and that is deliberate
     * rather than an oversight: every tender must be a positive amount, and an
     * M-Pesa payment above the total is refused because no change can be given
     * on it. Meat leaving the shop for free is a write-off with a reason code,
     * not a sale of nothing — the stock service is where that belongs.
     */
    const product = await db.product.findUniqueOrThrow({ where: { id: cutId } });
    const gross = Math.round((product.price * 1_000) / 1000);

    await expect(
      checkout(
        {
          lines: [
            {
              lineId: "l1",
              productId: cutId,
              weightGrams: 1_000,
              discount: { kind: "AMOUNT", value: gross, reason: "Written off" },
            },
          ],
          tenders: [{ method: "MPESA", amount: 1 }],
          approval: { pin: "907143" },
          idempotencyKey: key(),
        },
        cashier,
      ),
    ).rejects.toThrow();
  });
});

describe("stock that has run out", () => {
  it("still sells, and records the negative rather than hiding it", async () => {
    // The meat physically left the shop. Refusing the sale in front of a
    // customer because a number disagrees is the wrong failure.
    await db.product.update({ where: { id: cutId }, data: { stockGrams: 500 } });

    const sale = await sell(key(), 3_000);
    const after = await db.product.findUniqueOrThrow({ where: { id: cutId } });

    expect(after.stockGrams).toBe(500 - 3_000);
    const movement = await db.stockMovement.findFirstOrThrow({ where: { saleId: sale.saleId } });
    expect(movement.balanceGrams).toBe(-2_500);
    expect(movement.reason).toBe("SALE");
    expect(movement.actorId).toBe(cashier.id);
  });
});
