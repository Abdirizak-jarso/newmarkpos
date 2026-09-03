import { describe, expect, it } from "vitest";
import {
  allocate,
  cashRoundingAdjustment,
  centsToShillings,
  formatCents,
  percentOf,
  roundHalfUp,
  shillingsToCents,
  sumCents,
  taxFromInclusive,
} from "@/lib/money";

describe("roundHalfUp", () => {
  it("rounds a half up, not to even", () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(1.5)).toBe(2);
    expect(roundHalfUp(2.5)).toBe(3); // banker's rounding would give 2
  });

  it("rounds by magnitude so a refund mirrors its sale", () => {
    expect(roundHalfUp(-1.5)).toBe(-2);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(roundHalfUp(-1.4)).toBe(-1);
  });

  it("leaves whole cents alone", () => {
    expect(roundHalfUp(100)).toBe(100);
    expect(roundHalfUp(0)).toBe(0);
  });
});

describe("shillingsToCents", () => {
  it("parses what a cashier types", () => {
    expect(shillingsToCents("500")).toBe(50_000);
    expect(shillingsToCents("1,250.50")).toBe(125_050);
    expect(shillingsToCents("0.05")).toBe(5);
    expect(shillingsToCents(".5")).toBe(50);
    expect(shillingsToCents("  820  ")).toBe(82_000);
  });

  it("treats a third decimal in a money amount as a typo and rounds it", () => {
    expect(shillingsToCents("10.005")).toBe(1001);
    expect(shillingsToCents("10.004")).toBe(1000);
  });

  it("rejects nonsense rather than guessing", () => {
    expect(() => shillingsToCents("")).toThrow();
    expect(() => shillingsToCents("abc")).toThrow();
    expect(() => shillingsToCents("1.2.3")).toThrow();
  });

  it("round-trips through centsToShillings", () => {
    expect(centsToShillings(shillingsToCents("1234.56"))).toBe(1234.56);
  });
});

describe("formatCents", () => {
  it("groups thousands and always shows two decimals", () => {
    expect(formatCents(125_050)).toBe("1,250.50");
    expect(formatCents(50_000)).toBe("500.00");
    expect(formatCents(5)).toBe("0.05");
    expect(formatCents(180_000_00, { symbol: true })).toBe("KSh 180,000.00");
  });

  it("keeps the sign on a refund", () => {
    expect(formatCents(-125_050)).toBe("-1,250.50");
  });

  it("refuses fractional cents — that would mean a float leaked in", () => {
    expect(() => formatCents(10.5)).toThrow(/integer cents/);
  });
});

describe("percentOf and taxFromInclusive", () => {
  it("applies a percentage and stays in whole cents", () => {
    expect(percentOf(100_00, 16)).toBe(16_00);
    expect(percentOf(33_33, 5)).toBe(167); // 166.65 rounds half-up to 167
  });

  it("extracts VAT already contained in a shelf price", () => {
    // A KSh 116.00 inclusive price at 16% contains KSh 16.00 of VAT.
    expect(taxFromInclusive(116_00, 16)).toBe(16_00);
  });

  it("returns no tax for a zero rate", () => {
    expect(taxFromInclusive(820_00, 0)).toBe(0);
  });
});

describe("cashRoundingAdjustment", () => {
  it("is off by default", () => {
    expect(cashRoundingAdjustment(1_234_56, 0)).toBe(0);
  });

  it("rounds to the nearest 5 shillings and reports the movement", () => {
    expect(cashRoundingAdjustment(1_23_00, 5_00)).toBe(2_00); // 123 -> 125
    expect(cashRoundingAdjustment(1_22_00, 5_00)).toBe(-2_00); // 122 -> 120
    expect(cashRoundingAdjustment(1_25_00, 5_00)).toBe(0);
  });
});

describe("allocate", () => {
  it("never loses or invents a cent", () => {
    const parts = allocate(100_00, [1, 1, 1]);
    expect(sumCents(parts)).toBe(100_00);
    expect(parts).toEqual([3334, 3333, 3333]);
  });

  it("weights the split by value", () => {
    const parts = allocate(1000, [750, 250]);
    expect(sumCents(parts)).toBe(1000);
    expect(parts).toEqual([750, 250]);
  });

  it("hands leftover cents to the largest weights first", () => {
    const parts = allocate(10, [5, 3, 2]);
    expect(sumCents(parts)).toBe(10);
  });

  it("refuses a split with no weight to split across", () => {
    expect(() => allocate(100, [0, 0])).toThrow();
  });
});
