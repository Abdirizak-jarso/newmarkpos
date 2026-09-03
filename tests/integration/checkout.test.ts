import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { checkout } from "@/lib/services/checkout";
import { recordBreakdown, receiveStock } from "@/lib/services/stock";
import { carcassLedger } from "@/lib/services/reports";
import {
  listUnconfirmedMpesa,
  recordMpesaCode,
  refundSale,
  voidSale,
} from "@/lib/services/sales";
import { verifyApprover, type CurrentUser } from "@/lib/session";
import type { CheckoutInput } from "@/lib/validation";

/**
 * The full checkout path against a real database.
 *
 * These are the flows that lose a butchery money when they go wrong: the sale
 * banking twice, stock not moving, a void that quietly edits history, an
 * approval that isn't actually checked. Mocks would not catch any of them.
 */

let cashier: CurrentUser;
let admin: CurrentUser;
let cubesId: string;
let chickenId: string;
let counter = 0;

/** Each test needs its own key; a repeated one is a *feature* tested below. */
const key = () => `it-${Date.now().toString(36)}-${counter++}`;

beforeAll(async () => {
  const cashierRow = await db.user.findUniqueOrThrow({ where: { staffCode: "4001" } });
  const adminRow = await db.user.findUniqueOrThrow({ where: { staffCode: "1000" } });

  cashier = { id: cashierRow.id, name: cashierRow.name, staffCode: "4001", role: "CASHIER" };
  admin = { id: adminRow.id, name: adminRow.name, staffCode: "1000", role: "ADMIN" };

  cubesId = (await db.product.findUniqueOrThrow({ where: { sku: "BEEF-BONELESS-CUBES" } })).id;
  chickenId = (await db.product.findUniqueOrThrow({ where: { sku: "CH-001" } })).id;
});

/** A line as the checkout schema accepts it, so a test can set any field. */
type BasketLine = CheckoutInput["lines"][number];

function basket(idempotencyKey: string) {
  return {
    lines: [
      { lineId: "l1", productId: cubesId, weightGrams: 1235 },
      { lineId: "l2", productId: chickenId, quantity: 2 },
    ] as BasketLine[],
    // 820.00/kg x 1.235 kg = 1,012.70 ; 489.00 x 2 = 978.00 ; total 1,990.70
    tenders: [
      { method: "MPESA" as const, amount: 100_000, reference: "TEST01" },
      { method: "CASH" as const, amount: 100_000 },
    ],
    idempotencyKey,
  };
}

