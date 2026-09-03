import { describe, expect, it } from "vitest";
import {
  formatKg,
  gramsToKg,
  kgToGrams,
  netWeight,
  weightForAmount,
  weightLineTotal,
  yieldPercent,
} from "@/lib/weight";

describe("kgToGrams", () => {
  it("keeps gram precision", () => {
    expect(kgToGrams("1.235")).toBe(1235);
    expect(kgToGrams("0.005")).toBe(5);
    expect(kgToGrams(2)).toBe(2000);
  });

  it("does not lose the third decimal", () => {
    // The bug this guards: rounding 1.235 kg to 1.24 kg silently overcharges.
    expect(kgToGrams("1.235")).not.toBe(1240);
    expect(gramsToKg(kgToGrams("1.235"))).toBe(1.235);
  });

  it("rounds a scale reading finer than a gram to the nearest gram", () => {
    expect(kgToGrams("1.2356")).toBe(1236);
    expect(kgToGrams("1.2354")).toBe(1235);
  });

  it("rejects a malformed reading", () => {
    expect(() => kgToGrams("")).toThrow();
    expect(() => kgToGrams("1.2kg")).toThrow();
  });
});

describe("formatKg", () => {
  it("always prints three decimals so receipts line up", () => {
    expect(formatKg(1235)).toBe("1.235");
    expect(formatKg(2000)).toBe("2.000");
    expect(formatKg(5)).toBe("0.005");
    expect(formatKg(1235, { unit: true })).toBe("1.235 kg");
  });
});

describe("weightLineTotal", () => {
  it("prices Beef Fillet Trimmed at the live shop price", () => {
    // KSh 1,800.00/kg x 1.235 kg = KSh 2,223.00
    expect(weightLineTotal(1_800_00, 1235)).toBe(2_223_00);
  });

  it("rounds half-up once, at the line", () => {
    // 820.00/kg x 0.333 kg = 273.06 exactly
    expect(weightLineTotal(820_00, 333)).toBe(273_06);
    // 1,630.00/kg x 0.077 kg = 125.51
    expect(weightLineTotal(1_630_00, 77)).toBe(125_51);
  });

  it("charges nothing for nothing", () => {
    expect(weightLineTotal(1_800_00, 0)).toBe(0);
  });
});

describe("weightForAmount", () => {
  it("back-calculates the cut for a shilling budget", () => {
    // "Give me 500 bob of boneless beef cubes" at KSh 820/kg -> 0.610 kg
    expect(weightForAmount(820_00, 500_00)).toBe(610);
    // "1000 bob of goat cubes boneless" at KSh 1,200/kg -> 0.833 kg
    expect(weightForAmount(1_200_00, 1_000_00)).toBe(833);
  });

  it("stays consistent with weightLineTotal to within a rounding cent", () => {
    const pricePerKg = 990_00; // Goat Mince
    const budget = 350_00;
    const grams = weightForAmount(pricePerKg, budget);
    expect(Math.abs(weightLineTotal(pricePerKg, grams) - budget)).toBeLessThanOrEqual(50);
  });

  it("refuses to divide by a zero price", () => {
    expect(() => weightForAmount(0, 500_00)).toThrow();
  });
});

describe("netWeight", () => {
  it("subtracts the tub", () => {
    expect(netWeight(1500, 120)).toBe(1380);
  });

  it("refuses a tare heavier than the gross", () => {
    expect(() => netWeight(100, 500)).toThrow(/tare/i);
  });
});

describe("yieldPercent", () => {
  it("reports to one decimal place", () => {
    expect(yieldPercent(72_500, 100_000)).toBe(72.5);
    expect(yieldPercent(1234, 10_000)).toBe(12.3);
  });
});
