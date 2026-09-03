import { describe, expect, it } from "vitest";
import { blendCost, costOfWeight, margin, totalMargin } from "@/lib/cost";

/**
 * What the meat cost, and what the shop made on it.
 *
 * These are the sums that decide whether a carcass was worth buying. Getting
 * them wrong does not crash anything — it quietly reports a margin the shop
 * never made, which is worse, because somebody will price against it.
 */

describe("blending cost as stock arrives", () => {
  it("averages by weight rather than jumping to the last invoice", () => {
    // 20 kg held at 600.00/kg, 2 kg arriving at 900.00/kg.
    expect(blendCost(20_000, 60_000, 2_000, 90_000)).toBe(62_727);
  });

  it("takes the arriving cost when the case is empty", () => {
    expect(blendCost(0, 0, 5_000, 82_000)).toBe(82_000);
  });

  it("takes the arriving cost when stock has gone negative", () => {
    // The shop sold meat it had not booked in. There is no basis to average
    // against, and pretending otherwise produces a number nobody can defend.
    expect(blendCost(-3_000, 60_000, 5_000, 82_000)).toBe(82_000);
  });

  it("takes the arriving cost when nothing was costed before", () => {
    expect(blendCost(10_000, 0, 5_000, 82_000)).toBe(82_000);
  });

  it("leaves the cost alone when nothing arrives", () => {
    expect(blendCost(10_000, 60_000, 0, 90_000)).toBe(60_000);
  });

  it("converges on the new cost as the old stock runs out", () => {
    // A big delivery against a nearly empty case should look like the delivery.
    expect(blendCost(100, 60_000, 50_000, 90_000)).toBe(89_940);
  });

  it("refuses a negative cost", () => {
    expect(() => blendCost(1_000, 60_000, 1_000, -1)).toThrow(/negative/i);
  });

  it("stays in whole cents", () => {
    for (const [held, heldCost, inGrams, inCost] of [
      [1_235, 82_000, 777, 63_333],
      [3, 1, 7, 2],
      [999_999, 12_345, 1, 99_999],
    ] as const) {
      expect(Number.isInteger(blendCost(held, heldCost, inGrams, inCost))).toBe(true);
    }
  });
});

describe("the cost of a weight", () => {
  it("costs a gram-precise weight", () => {
    expect(costOfWeight(82_000, 1_235)).toBe(101_270);
  });

  it("is nothing when the product was never costed", () => {
    // A product with no cost on file reports no cost, not a false zero margin.
    expect(costOfWeight(0, 1_235)).toBe(0);
  });

  it("rounds half up, once, at the line", () => {
    expect(costOfWeight(33_333, 1)).toBe(33);
    expect(costOfWeight(1, 1_500)).toBe(2);
  });
});

describe("margin", () => {
  it("is taken on revenue, the way a shopkeeper quotes it", () => {
    const m = margin(100_000, 75_000);
    expect(m.profit).toBe(25_000);
    expect(m.percent).toBe(25);
  });

  it("goes negative when a cut is sold under cost", () => {
    // Exactly what haggling too hard at the counter does.
    const m = margin(70_000, 82_000);
    expect(m.profit).toBe(-12_000);
    expect(m.percent).toBeCloseTo(-17.1, 1);
  });

  it("reports nothing rather than infinity on a giveaway", () => {
    expect(margin(0, 82_000).percent).toBe(0);
    expect(margin(0, 82_000).profit).toBe(-82_000);
  });

  it("sums across lines", () => {
    const m = totalMargin([
      { revenue: 100_000, cost: 75_000 },
      { revenue: 50_000, cost: 40_000 },
    ]);
    expect(m.revenue).toBe(150_000);
    expect(m.profit).toBe(35_000);
  });
});