describe("checkout", () => {
  it("prices the basket and gives the right change", async () => {
    const sale = await checkout(basket(key()), cashier);

    expect(sale.total).toBe(199_070);
    expect(sale.changeDue).toBe(930);
    expect(sale.receiptNumber).toMatch(/^T9-\d{6}$/);
    expect(sale.receiptPayload.length).toBeGreaterThan(200);
  });

  it("prices from the catalogue, not from anything the client sent", async () => {
    const product = await db.product.findUniqueOrThrow({ where: { id: cubesId } });
    const sale = await checkout(basket(key()), cashier);

    const line = await db.saleLine.findFirstOrThrow({
      where: { saleId: sale.saleId, productId: cubesId },
    });
    expect(line.unitPrice).toBe(product.price);
    // Gram precision survives the round trip through the database.
    expect(line.weightGrams).toBe(1235);
  });

  it("charges the rate the cashier typed, and records the board rate beside it", async () => {
    const product = await db.product.findUniqueOrThrow({ where: { id: cubesId } });
    const typed = product.price + 40_00; // above the board — nobody needs to approve it
    const input = basket(key());
    input.lines = [{ lineId: "l1", productId: cubesId, weightGrams: 1235, unitPriceOverride: typed }];
    input.tenders = [{ method: "CASH" as const, amount: 200_000 }];

    const sale = await checkout(input, cashier);
    const line = await db.saleLine.findFirstOrThrow({ where: { saleId: sale.saleId } });

    expect(line.unitPrice).toBe(typed);
    expect(line.catalogueUnitPrice).toBe(product.price);
    expect(line.priceOverridden).toBe(true);
    // 1.235 kg at the typed rate, to the cent.
    expect(line.gross).toBe(Math.round((typed * 1235) / 1000));
    expect(sale.total).toBe(line.gross);
    // A rate is not a discount. Nothing has been given away here.
    expect(line.discount).toBe(0);
  });

  it("leaves a line the cashier did not price alone", async () => {
    const product = await db.product.findUniqueOrThrow({ where: { id: cubesId } });
    const sale = await checkout(basket(key()), cashier);
    const line = await db.saleLine.findFirstOrThrow({
      where: { saleId: sale.saleId, productId: cubesId },
    });

    expect(line.priceOverridden).toBe(false);
    expect(line.catalogueUnitPrice).toBe(product.price);
    expect(line.unitPrice).toBe(product.price);
  });

  it("writes a typed rate to the audit log with both figures", async () => {
    const product = await db.product.findUniqueOrThrow({ where: { id: cubesId } });
    const typed = product.price - 10_00; // small enough to be the cashier's call
    const input = basket(key());
    input.lines = [{ lineId: "l1", productId: cubesId, weightGrams: 1000, unitPriceOverride: typed }];
    input.tenders = [{ method: "CASH" as const, amount: 200_000 }];

    const sale = await checkout(input, cashier);
    const event = await db.auditEvent.findFirstOrThrow({
      where: { action: "SALE_PRICE_OVERRIDE", entityId: `${sale.saleId}:l1` },
    });

    expect(event.actorId).toBe(cashier.id);
    // Nobody approves a typed rate, so nobody is ever recorded as having.
    expect(event.approverId).toBeNull();
    expect(JSON.parse(event.before!).unitPrice).toBe(product.price);
    expect(JSON.parse(event.after!).unitPrice).toBe(typed);
    expect(JSON.parse(event.after!).difference).toBe(-10_00);
  });

  it("takes a rate keyed far below the board from a cashier, with no PIN", async () => {
    const product = await db.product.findUniqueOrThrow({ where: { id: cubesId } });
    // Half the board price — past the seeded KSh 500 / 10% discount threshold,
    // which is exactly the point: that threshold governs discounts, not the
    // price the counter sets.
    const typed = Math.round(product.price / 2);
    const input = basket(key());
    input.lines = [{ lineId: "l1", productId: cubesId, weightGrams: 1000, unitPriceOverride: typed }];
    input.tenders = [{ method: "CASH" as const, amount: 200_000 }];

    const sale = await checkout(input, cashier);
    const line = await db.saleLine.findFirstOrThrow({ where: { saleId: sale.saleId } });
    expect(line.unitPrice).toBe(typed);
    expect(sale.total).toBe(typed);
  });

  it("takes a rate keyed far above the board, however far", async () => {
    const product = await db.product.findUniqueOrThrow({ where: { id: cubesId } });
    const input = basket(key());
    input.lines = [
      { lineId: "l1", productId: cubesId, weightGrams: 1000, unitPriceOverride: product.price * 3 },
    ];
    input.tenders = [{ method: "CASH" as const, amount: 900_000 }];

    const sale = await checkout(input, cashier);
    expect(sale.total).toBe(product.price * 3);
  });

  it("records a giveaway it no longer blocks", async () => {
    /*
     * With the gate gone this audit row is the shop's only sight of a cut sold
     * at half price. If it ever stops being written, nothing anywhere else
     * will show that it happened.
     */
    const product = await db.product.findUniqueOrThrow({ where: { id: cubesId } });
    const typed = Math.round(product.price / 2);
    const input = basket(key());
    input.lines = [{ lineId: "l1", productId: cubesId, weightGrams: 1000, unitPriceOverride: typed }];
    input.tenders = [{ method: "CASH" as const, amount: 200_000 }];

    const sale = await checkout(input, cashier);
    const event = await db.auditEvent.findFirstOrThrow({
      where: { action: "SALE_PRICE_OVERRIDE", entityId: `${sale.saleId}:l1` },
    });

    expect(event.actorId).toBe(cashier.id);
    expect(JSON.parse(event.before!).unitPrice).toBe(product.price);
    expect(JSON.parse(event.after!).unitPrice).toBe(typed);
    expect(JSON.parse(event.after!).difference).toBe(typed - product.price);
  });

  it("still asks for a PIN for a large DISCOUNT on a counter-priced line", async () => {
    // The rate is the cashier's to set; taking a further chunk off it as a
    // discount is still an admin's call.
    const product = await db.product.findUniqueOrThrow({ where: { id: cubesId } });
    const input = basket(key());
    input.lines = [
      {
        lineId: "l1",
        productId: cubesId,
        weightGrams: 1000,
        unitPriceOverride: Math.round(product.price / 2),
        discount: { kind: "AMOUNT" as const, value: 50_000 },
      },
    ];
    input.tenders = [{ method: "CASH" as const, amount: 200_000 }];

    await expect(checkout(input, cashier)).rejects.toThrow(/manager/i);
  });

  it("never puts an approver's name against a price nobody approved", async () => {
    /*
     * A sale can carry an approved discount on one line and a typed rate on
     * another. The discount's approver must not leak onto the price record —
     * that would read, for ever, as an admin having signed off a price they
     * were never shown.
     */
    const product = await db.product.findUniqueOrThrow({ where: { id: cubesId } });
    const input = basket(key());
    input.lines = [
      { lineId: "l1", productId: cubesId, weightGrams: 1000, unitPriceOverride: 900_00 },
      { lineId: "l2", productId: chickenId, quantity: 1, discount: { kind: "AMOUNT" as const, value: 60_000 } },
    ];
    input.tenders = [{ method: "CASH" as const, amount: 200_000 }];

    const sale = await checkout({ ...input, approval: { pin: "907143" } }, cashier);

    const priceEvent = await db.auditEvent.findFirstOrThrow({
      where: { action: "SALE_PRICE_OVERRIDE", entityId: `${sale.saleId}:l1` },
    });
    expect(priceEvent.approverId).toBeNull();

    // The discount on the other line still records who let it through.
    const discountEvent = await db.auditEvent.findFirstOrThrow({
      where: { action: "SALE_DISCOUNT", entityId: sale.saleId },
    });
    expect(discountEvent.approverId).not.toBeNull();
    expect(product.price).toBeGreaterThan(0);
  });

  it("prints the typed rate on the receipt, not the board rate", async () => {
    // Above the board, so the receipt is the only thing under test here and
    // not the approval gate.
    const typed = 955_00;
    const input = basket(key());
    input.lines = [{ lineId: "l1", productId: cubesId, weightGrams: 1000, unitPriceOverride: typed }];
    input.tenders = [{ method: "CASH" as const, amount: 200_000 }];

    const sale = await checkout(input, cashier);
    const receipt = Buffer.from(sale.receiptPayload, "base64").toString("latin1");
    expect(receipt).toContain("955.00");
    // And not the catalogue's 820.00, which nobody was quoted.
    expect(receipt).not.toContain("820.00");
  });

  it("still refuses a price the client tries to smuggle in any other way", async () => {
    const product = await db.product.findUniqueOrThrow({ where: { id: cubesId } });
    const input = basket(key());
    // A field the client has no business setting. It is not in the schema and
    // it is not read — the line prices from the catalogue as if it were absent.
    (input.lines[0] as Record<string, unknown>).unitPrice = 1_00;
    (input.lines[0] as Record<string, unknown>).gross = 1_00;

    const sale = await checkout(input, cashier);
    const line = await db.saleLine.findFirstOrThrow({
      where: { saleId: sale.saleId, productId: cubesId },
    });
    expect(line.unitPrice).toBe(product.price);
  });

  it("mints per-terminal receipt numbers that never repeat", async () => {
    const a = await checkout(basket(key()), cashier);
    const b = await checkout(basket(key()), cashier);

    expect(a.receiptNumber).not.toBe(b.receiptNumber);
    expect(a.receiptNumber.startsWith("T9-")).toBe(true);
  });

  it("banks a replayed offline sale only once", async () => {
    const input = basket(key());

    const first = await checkout(input, cashier);
    const replay = await checkout(input, cashier);

    expect(replay.saleId).toBe(first.saleId);
    expect(await db.sale.count({ where: { id: input.idempotencyKey } })).toBe(1);
  });

  it("takes the meat out of stock with a reason and an actor", async () => {
    const before = await db.product.findUniqueOrThrow({ where: { id: cubesId } });
    const sale = await checkout(basket(key()), cashier);
    const after = await db.product.findUniqueOrThrow({ where: { id: cubesId } });

    expect(after.stockGrams).toBe(before.stockGrams - 1235);

    const movement = await db.stockMovement.findFirstOrThrow({
      where: { saleId: sale.saleId, productId: cubesId },
    });
    expect(movement.reason).toBe("SALE");
    expect(movement.actorId).toBe(cashier.id);
    expect(movement.deltaGrams).toBe(-1235);
    expect(movement.balanceGrams).toBe(after.stockGrams);
  });

  it("moves stock in kilograms for a per-piece line too", async () => {
    const before = await db.product.findUniqueOrThrow({ where: { id: chickenId } });
    await checkout(basket(key()), cashier);
    const after = await db.product.findUniqueOrThrow({ where: { id: chickenId } });

    // Two birds at 1.4 kg each.
    expect(after.stockGrams).toBe(before.stockGrams - 2800);
  });

  it("queues the receipt and the tax invoice without blocking the sale", async () => {
    const sale = await checkout(basket(key()), cashier);

    const job = await db.printJob.findFirstOrThrow({ where: { saleId: sale.saleId } });
    expect(job.status).toBe("QUEUED");
    expect(job.kind).toBe("RECEIPT");

    const invoice = await db.taxInvoice.findUniqueOrThrow({ where: { saleId: sale.saleId } });
    expect(invoice.status).toBe("PENDING");
  });

  it("queues the sale for sync to the central server", async () => {
    const sale = await checkout(basket(key()), cashier);
    const queued = await db.syncQueue.findFirstOrThrow({ where: { entityId: sale.saleId } });
    expect(queued.status).toBe("PENDING");
  });

  it("refuses a short payment rather than completing the sale", async () => {
    const input = basket(key());
    input.tenders = [{ method: "CASH" as const, amount: 100_00, reference: undefined as never }];

    await expect(checkout(input, cashier)).rejects.toThrow(/Short by/);
  });

  it("refuses a product that has been taken off sale", async () => {
    const retired = await db.product.create({
      data: {
        sku: `TEST-RETIRED-${counter++}`,
        name: "Retired Cut",
        slug: `retired-${counter}`,
        categoryId: (await db.category.findFirstOrThrow()).id,
        price: 500_00,
        active: false,
      },
    });

    const input = basket(key());
    input.lines = [{ lineId: "l1", productId: retired.id, weightGrams: 1000 }];
    input.tenders = [{ method: "CASH" as const, amount: 500_00, reference: undefined as never }];

    await expect(checkout(input, cashier)).rejects.toThrow(/no longer on sale/);
  });
});

