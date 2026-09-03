/**
 * The pricing engine. One place computes a sale, and the till, the receipt,
 * the API and every report all call it — so what the customer is charged, what
 * the receipt prints and what the Z-report totals can never disagree.
 *
 * Pure functions only: no database, no clock, no I/O. That is what makes the
 * arithmetic testable and what lets the till price a basket with no network.
 */

import {
  allocate,
  assertCents,
  cashRoundingAdjustment,
  percentOf,
  roundHalfUp,
  sumCents,
  taxFromInclusive,
  type Cents,
} from "./money";
import { assertGrams, weightLineTotal, type Grams } from "./weight";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * All three modes must be handled everywhere a line item is processed.
 * PER_KG      — priced by weight, the default for the counter.
 * PER_PIECE   — a whole chicken, an egg tray: sold by count, still stocked in kg.
 * FIXED_PACK  — a pre-made pack (the 1.5 kg Prime Combo): fixed price, fixed weight.
 */
export type PricingMode = "PER_KG" | "PER_PIECE" | "FIXED_PACK";

/**
 * VAT treatment is per product, never a single hard-coded rate. The rate for
 * STANDARD comes from settings; the correct treatment per meat category is the
 * owner's accountant's call.
 */
export type TaxClass = "EXEMPT" | "ZERO_RATED" | "STANDARD";

export type DiscountKind = "PERCENT" | "AMOUNT";

export interface Discount {
  kind: DiscountKind;
  /** Percent points for PERCENT (5 = 5%), integer cents for AMOUNT. */
  value: number;
  reason?: string;
}

export interface CartLineInput {
  /** Stable key for the line within the sale — not the product id, lines repeat. */
  lineId: string;
  productId: string;
  sku: string;
  name: string;
  pricingMode: PricingMode;
  /**
   * The CATALOGUE rate, in cents per kg (PER_KG), per piece (PER_PIECE) or per
   * pack (FIXED_PACK). Always the figure from the database, never the client's.
   */
  unitPrice: Cents;
  /**
   * A rate typed at the counter, in the same units as `unitPrice`.
   *
   * The till shows no prices on the product grid: the cashier types the rate
   * and the weight for every line. When this is set it REPLACES the catalogue
   * rate for the arithmetic — it is not a discount, and it may be above the
   * catalogue figure as well as below.
   *
   * The catalogue rate is still carried through pricing, because it is what
   * makes a typed rate auditable after the fact: `priceOverride` on the
   * resulting line is the gap between the two, and it is what the audit log
   * and every margin report read. Nothing about a typed rate is blocked — the
   * counter prices its own meat — but nothing about it is invisible either.
   */
  unitPriceOverride?: Cents;
  /** Grams for PER_KG. Ignored for the other modes. */
  weightGrams?: Grams;
  /** Whole pieces or packs. Ignored for PER_KG. */
  quantity?: number;
  /** Grams of stock one pack/piece consumes. Required to deduct stock correctly. */
  unitWeightGrams?: Grams;
  taxClass: TaxClass;
  discount?: Discount;
  /** Set when the cashier typed a shilling target and cut to it. Display only. */
  requestedAmount?: Cents;
  notes?: string;
}

export interface CartLine {
  lineId: string;
  productId: string;
  sku: string;
  name: string;
  pricingMode: PricingMode;
  /** The rate actually charged — the typed one when there is one. */
  unitPrice: Cents;
  /** The rate the catalogue holds, kept whether or not it was the one charged. */
  catalogueUnitPrice: Cents;
  /** True when the cashier typed the rate rather than taking the catalogue's. */
  priceOverridden: boolean;
  /**
   * Charged gross minus catalogue gross. Negative means the line was sold
   * below the board. Recorded, never blocked — this is the figure the audit
   * record is built on.
   */
  priceOverride: Cents;
  weightGrams: Grams;
  quantity: number;
  /** Price x quantity, before any discount. Rounded half-up at the line. */
  gross: Cents;
  discount: Cents;
  /** gross - discount. What this line contributes to the subtotal. */
  net: Cents;
  taxClass: TaxClass;
  taxRatePercent: number;
  /** VAT contained within `net` — prices are quoted VAT-inclusive. */
  tax: Cents;
  /** Grams this line removes from stock. */
  stockGrams: Grams;
  requestedAmount?: Cents;
  notes?: string;
}

