import { describe, expect, it } from "vitest";
import {
  catalogueLineGross,
  effectiveUnitPrice,
  lineGross,
  priceOverrideGap,
  priceSale,
  reductionNeedsApproval,
  type CartLineInput,
  type PricingSettings,
} from "@/lib/pricing";

/**
 * Prices typed at the counter.
 *
 * The product grid quotes nothing; the cashier types a rate and a weight for
 * every line. That makes the arithmetic here the arithmetic of every sale the
 * shop makes, not an edge case.
 *
 * No approval gates any of it — the counter sets its own prices. What the
 * shop keeps instead is the record: the gap between the typed rate and the
 * board rate on every line, which is what makes the pricing reviewable in the
 * evening. These tests hold that record to being correct, because with the
 * gate gone it is the only control left.
 */

const settings: PricingSettings = { standardVatRatePercent: 16, cashRoundingStep: 0 };
const approval = { discountApprovalThreshold: 50_000, discountApprovalPercent: 10 };

function kgLine(over: Partial<CartLineInput> = {}): CartLineInput {
  return {
    lineId: "l1",
    productId: "p1",
    sku: "GOAT-LEG",
    name: "Goat Leg",
    pricingMode: "PER_KG",
    unitPrice: 900_00,
    weightGrams: 1200,
    taxClass: "EXEMPT",
    ...over,
  };
}

describe("the rate that gets charged", () => {
  it("uses the catalogue rate when the cashier typed none", () => {
    const line = kgLine();
    expect(effectiveUnitPrice(line)).toBe(900_00);
    expect(lineGross(line)).toBe(1_080_00); // 900.00 x 1.200
    expect(priceOverrideGap(line)).toBe(0);
  });

  it("charges the typed rate instead of the catalogue's", () => {
    const line = kgLine({ unitPriceOverride: 750_00 });
    expect(effectiveUnitPrice(line)).toBe(750_00);
    expect(lineGross(line)).toBe(900_00); // 750.00 x 1.200
    // The board figure survives alongside it, which is what makes the gap
    // auditable rather than lost.
    expect(catalogueLineGross(line)).toBe(1_080_00);
    expect(priceOverrideGap(line)).toBe(-180_00);
  });

  it("charges a typed rate ABOVE the catalogue, and says so", () => {
    const line = kgLine({ unitPriceOverride: 1_000_00 });
    expect(lineGross(line)).toBe(1_200_00);
    expect(priceOverrideGap(line)).toBe(120_00);
  });

  it("keeps gram precision through a typed rate", () => {
    // 1,234.00/kg x 1.235 kg = 1,523.99 exactly, no float drift.
    const line = kgLine({ unitPriceOverride: 1_234_00, weightGrams: 1235 });
    expect(lineGross(line)).toBe(1_523_99);
  });

  it("rounds a typed rate half-up at the line, once", () => {
    // 333.33/kg x 0.335 kg = 111.66555 -> 111.67
    const line = kgLine({ unitPriceOverride: 333_33, weightGrams: 335 });
    expect(lineGross(line)).toBe(111_67);
  });

  it("applies a typed rate to pieces as well as weight", () => {
    const line = kgLine({
      sku: "CH-001",
      name: "Whole Chicken",
      pricingMode: "PER_PIECE",
      unitPrice: 489_00,
      unitPriceOverride: 520_00,
      weightGrams: undefined,
      quantity: 3,
      unitWeightGrams: 1400,
    });
    expect(lineGross(line)).toBe(1_560_00);
    expect(priceOverrideGap(line)).toBe(93_00); // 3 x 31.00 over the board
  });

  it("falls back to the catalogue rather than giving meat away on an empty field", () => {
    // The pad cannot submit a blank rate and the server's schema rejects a
    // zero one, but if either ever let one through, a free leg of goat is the
    // outcome to avoid.
    expect(effectiveUnitPrice(kgLine({ unitPriceOverride: 0 }))).toBe(900_00);
  });
});