describe("admin approval", () => {
  it("accepts the right staff code and PIN", async () => {
    const approver = await verifyApprover("907143", "sale.void");
    expect(approver.id).toBe(admin.id);
  });

  it("rejects a wrong PIN", async () => {
    await expect(verifyApprover("111111", "sale.void")).rejects.toThrow(/not recognised/);
  });

  it("refuses a cashier's own PIN for a admin action", async () => {
    // The PIN is perfectly valid — it just belongs to someone who does not
    // carry the permission, and the server is where that is decided.
    await expect(verifyApprover("270496", "sale.void")).rejects.toThrow(/cannot authorise/);
  });

  it("refuses a PIN that belongs to nobody", async () => {
    await expect(verifyApprover("314159", "sale.void")).rejects.toThrow(/not recognised/);
  });
});

describe("void", () => {
  it("marks the sale voided without editing what it was", async () => {
    const sale = await checkout(basket(key()), cashier);

    await voidSale(
      { saleId: sale.saleId, reason: "Customer changed their mind", approval: { pin: "907143" } },
      admin,
    );

    const voided = await db.sale.findUniqueOrThrow({
      where: { id: sale.saleId },
      include: { lines: true },
    });
    expect(voided.status).toBe("VOIDED");
    // The original figures are untouched; only the status moved.
    expect(voided.total).toBe(199_070);
    expect(voided.lines).toHaveLength(2);
    expect(voided.voidReason).toBe("Customer changed their mind");
  });

  it("puts the meat back into stock", async () => {
    const before = await db.product.findUniqueOrThrow({ where: { id: cubesId } });
    const sale = await checkout(basket(key()), cashier);

    await voidSale(
      { saleId: sale.saleId, reason: "Rung up twice", approval: { pin: "907143" } },
      admin,
    );

    const after = await db.product.findUniqueOrThrow({ where: { id: cubesId } });
    expect(after.stockGrams).toBe(before.stockGrams);
  });

  it("stops the voided sale's invoice reaching KRA", async () => {
    const sale = await checkout(basket(key()), cashier);
    await voidSale(
      { saleId: sale.saleId, reason: "Test", approval: { pin: "907143" } },
      admin,
    );

    const invoice = await db.taxInvoice.findUniqueOrThrow({ where: { saleId: sale.saleId } });
    expect(invoice.status).toBe("NOT_APPLICABLE");
  });

  it("records the void with both the actor and the approver", async () => {
    const sale = await checkout(basket(key()), cashier);
    await voidSale(
      { saleId: sale.saleId, reason: "Wrong cut", approval: { pin: "907143" } },
      cashier,
    );

    const entry = await db.auditEvent.findFirstOrThrow({
      where: { action: "VOID_SALE", entityId: sale.saleId },
    });
    expect(entry.actorId).toBe(cashier.id);
    expect(entry.approverId).toBe(admin.id);
    expect(entry.before).toContain("COMPLETED");
    expect(entry.after).toContain("VOIDED");
    expect(entry.reason).toBe("Wrong cut");
  });

  it("will not void twice", async () => {
    const sale = await checkout(basket(key()), cashier);
    const approval = { pin: "907143" };

    await voidSale({ saleId: sale.saleId, reason: "First", approval }, admin);
    await expect(voidSale({ saleId: sale.saleId, reason: "Again", approval }, admin)).rejects.toThrow(
      /already been voided/,
    );
  });
});