export type TenderMethod = "CASH" | "MPESA" | "CARD" | "ACCOUNT" | "VOUCHER";

export interface Tender {
  method: TenderMethod;
  amount: Cents;
  /** M-Pesa code, card auth code, account name. Required for M-Pesa. */
  reference?: string;
  /** When an M-Pesa payment went through, per the customer's message. */
  transactedAt?: string;
}

export interface PricingSettings {
  /** Rate applied to STANDARD-rated products. Configurable, never assumed. */
  standardVatRatePercent: number;
  /** Cash rounding step in cents. 500 = nearest 5 shillings. 0 disables. */
  cashRoundingStep: Cents;
}

export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  // Seeded from the Kenyan standard rate at the time of writing. It is a
  // setting because it changes and because most fresh meat is not standard-rated.
  standardVatRatePercent: 16,
  cashRoundingStep: 0,
};

export interface TaxBucket {
  taxClass: TaxClass;
  ratePercent: number;
  /** Sum of net line amounts in this bucket (VAT-inclusive). */
  net: Cents;
  tax: Cents;
}

export interface SaleTotals {
  lines: CartLine[];
  /** Sum of line gross at the rates charged, before any discount. */
  gross: Cents;
  /** What the same basket would have come to at catalogue rates. */
  catalogueGross: Cents;
  /** Total charged BELOW the catalogue by a typed rate. Never negative. */
  priceOverrideReduction: Cents;
  /** Total charged ABOVE the catalogue by a typed rate. Never negative. */
  priceOverrideIncrease: Cents;
  /** Line-level discounts plus the whole-sale discount. */
  discount: Cents;
  /** gross - discount. */
  subtotal: Cents;
  /** Cash rounding, shown to the customer as its own line. */
  roundingAdjustment: Cents;
  /** What the customer pays. */
  total: Cents;
  /** VAT contained in the total, broken down by treatment. */
  tax: Cents;
  taxBuckets: TaxBucket[];
  totalWeightGrams: Grams;
  itemCount: number;
}

export interface PaymentSummary extends SaleTotals {
  tendered: Cents;
  /** Still owed. Above zero means the sale cannot be completed. */
  balanceDue: Cents;
  /** Change owed to the customer. Only cash can produce change. */
  changeDue: Cents;
  settled: boolean;
}

// ---------------------------------------------------------------------------
// Line pricing
// ---------------------------------------------------------------------------

export function taxRateFor(taxClass: TaxClass, settings: PricingSettings): number {
  switch (taxClass) {
    case "STANDARD":
      return settings.standardVatRatePercent;
    case "ZERO_RATED":
    case "EXEMPT":
      return 0;
  }
}

/**
 * The rate this line is actually charged at: the one the cashier typed at the
 * counter, or the catalogue's when they did not type one.
 *
 * A typed rate of zero is not a free line, it is an empty field — the pad
 * cannot submit one and the server's schema rejects one, so the catalogue rate
 * standing in here is the safe reading rather than a giveaway.
 */
export function effectiveUnitPrice(input: CartLineInput): Cents {
  const override = input.unitPriceOverride;
  if (override === undefined || override <= 0) return input.unitPrice;
  return assertCents(override, "unitPriceOverride");
}

/** Price x quantity for the line's mode, rounded half-up exactly once. */
export function lineGross(input: CartLineInput): Cents {
  const unitPrice = effectiveUnitPrice(input);
  assertCents(unitPrice, "unitPrice");
  if (unitPrice < 0) throw new Error("lineGross: unit price cannot be negative");

  switch (input.pricingMode) {
    case "PER_KG": {
      const grams = assertGrams(input.weightGrams ?? 0, "weightGrams");
      if (grams <= 0) throw new Error(`lineGross: ${input.sku} is priced per kg and needs a weight`);
      return weightLineTotal(unitPrice, grams);
    }
    case "PER_PIECE":
    case "FIXED_PACK": {
      const qty = input.quantity ?? 0;
      if (!Number.isInteger(qty) || qty <= 0) {
        throw new Error(`lineGross: ${input.sku} needs a whole quantity above zero`);
      }
      return roundHalfUp(unitPrice * qty);
    }
  }
}