describe("what a priced line reports", () => {
  it("marks the line and carries both rates", () => {
    const sale = priceSale([kgLine({ unitPriceOverride: 750_00 })], settings);
    const line = sale.lines[0]!;

    expect(line.unitPrice).toBe(750_00); // charged
    expect(line.catalogueUnitPrice).toBe(900_00); // board
    expect(line.priceOverridden).toBe(true);
    expect(line.priceOverride).toBe(-180_00);
  });

  it("leaves an untouched line unmarked", () => {
    const line = priceSale([kgLine()], settings).lines[0]!;
    expect(line.priceOverridden).toBe(false);
    expect(line.catalogueUnitPrice).toBe(line.unitPrice);
  });

  it("still extracts VAT from the rate actually charged", () => {
    const sale = priceSale(
      [kgLine({ taxClass: "STANDARD", unitPriceOverride: 116_00, weightGrams: 1000 })],
      settings,
    );
    // 116.00 inclusive of 16% -> 16.00 of tax, taken from the typed rate and
    // not from the board price nobody paid.
    expect(sale.lines[0]!.tax).toBe(16_00);
  });
});

describe("basket totals", () => {
  it("reports the catalogue basket alongside the charged one", () => {
    const sale = priceSale(
      [
        kgLine({ lineId: "a", unitPriceOverride: 750_00 }), // 180.00 under
        kgLine({ lineId: "b", unitPriceOverride: 1_000_00 }), // 120.00 over
      ],
      settings,
    );

    expect(sale.gross).toBe(900_00 + 1_200_00);
    expect(sale.catalogueGross).toBe(1_080_00 * 2);
    expect(sale.priceOverrideReduction).toBe(180_00);
    expect(sale.priceOverrideIncrease).toBe(120_00);
  });

  it("does not let an overcharge cancel out an undercharge", () => {
    // Netting these off would show a basket priced exactly at the board, and
    // the KSh 180 given away on the first line would stop being visible — in
    // the one report the owner has for spotting it.
    const sale = priceSale(
      [
        kgLine({ lineId: "a", unitPriceOverride: 750_00 }),
        kgLine({ lineId: "b", unitPriceOverride: 1_050_00 }),
      ],
      settings,
    );
    expect(sale.priceOverrideReduction).toBe(180_00);
    expect(sale.priceOverrideIncrease).toBe(180_00);
    expect(sale.catalogueGross).toBe(1_080_00 * 2);
  });

  it("keeps a discount separate from the rate it was taken off", () => {
    const sale = priceSale(
      [kgLine({ unitPriceOverride: 800_00, discount: { kind: "AMOUNT", value: 60_00 } })],
      settings,
    );
    // 100.00/kg under the board over 1.2 kg is 120.00 of counter pricing;
    // the 60.00 off is a discount and stays counted as one.
    expect(sale.priceOverrideReduction).toBe(120_00);
    expect(sale.discount).toBe(60_00);
    expect(sale.subtotal).toBe(960_00 - 60_00);
  });
});

describe("nothing about a typed rate needs approval", () => {
  /**
   * The gate is on discounts and nowhere else. These pin that down at the
   * rates most likely to make someone reach for a PIN prompt — half the board
   * price, and a third of it — because the moment one creeps back in, every
   * sale at this counter needs a manager.
   */
  it("asks nobody about a rate keyed far below the board", () => {
    const sale = priceSale([kgLine({ unitPriceOverride: 450_00 })], settings);
    expect(sale.priceOverrideReduction).toBe(540_00);
    expect(sale.discount).toBe(0);
    expect(reductionNeedsApproval(sale.discount, sale.gross, approval)).toBe(false);
  });

  it("asks nobody about a rate keyed far above the board", () => {
    const sale = priceSale([kgLine({ unitPriceOverride: 3_000_00 })], settings);
    expect(reductionNeedsApproval(sale.discount, sale.gross, approval)).toBe(false);
  });

  it("still stops a large DISCOUNT on a counter-priced line", () => {
    // The rate is the cashier's; taking a further KSh 500 off it is not.
    const sale = priceSale(
      [kgLine({ unitPriceOverride: 450_00, discount: { kind: "AMOUNT", value: 500_00 } })],
      settings,
    );
    expect(reductionNeedsApproval(sale.discount, sale.gross, approval)).toBe(true);
  });

  it("still waves through a small discount on a counter-priced line", () => {
    const sale = priceSale(
      [kgLine({ unitPriceOverride: 450_00, discount: { kind: "AMOUNT", value: 20_00 } })],
      settings,
    );
    expect(reductionNeedsApproval(sale.discount, sale.gross, approval)).toBe(false);
  });
});