describe("refund", () => {
  it("records a reversal as its own negative sale", async () => {
    const sale = await checkout(basket(key()), cashier);

    const refund = await refundSale(
      {
        saleId: sale.saleId,
        lines: [],
        reason: "Meat was off",
        method: "CASH",
        approval: { pin: "907143" },
      },
      admin,
    );

    expect(refund.amount).toBe(199_070);

    const reversal = await db.sale.findUniqueOrThrow({ where: { id: refund.refundSaleId } });
    expect(reversal.total).toBe(-199_070);
    expect(reversal.reversesSaleId).toBe(sale.saleId);

    // The original is marked, not rewritten.
    const original = await db.sale.findUniqueOrThrow({ where: { id: sale.saleId } });
    expect(original.total).toBe(199_070);
    expect(original.status).toBe("REFUNDED");
  });

  it("refunds part of a weighed line proportionally", async () => {
    const sale = await checkout(basket(key()), cashier);
    const line = await db.saleLine.findFirstOrThrow({
      where: { saleId: sale.saleId, productId: cubesId },
    });

    const refund = await refundSale(
      {
        saleId: sale.saleId,
        // Half a kilo of the 1.235 kg line comes back.
        lines: [{ saleLineId: line.id, weightGrams: 500 }],
        reason: "Customer returned part",
        method: "CASH",
        approval: { pin: "907143" },
      },
      admin,
    );

    // 1,012.70 x (500 / 1235) = 410.00 exactly
    expect(refund.amount).toBe(41_000);
    // A partial refund does not close the original sale.
    const original = await db.sale.findUniqueOrThrow({ where: { id: sale.saleId } });
    expect(original.status).toBe("COMPLETED");
  });

  it("refuses to take back more than was sold", async () => {
    const sale = await checkout(basket(key()), cashier);
    const line = await db.saleLine.findFirstOrThrow({
      where: { saleId: sale.saleId, productId: cubesId },
    });

    await expect(
      refundSale(
        {
          saleId: sale.saleId,
          lines: [{ saleLineId: line.id, weightGrams: 5000 }],
          reason: "Trying it on",
          method: "CASH",
          approval: { pin: "907143" },
        },
        admin,
      ),
    ).rejects.toThrow(/more .* than was sold/i);
  });
});