/** What the line would have come to at the catalogue rate, whatever was typed. */
export function catalogueLineGross(input: CartLineInput): Cents {
  return lineGross({ ...input, unitPriceOverride: undefined });
}

/**
 * Charged gross minus catalogue gross for one line.
 *
 * Negative means the shop took less than its board price. Neither direction is
 * blocked — this is the figure that makes a counter-set price *reviewable*,
 * which is a different job from stopping it: it is what the audit log records
 * and what tells the owner, at the end of a week, which cuts are going out of
 * the door under the board and who is selling them that way.
 */
export function priceOverrideGap(input: CartLineInput): Cents {
  if (input.unitPriceOverride === undefined) return 0;
  return lineGross(input) - catalogueLineGross(input);
}

/** Grams of stock the line consumes, whichever mode it is priced in. */
export function lineStockGrams(input: CartLineInput): Grams {
  switch (input.pricingMode) {
    case "PER_KG":
      return assertGrams(input.weightGrams ?? 0, "weightGrams");
    case "PER_PIECE":
    case "FIXED_PACK": {
      const qty = input.quantity ?? 0;
      // A piece with no recorded unit weight cannot move stock. That is a
      // catalogue gap to fix, not a reason to guess a weight here.
      const unit = input.unitWeightGrams ?? 0;
      return assertGrams(unit, "unitWeightGrams") * qty;
    }
  }
}

export function lineDiscountAmount(gross: Cents, discount: Discount | undefined): Cents {
  if (!discount) return 0;
  const amount =
    discount.kind === "PERCENT" ? percentOf(gross, discount.value) : assertCents(discount.value);
  if (amount < 0) throw new Error("lineDiscountAmount: discount cannot be negative");
  // Never let a discount turn a line into a payout.
  return Math.min(amount, gross);
}

export function priceLine(input: CartLineInput, settings: PricingSettings): CartLine {
  const unitPrice = effectiveUnitPrice(input);
  const gross = lineGross(input);
  const discount = lineDiscountAmount(gross, input.discount);
  const net = gross - discount;
  const ratePercent = taxRateFor(input.taxClass, settings);

  return {
    lineId: input.lineId,
    productId: input.productId,
    sku: input.sku,
    name: input.name,
    pricingMode: input.pricingMode,
    // The rate charged, so the receipt, the refund and every report all read
    // the figure the customer actually paid rather than a board price nobody
    // quoted them.
    unitPrice,
    catalogueUnitPrice: input.unitPrice,
    priceOverridden: unitPrice !== input.unitPrice,
    priceOverride: gross - catalogueLineGross(input),
    weightGrams: input.weightGrams ?? 0,
    quantity: input.pricingMode === "PER_KG" ? 1 : (input.quantity ?? 0),
    gross,
    discount,
    net,
    taxClass: input.taxClass,
    taxRatePercent: ratePercent,
    tax: taxFromInclusive(net, ratePercent),
    stockGrams: lineStockGrams(input),
    requestedAmount: input.requestedAmount,
    notes: input.notes,
  };
}

// ---------------------------------------------------------------------------
// Sale totals
// ---------------------------------------------------------------------------

/**
 * Price a whole basket.
 *
 * A whole-sale discount is prorated back across lines by net value so the VAT
 * breakdown stays honest — you cannot take 10% off the basket and still report
 * the original tax on a standard-rated line.
 */
