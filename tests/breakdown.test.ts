import { describe, expect, it } from "vitest";
import {
  assertCostBalances,
  breakdownWarnings,
  computeBreakdown,
  type BreakdownInput,
} from "@/lib/breakdown";
import { sumCents } from "@/lib/money";

/** A 180 kg beef carcass at KSh 750/kg — the shape of a real Newmark intake. */
function carcass(over: Partial<BreakdownInput> = {}): BreakdownInput {
  return {
    sourceProductId: "p-carcass",
    sourceSku: "BEEF-WHOLE-CARCASS",
    inputWeightGrams: 180_000,
    inputCost: 135_000_00, // 180 kg x KSh 750
    outputs: [
      { productId: "p1", sku: "BEEF-FILLET-TRIMMED", name: "Beef Fillet Trimmed", weightGrams: 4_500 },
      { productId: "p2", sku: "BEEF-T-BONE-STEAK", name: "T-Bone Steak", weightGrams: 12_000 },
      { productId: "p3", sku: "BEEF-BONELESS-CUBES", name: "Boneless Beef Cubes", weightGrams: 46_000 },
      { productId: "p4", sku: "BEEF-MINCE-MEAT", name: "Mince Meat", weightGrams: 38_000 },
      { productId: "p5", sku: "BEEF-SOUP-BONES", name: "Soup Bones", weightGrams: 28_000, isByProduct: true },
      { productId: "p6", sku: "BF-001", name: "Meaty Bones", weightGrams: 24_000, isByProduct: true },
    ],
    ...over,
  };
}

describe("computeBreakdown", () => {
  it("records the loss rather than absorbing it", () => {
    const result = computeBreakdown(carcass());
    // 180 kg in, 152.5 kg of cuts out.
    expect(result.outputWeightGrams).toBe(152_500);
    expect(result.lossGrams).toBe(27_500);
    expect(result.lossPercent).toBe(15.3);
    expect(result.totalYieldPercent).toBe(84.7);
  });

  it("does not expect the yields to sum to the input weight", () => {
    const result = computeBreakdown(carcass());
    const yields = result.outputs.reduce((total, o) => total + o.yieldPercent, 0);
    expect(yields).toBeLessThan(100);
    expect(yields + result.lossPercent).toBeCloseTo(100, 0);
  });

  it("marks by-products so they are reported apart from the cuts", () => {
    const result = computeBreakdown(carcass());
    const byProducts = result.outputs.filter((o) => o.isByProduct);
    expect(byProducts.map((o) => o.sku)).toEqual(["BEEF-SOUP-BONES", "BF-001"]);
  });

  it("spreads the carcass cost across the outputs without losing a cent", () => {
    const result = computeBreakdown(carcass());
    expect(sumCents(result.outputs.map((o) => o.costAllocated))).toBe(result.inputCost);
    expect(() => assertCostBalances(result)).not.toThrow();
  });

  it("makes every cut dearer than the carcass, because the loss is real", () => {
    const result = computeBreakdown(carcass());
    // KSh 750/kg went in; with 15.3% loss the recovered meat costs more.
    for (const output of result.outputs) {
      expect(output.costPerKg).toBeGreaterThan(750_00);
    }
  });

  it("refuses to create meat by cutting it up", () => {
    expect(() =>
      computeBreakdown(
        carcass({
          inputWeightGrams: 100_000,
          outputs: [{ productId: "p1", sku: "X", name: "X", weightGrams: 150_000 }],
        }),
      ),
    ).toThrow(/cannot be created/);
  });

  it("refuses a breakdown with no outputs or no input weight", () => {
    expect(() => computeBreakdown(carcass({ outputs: [] }))).toThrow(/at least one output/);
    expect(() => computeBreakdown(carcass({ inputWeightGrams: 0 }))).toThrow(/above zero/);
  });
});

describe("breakdownWarnings", () => {
  it("flags a breakdown with no loss as probably estimated", () => {
    const result = computeBreakdown(
      carcass({
        inputWeightGrams: 10_000,
        outputs: [{ productId: "p1", sku: "X", name: "X", weightGrams: 10_000 }],
      }),
    );
    expect(breakdownWarnings(result).join(" ")).toMatch(/zero shrinkage/i);
  });

  it("flags an implausible loss", () => {
    const result = computeBreakdown(
      carcass({
        inputWeightGrams: 100_000,
        outputs: [{ productId: "p1", sku: "X", name: "X", weightGrams: 40_000 }],
      }),
    );
    expect(breakdownWarnings(result).join(" ")).toMatch(/Check the scale/);
  });

  it("says nothing about an ordinary breakdown", () => {
    expect(breakdownWarnings(computeBreakdown(carcass()))).toEqual([]);
  });
});