/**
 * Paying by M-Pesa without the code, and recording it afterwards.
 *
 * This is the shop's actual counter flow: the customer pays, the sale banks and
 * the receipt prints, and the Safaricom confirmation is matched to it minutes
 * later. What must hold is that the shop can always tell which money it can
 * prove and which it cannot — an M-Pesa payment is not CONFIRMED until a code
 * is against it, and no code may be claimed twice.
 */
describe("M-Pesa reconciliation", () => {
  function unpaidBasket(idempotencyKey: string) {
    return {
      lines: [{ lineId: "l1", productId: cubesId, weightGrams: 1000 }],
      tenders: [{ method: "MPESA" as const, amount: 82_000 }],
      idempotencyKey,
    };
  }

  const uniqueCode = () =>
    `TEST${Math.random().toString(36).slice(2, 8).toUpperCase()}`.slice(0, 10);

  it("banks and prints a sale whose code has not arrived yet", async () => {
    const sale = await checkout(unpaidBasket(key()), cashier);

    const payment = await db.payment.findFirstOrThrow({ where: { saleId: sale.saleId } });
    expect(payment.status).toBe("PENDING");
    expect(payment.reference).toBeNull();

    // The sale itself is complete and the receipt is queued — the missing code
    // holds nothing up at the counter.
    const banked = await db.sale.findUniqueOrThrow({ where: { id: sale.saleId } });
    expect(banked.status).toBe("COMPLETED");
    expect(sale.receiptPayload.length).toBeGreaterThan(200);
  });

  it("lists it as waiting, then stops once the code is recorded", async () => {
    const sale = await checkout(unpaidBasket(key()), cashier);
    const payment = await db.payment.findFirstOrThrow({ where: { saleId: sale.saleId } });

    const before = await listUnconfirmedMpesa(200);
    expect(before.map((row) => row.paymentId)).toContain(payment.id);

    await recordMpesaCode(
      {
        saleId: sale.saleId,
        paymentId: payment.id,
        reference: uniqueCode(),
        transactedAt: new Date().toISOString(),
      },
      cashier,
    );

    const after = await listUnconfirmedMpesa(200);
    expect(after.map((row) => row.paymentId)).not.toContain(payment.id);

    const confirmed = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.transactedAt).not.toBeNull();
  });

  it("does not touch the sale, its lines or its total", async () => {
    const sale = await checkout(unpaidBasket(key()), cashier);
    const payment = await db.payment.findFirstOrThrow({ where: { saleId: sale.saleId } });
    const before = await db.sale.findUniqueOrThrow({
      where: { id: sale.saleId },
      include: { lines: true },
    });

    await recordMpesaCode(
      {
        saleId: sale.saleId,
        paymentId: payment.id,
        reference: uniqueCode(),
        transactedAt: new Date().toISOString(),
      },
      cashier,
    );

    const after = await db.sale.findUniqueOrThrow({
      where: { id: sale.saleId },
      include: { lines: true },
    });
    expect(after.total).toBe(before.total);
    expect(after.status).toBe(before.status);
    expect(after.lines.map((l) => l.net)).toEqual(before.lines.map((l) => l.net));
  });

  it("refuses the same code on two sales", async () => {
    const code = uniqueCode();

    const first = await checkout(unpaidBasket(key()), cashier);
    const firstPayment = await db.payment.findFirstOrThrow({ where: { saleId: first.saleId } });
    await recordMpesaCode(
      {
        saleId: first.saleId,
        paymentId: firstPayment.id,
        reference: code,
        transactedAt: new Date().toISOString(),
      },
      cashier,
    );

    // The cashier copies the wrong message off the phone. Catching this is the
    // entire reason the shop collects the code.
    const second = await checkout(unpaidBasket(key()), cashier);
    const secondPayment = await db.payment.findFirstOrThrow({ where: { saleId: second.saleId } });

    await expect(
      recordMpesaCode(
        {
          saleId: second.saleId,
          paymentId: secondPayment.id,
          reference: code,
          transactedAt: new Date().toISOString(),
        },
        cashier,
      ),
    ).rejects.toThrow(/already on receipt/i);

    const untouched = await db.payment.findUniqueOrThrow({ where: { id: secondPayment.id } });
    expect(untouched.status).toBe("PENDING");
    expect(untouched.reference).toBeNull();
  });

  it("refuses to overwrite a code that is already recorded", async () => {
    const sale = await checkout(unpaidBasket(key()), cashier);
    const payment = await db.payment.findFirstOrThrow({ where: { saleId: sale.saleId } });
    const original = uniqueCode();

    await recordMpesaCode(
      {
        saleId: sale.saleId,
        paymentId: payment.id,
        reference: original,
        transactedAt: new Date().toISOString(),
      },
      cashier,
    );

    await expect(
      recordMpesaCode(
        {
          saleId: sale.saleId,
          paymentId: payment.id,
          reference: uniqueCode(),
          transactedAt: new Date().toISOString(),
        },
        cashier,
      ),
    ).rejects.toThrow(/already recorded/i);

    const kept = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(kept.reference).toBe(original);
  });

  it("refuses a payment that is not on the sale given", async () => {
    const a = await checkout(unpaidBasket(key()), cashier);
    const b = await checkout(unpaidBasket(key()), cashier);
    const paymentOnB = await db.payment.findFirstOrThrow({ where: { saleId: b.saleId } });

    await expect(
      recordMpesaCode(
        {
          saleId: a.saleId,
          paymentId: paymentOnB.id,
          reference: uniqueCode(),
          transactedAt: new Date().toISOString(),
        },
        cashier,
      ),
    ).rejects.toThrow(/not on this sale/i);
  });

  it("writes an audit row naming who cleared it", async () => {
    const sale = await checkout(unpaidBasket(key()), cashier);
    const payment = await db.payment.findFirstOrThrow({ where: { saleId: sale.saleId } });
    const code = uniqueCode();

    await recordMpesaCode(
      {
        saleId: sale.saleId,
        paymentId: payment.id,
        reference: code,
        transactedAt: new Date().toISOString(),
      },
      cashier,
    );

    const event = await db.auditEvent.findFirstOrThrow({
      where: { action: "RECORD_MPESA_CODE", entityId: payment.id },
    });
    expect(event.actorId).toBe(cashier.id);
    expect(event.after).toContain(code);
  });
});