export function priceSale(
  inputs: readonly CartLineInput[],
  settings: PricingSettings = DEFAULT_PRICING_SETTINGS,
  saleDiscount?: Discount,
): SaleTotals {
  let lines = inputs.map((input) => priceLine(input, settings));

  const gross = sumCents(lines.map((l) => l.gross));
  // Kept directional rather than netted off: a basket with one cut sold KSh 300
  // under the board and another KSh 300 over is not the same thing as a basket
  // priced at the board, and a report that let the two cancel would say it was.
  const priceOverrideReduction = sumCents(
    lines.map((l) => (l.priceOverride < 0 ? -l.priceOverride : 0)),
  );
  const priceOverrideIncrease = sumCents(lines.map((l) => Math.max(0, l.priceOverride)));
  const catalogueGross = gross + priceOverrideReduction - priceOverrideIncrease;
  const lineDiscounts = sumCents(lines.map((l) => l.discount));
  const afterLineDiscounts = gross - lineDiscounts;

  let saleDiscountAmount = 0;
  if (saleDiscount && afterLineDiscounts > 0) {
    saleDiscountAmount = lineDiscountAmount(afterLineDiscounts, saleDiscount);
    const shares = allocate(
      saleDiscountAmount,
      lines.map((l) => l.net),
    );
    lines = lines.map((line, i) => {
      const share = shares[i] ?? 0;
      const net = line.net - share;
      return {
        ...line,
        discount: line.discount + share,
        net,
        tax: taxFromInclusive(net, line.taxRatePercent),
      };
    });
  }

  const subtotal = sumCents(lines.map((l) => l.net));
  const roundingAdjustment = cashRoundingAdjustment(subtotal, settings.cashRoundingStep);
  const total = subtotal + roundingAdjustment;

  return {
    lines,
    gross,
    catalogueGross,
    priceOverrideReduction,
    priceOverrideIncrease,
    discount: lineDiscounts + saleDiscountAmount,
    subtotal,
    roundingAdjustment,
    total,
    tax: sumCents(lines.map((l) => l.tax)),
    taxBuckets: buildTaxBuckets(lines),
    totalWeightGrams: lines.reduce((t, l) => t + l.stockGrams, 0),
    itemCount: lines.length,
  };
}

function buildTaxBuckets(lines: readonly CartLine[]): TaxBucket[] {
  const byKey = new Map<string, TaxBucket>();
  for (const line of lines) {
    const key = `${line.taxClass}:${line.taxRatePercent}`;
    const bucket = byKey.get(key) ?? {
      taxClass: line.taxClass,
      ratePercent: line.taxRatePercent,
      net: 0,
      tax: 0,
    };
    bucket.net += line.net;
    bucket.tax += line.tax;
    byKey.set(key, bucket);
  }
  return [...byKey.values()].sort((a, b) => b.ratePercent - a.ratePercent);
}

/**
 * Is this DISCOUNT the cashier's to make, or an admin's?
 *
 * Only discounts. The rate a cashier types on the entry pad is not gated at
 * all: the counter sets its own prices, so asking permission for the ordinary
 * act of pricing a cut would put a manager's PIN in front of every sale. Typed
 * rates are still recorded against the board rate on the line and written to
 * the audit log — visible after the fact rather than blocked before it.
 *
 * Pure, and deliberately so: the till asks this while the manager is still
 * standing at the counter, and the server asks it again before it banks
 * anything. One implementation, so the answer cannot differ.
 */
export function reductionNeedsApproval(
  reduction: Cents,
  gross: Cents,
  settings: { discountApprovalThreshold: number; discountApprovalPercent: number },
): boolean {
  if (reduction <= 0) return false;
  if (reduction >= settings.discountApprovalThreshold) return true;
  if (gross <= 0) return false;
  return (reduction / gross) * 100 >= settings.discountApprovalPercent;
}

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

/**
 * Apply tenders to a priced sale. Split payments are normal here — part cash,
 * part M-Pesa is the most common basket over KSh 2,000.
 *
 * Only cash can produce change. Overpaying by M-Pesa or card is a data-entry
 * error, not a cash-drawer event, so it is rejected rather than silently
 * turned into change out of the drawer.
 */
export function applyPayments(totals: SaleTotals, tenders: readonly Tender[]): PaymentSummary {
  for (const tender of tenders) {
    assertCents(tender.amount, `${tender.method} amount`);
    if (tender.amount <= 0) throw new Error(`applyPayments: ${tender.method} amount must be above zero`);
  }

  const tendered = sumCents(tenders.map((t) => t.amount));
  const nonCash = sumCents(tenders.filter((t) => t.method !== "CASH").map((t) => t.amount));
  if (nonCash > totals.total) {
    throw new Error("applyPayments: non-cash tenders exceed the sale total — no change can be given on them");
  }

  const balanceDue = Math.max(0, totals.total - tendered);
  const changeDue = Math.max(0, tendered - totals.total);

  return { ...totals, tendered, balanceDue, changeDue, settled: balanceDue === 0 };
}

/**
 * What is still owed after the tenders taken so far — drives the "balance"
 * figure on the till's payment pad as each split is entered.
 */
export function remainingBalance(total: Cents, tenders: readonly Tender[]): Cents {
  return Math.max(0, total - sumCents(tenders.map((t) => t.amount)));
}
