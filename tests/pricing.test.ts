import { describe, expect, it } from "vitest";
import {
  applyPayments,
  priceSale,
  remainingBalance,
  type CartLineInput,
  type PricingSettings,
} from "@/lib/pricing";
import { sumCents } from "@/lib/money";

const settings: PricingSettings = { standardVatRatePercent: 16, cashRoundingStep: 0 };

function kgLine(over: Partial<CartLineInput> = {}): CartLineInput {
  return {
    lineId: "l1",
    productId: "p1",
    sku: "BEEF-BONELESS-CUBES",
    name: "Boneless Beef Cubes",
    pricingMode: "PER_KG",
    unitPrice: 820_00,
    weightGrams: 1235,
    taxClass: "EXEMPT",
    ...over,
  };
}

describe("priceSale — pricing modes", () => {
  it("prices a per-kg line from weight", () => {
    const sale = priceSale([kgLine()], settings);
    expect(sale.lines[0]!.gross).toBe(1_012_70); // 820.00 x 1.235
    expect(sale.total).toBe(1_012_70);
    expect(sale.totalWeightGrams).toBe(1235);
  });

  it("prices a per-piece line from a count and still moves stock in kg", () => {
    const sale = priceSale(
      [
        kgLine({
          sku: "CH-001",
          name: "Whole Chicken",
          pricingMode: "PER_PIECE",
          unitPrice: 750_00,
          weightGrams: undefined,
          quantity: 2,
          unitWeightGrams: 1400,
        }),
      ],
      settings,
    );
    expect(sale.lines[0]!.gross).toBe(1_500_00);
    expect(sale.lines[0]!.stockGrams).toBe(2800);
  });

  it("prices a fixed pack at its pack price, not by weight", () => {
    const sale = priceSale(
      [
        kgLine({
          sku: "BF-003",
          name: "Newmark Prime Combo 1.5kg",
          pricingMode: "FIXED_PACK",
          unitPrice: 975_00,
          weightGrams: undefined,
          quantity: 1,
          unitWeightGrams: 1500,
        }),
      ],
      settings,
    );
    expect(sale.lines[0]!.gross).toBe(975_00);
    expect(sale.lines[0]!.stockGrams).toBe(1500);
  });

  it("refuses a per-kg line with no weight rather than charging zero", () => {
    expect(() => priceSale([kgLine({ weightGrams: undefined })], settings)).toThrow(/needs a weight/);
  });

  it("refuses a per-piece line with a fractional count", () => {
    expect(() =>
      priceSale([kgLine({ pricingMode: "PER_PIECE", weightGrams: undefined, quantity: 1.5 })], settings),
    ).toThrow(/whole quantity/);
  });
});

describe("priceSale — a real counter basket", () => {
  const basket: CartLineInput[] = [
    kgLine({ lineId: "a", weightGrams: 1235 }), // 1,012.70
    kgLine({
      lineId: "b",
      sku: "BEEF-T-BONE-STEAK",
      name: "T-Bone Steak",
      unitPrice: 1_620_00,
      weightGrams: 880,
    }), // 1,425.60
    kgLine({
      lineId: "c",
      sku: "BEEF-SOUP-BONES",
      name: "Soup Bones",
      unitPrice: 150_00,
      weightGrams: 2050,
    }), // 307.50
  ];

  it("sums the lines", () => {
    const sale = priceSale(basket, settings);
    expect(sale.lines.map((l) => l.gross)).toEqual([1_012_70, 1_425_60, 307_50]);
    expect(sale.total).toBe(2_745_80);
    expect(sale.totalWeightGrams).toBe(4165);
  });

  it("sums line totals rather than pricing the aggregate weight", () => {
    const sale = priceSale(basket, settings);
    expect(sale.subtotal).toBe(sumCents(sale.lines.map((l) => l.net)));
  });
});

describe("priceSale — discounts", () => {
  it("takes a percentage off one line", () => {
    const sale = priceSale([kgLine({ discount: { kind: "PERCENT", value: 10 } })], settings);
    expect(sale.lines[0]!.discount).toBe(101_27); // 10% of 1,012.70
    expect(sale.total).toBe(911_43);
  });

  it("never lets a discount turn a line into a payout", () => {
    const sale = priceSale([kgLine({ discount: { kind: "AMOUNT", value: 999_999_00 } })], settings);
    expect(sale.lines[0]!.net).toBe(0);
    expect(sale.total).toBe(0);
  });

  it("prorates a whole-sale discount across lines so VAT stays honest", () => {
    const sale = priceSale(
      [kgLine({ lineId: "a" }), kgLine({ lineId: "b", unitPrice: 1_620_00, weightGrams: 880 })],
      settings,
      { kind: "PERCENT", value: 10 },
    );
    const shares = sumCents(sale.lines.map((l) => l.discount));
    expect(shares).toBe(sale.discount);
    expect(sale.subtotal).toBe(sale.gross - sale.discount);
    expect(sumCents(sale.lines.map((l) => l.net))).toBe(sale.subtotal);
  });
});