/**
 * A price set at the counter.
 *
 * The till sends the gap between the catalogue price and what was agreed, never
 * a price. What has to hold end to end: the customer is charged exactly the
 * figure the cashier typed, the sale still records the catalogue price it was
 * struck from, and a big enough reduction cannot be banked without a manager —
 * because the client asking nicely is not authorisation.
 */
describe("setting a price at the counter", () => {
  function haggled(idempotencyKey: string, charge: number, grams = 1240) {
    return async () => {
      const product = await db.product.findUniqueOrThrow({ where: { id: cubesId } });
      const catalogue = Math.round((product.price * grams) / 1000);
      return {
        catalogue,
        product,
        input: {
          lines: [
            {
              lineId: "l1",
              productId: cubesId,
              weightGrams: grams,
              discount: {
                kind: "AMOUNT" as const,
                value: catalogue - charge,
                reason: "Price set at the counter",
              },
            },
          ],
          tenders: [{ method: "MPESA" as const, amount: charge }],
          idempotencyKey,
        },
      };
    };
  }

  it("charges exactly what the cashier typed", async () => {
    // A small reduction the cashier may make alone.
    const { catalogue, input } = await haggled(key(), 0)();
    const charge = catalogue - 2_000; // KSh 20 off
    input.lines[0]!.discount.value = catalogue - charge;
    input.tenders[0]!.amount = charge;

    const sale = await checkout(input, cashier);
    expect(sale.total).toBe(charge);

    const line = await db.saleLine.findFirstOrThrow({ where: { saleId: sale.saleId } });
    // The line still records what the shop's board says, so the margin given
    // away is visible in every report rather than lost in a changed price.
    expect(line.gross).toBe(catalogue);
    expect(line.discount).toBe(catalogue - charge);
    expect(line.net).toBe(charge);
  });

  it("prices from the catalogue even so — the discount is all the client sets", async () => {
    const { catalogue, product, input } = await haggled(key(), 0)();
    const charge = catalogue - 2_000;
    input.lines[0]!.discount.value = catalogue - charge;
    input.tenders[0]!.amount = charge;

    const sale = await checkout(input, cashier);
    const line = await db.saleLine.findFirstOrThrow({ where: { saleId: sale.saleId } });
    expect(line.unitPrice).toBe(product.price);
  });

  it("refuses a big reduction with no manager PIN", async () => {
    const { catalogue, input } = await haggled(key(), 0)();
    // Well past the seeded KSh 500 / 10% threshold.
    const charge = Math.round(catalogue / 2);
    input.lines[0]!.discount.value = catalogue - charge;
    input.tenders[0]!.amount = charge;

    await expect(checkout(input, cashier)).rejects.toThrow(/manager/i);
  });

  it("takes the same reduction once a manager has approved it", async () => {
    const { catalogue, input } = await haggled(key(), 0)();
    const charge = Math.round(catalogue / 2);
    input.lines[0]!.discount.value = catalogue - charge;
    input.tenders[0]!.amount = charge;

    const sale = await checkout({ ...input, approval: { pin: "907143" } }, cashier);
    expect(sale.total).toBe(charge);
  });

  it("cannot be pushed above the catalogue price by a negative discount", async () => {
    const { catalogue, input } = await haggled(key(), 0)();
    input.lines[0]!.discount.value = -5_000;
    input.tenders[0]!.amount = catalogue + 5_000;

    await expect(checkout(input, cashier)).rejects.toThrow();
  });
});

