import { describe, expect, it } from "vitest";
import { checkoutSchema, tenderSchema } from "@/lib/validation";

/**
 * What the server will accept as a payment.
 *
 * The shop takes M-Pesa, and the confirmation code arrives on the customer's
 * phone seconds to minutes after they pay. A counter with a queue cannot wait
 * for it, so a tender may be banked with no code and the code recorded against
 * the sale afterwards — see recordMpesaCode, which is where the format and the
 * time become compulsory.
 *
 * What must still hold here is that a code which IS supplied is a real one.
 * Accepting a malformed code is worse than accepting none: it files the payment
 * as reconciled against something that will never appear on the statement.
 */

const CODE = "SJH4K2L9XZ";
const PAID_AT = "2026-09-02T14:32:00.000Z";

describe("M-Pesa payments", () => {
  it("accepts a complete one", () => {
    const result = tenderSchema.safeParse({
      method: "MPESA",
      amount: 100_000,
      reference: CODE,
      transactedAt: PAID_AT,
    });
    expect(result.success).toBe(true);
  });

  it("accepts one with no code yet — it is recorded after the sale", () => {
    // The customer has paid; their confirmation message has not arrived. The
    // sale banks and prints, and the payment stays PENDING until the code is
    // entered against it.
    const result = tenderSchema.safeParse({
      method: "MPESA",
      amount: 100_000,
    });
    expect(result.success).toBe(true);
    expect(result.data?.reference).toBeUndefined();
  });

  it("accepts a code with no time, since the time comes with the code", () => {
    const result = tenderSchema.safeParse({
      method: "MPESA",
      amount: 100_000,
      reference: CODE,
    });
    expect(result.success).toBe(true);
  });

  it("refuses a code that is not the right shape", () => {
    for (const reference of ["ABC", "not a code!", "12"]) {
      const result = tenderSchema.safeParse({
        method: "MPESA",
        amount: 100_000,
        reference,
        transactedAt: PAID_AT,
      });
      expect(result.success, `should reject "${reference}"`).toBe(false);
    }
  });

  it("accepts a lowercase code, since the cashier is copying off a phone", () => {
    const result = tenderSchema.safeParse({
      method: "MPESA",
      amount: 100_000,
      reference: "sjh4k2l9xz",
      transactedAt: PAID_AT,
    });
    expect(result.success).toBe(true);
    expect(result.data?.reference).toBe(CODE);
  });
});

describe("cash and card", () => {
  it("need no code or time — there is nothing to reconcile against", () => {
    expect(tenderSchema.safeParse({ method: "CASH", amount: 200_000 }).success).toBe(true);
    expect(
      tenderSchema.safeParse({ method: "CARD", amount: 200_000, reference: "AUTH12" }).success,
    ).toBe(true);
  });
});

describe("a whole sale", () => {
  const line = { lineId: "l1", productId: "p1", weightGrams: 1235 };

  it("goes through when the M-Pesa leg is complete", () => {
    const result = checkoutSchema.safeParse({
      lines: [line],
      tenders: [
        { method: "MPESA", amount: 50_000, reference: CODE, transactedAt: PAID_AT },
        { method: "CASH", amount: 51_270 },
      ],
      idempotencyKey: "abcdefgh1234",
    });
    expect(result.success).toBe(true);
  });

  it("goes through when the M-Pesa leg has no code yet", () => {
    const result = checkoutSchema.safeParse({
      lines: [line],
      tenders: [{ method: "MPESA", amount: 101_270 }],
      idempotencyKey: "abcdefgh1234",
    });
    expect(result.success).toBe(true);
  });

  it("is rejected outright when an M-Pesa code is malformed", () => {
    // The whole sale fails, not just the line — a payment filed against a code
    // that cannot exist is worse than one filed against no code at all, because
    // it looks reconciled.
    const result = checkoutSchema.safeParse({
      lines: [line],
      tenders: [{ method: "MPESA", amount: 101_270, reference: "nope!" }],
      idempotencyKey: "abcdefgh1234",
    });
    expect(result.success).toBe(false);
  });
});