describe("priceSale — VAT", () => {
  it("never applies one rate across the catalogue", () => {
    const sale = priceSale(
      [
        kgLine({ lineId: "a", taxClass: "EXEMPT" }),
        kgLine({ lineId: "b", taxClass: "ZERO_RATED" }),
        kgLine({ lineId: "c", taxClass: "STANDARD" }),
      ],
      settings,
    );
    expect(sale.lines[0]!.tax).toBe(0);
    expect(sale.lines[1]!.tax).toBe(0);
    expect(sale.lines[2]!.tax).toBeGreaterThan(0);
  });

  it("treats prices as VAT-inclusive", () => {
    const sale = priceSale([kgLine({ taxClass: "STANDARD", unitPrice: 116_00, weightGrams: 1000 })], settings);
    expect(sale.total).toBe(116_00);
    expect(sale.tax).toBe(16_00);
  });

  it("buckets tax by treatment for the eTIMS invoice", () => {
    const sale = priceSale(
      [kgLine({ lineId: "a", taxClass: "EXEMPT" }), kgLine({ lineId: "b", taxClass: "STANDARD" })],
      settings,
    );
    expect(sale.taxBuckets).toHaveLength(2);
    expect(sale.taxBuckets.map((b) => b.taxClass)).toEqual(["STANDARD", "EXEMPT"]);
    expect(sumCents(sale.taxBuckets.map((b) => b.net))).toBe(sale.subtotal);
  });

  it("follows the configured rate rather than a constant", () => {
    const line = kgLine({ taxClass: "STANDARD", unitPrice: 100_00, weightGrams: 1000 });
    const at16 = priceSale([line], { ...settings, standardVatRatePercent: 16 });
    const at8 = priceSale([line], { ...settings, standardVatRatePercent: 8 });
    expect(at16.tax).not.toBe(at8.tax);
    expect(at16.total).toBe(at8.total); // inclusive pricing: the customer pays the same
  });
});

describe("priceSale — cash rounding", () => {
  it("shows the adjustment as its own figure", () => {
    const sale = priceSale([kgLine({ unitPrice: 820_00, weightGrams: 1235 })], {
      ...settings,
      cashRoundingStep: 5_00,
    });
    expect(sale.subtotal).toBe(1_012_70);
    expect(sale.roundingAdjustment).toBe(2_30); // 1,012.70 -> 1,015.00
    expect(sale.total).toBe(1_015_00);
  });
});

describe("applyPayments", () => {
  const sale = priceSale([kgLine()], settings); // total 1,012.70

  it("gives change on cash", () => {
    const paid = applyPayments(sale, [{ method: "CASH", amount: 2_000_00 }]);
    expect(paid.changeDue).toBe(987_30);
    expect(paid.balanceDue).toBe(0);
    expect(paid.settled).toBe(true);
  });

  it("settles a split of cash and M-Pesa", () => {
    const paid = applyPayments(sale, [
      { method: "MPESA", amount: 500_00, reference: "SJH4K2L9XZ" },
      { method: "CASH", amount: 512_70 },
    ]);
    expect(paid.settled).toBe(true);
    expect(paid.changeDue).toBe(0);
  });

  it("reports a short payment instead of completing the sale", () => {
    const paid = applyPayments(sale, [{ method: "CASH", amount: 500_00 }]);
    expect(paid.balanceDue).toBe(512_70);
    expect(paid.settled).toBe(false);
  });

  it("refuses to give change out of the drawer on an M-Pesa overpayment", () => {
    expect(() => applyPayments(sale, [{ method: "MPESA", amount: 2_000_00 }])).toThrow(/non-cash/i);
  });

  it("allows cash to overpay alongside an exact M-Pesa leg", () => {
    const paid = applyPayments(sale, [
      { method: "MPESA", amount: 1_000_00 },
      { method: "CASH", amount: 50_00 },
    ]);
    expect(paid.changeDue).toBe(37_30);
    expect(paid.settled).toBe(true);
  });

  it("rejects a zero or negative tender", () => {
    expect(() => applyPayments(sale, [{ method: "CASH", amount: 0 }])).toThrow();
  });
});

describe("remainingBalance", () => {
  it("drives the running balance on the payment pad", () => {
    expect(remainingBalance(1_012_70, [])).toBe(1_012_70);
    expect(remainingBalance(1_012_70, [{ method: "MPESA", amount: 500_00 }])).toBe(512_70);
    expect(remainingBalance(1_012_70, [{ method: "CASH", amount: 2_000_00 }])).toBe(0);
  });
});