/**
 * The carcass ledger, end to end.
 *
 * Buy an animal, break it into cuts, sell some of them, and ask the question a
 * butcher actually asks: did it pay for itself? Every figure in that answer is
 * assembled from a different part of the system, which is exactly why it is
 * worth testing as one flow rather than four units.
 */
describe("the carcass ledger", () => {
  it("carries cost from the carcass, through the cuts, onto the sale", async () => {
    const source = await db.product.findFirstOrThrow({ where: { sku: "GOAT-WHOLE" } });
    const outputs = await db.product.findMany({
      where: { categoryId: source.categoryId, isBreakdownSource: false, active: true },
      take: 2,
    });
    if (outputs.length < 2) return; // seed has no cuts for this carcass

    const before = new Date();
    const inputCost = 1_840_000; // KSh 18,400 for the animal

    await recordBreakdown(
      {
        sourceProductId: source.id,
        inputWeightGrams: 18_400,
        inputCost,
        supplier: "Ledger test",
        outputs: [
          { productId: outputs[0]!.id, weightGrams: 9_000 },
          { productId: outputs[1]!.id, weightGrams: 7_100 },
        ],
      },
      admin,
    );

    // The cut now carries its share of the carcass, loaded with the trim loss.
    const cut = await db.product.findUniqueOrThrow({ where: { id: outputs[0]!.id } });
    expect(cut.costPerKg).toBeGreaterThan(0);

    // Sell a kilo of it.
    const sale = await checkout(
      {
        lines: [{ lineId: "l1", productId: cut.id, weightGrams: 1_000 }],
        tenders: [{ method: "MPESA" as const, amount: cut.price }],
        idempotencyKey: key(),
      },
      cashier,
    );

    const line = await db.saleLine.findFirstOrThrow({ where: { saleId: sale.saleId } });
    // The cost is stamped on the line, not looked up later.
    expect(line.cost).toBeGreaterThan(0);
    expect(line.costPerKg).toBe(cut.costPerKg);

    const ledger = await carcassLedger(before, new Date());
    const entry = ledger.find((row) => row.supplier === "Ledger test");
    expect(entry).toBeDefined();
    expect(entry!.costIn).toBe(inputCost);
    expect(entry!.lossGrams).toBe(18_400 - 16_100);
    expect(entry!.boardValue).toBeGreaterThan(0);
    expect(entry!.sold).toBeGreaterThanOrEqual(line.net);
  });

  it("does not reprice a sale that already happened when a delivery arrives", async () => {
    const product = await db.product.findUniqueOrThrow({ where: { id: cubesId } });

    const sale = await checkout(
      {
        lines: [{ lineId: "l1", productId: cubesId, weightGrams: 1_000 }],
        tenders: [{ method: "MPESA" as const, amount: product.price }],
        idempotencyKey: key(),
      },
      cashier,
    );
    const stamped = await db.saleLine.findFirstOrThrow({ where: { saleId: sale.saleId } });

    // A dear delivery lands the next day.
    await receiveStock(
      { productId: cubesId, weightGrams: 20_000, costPerKg: 200_000, supplier: "Dear" },
      admin,
    );

    const after = await db.saleLine.findUniqueOrThrow({ where: { id: stamped.id } });
    expect(after.cost).toBe(stamped.cost);
    expect(after.costPerKg).toBe(stamped.costPerKg);
  });

  it("blends the new delivery into the cost rather than jumping to it", async () => {
    // A known starting point: 20 kg on hand at 600.00/kg. Other tests sell this
    // catalogue freely, and blending against a case that has gone negative has
    // no meaning — which is what blendCost is tested for separately.
    await db.product.update({
      where: { id: chickenId },
      data: { stockGrams: 20_000, costPerKg: 60_000 },
    });

    await receiveStock(
      { productId: chickenId, weightGrams: 2_000, costPerKg: 90_000, supplier: "Dear" },
      admin,
    );

    const blended = await db.product.findUniqueOrThrow({ where: { id: chickenId } });
    // Not 900.00/kg. Twenty kilos at 600 and two at 900 is 627.27.
    expect(blended.costPerKg).toBe(62_727);
  });
});
