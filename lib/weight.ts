/**
 * Weight. Stored to 3 decimal places — gram precision — everywhere.
 *
 * Internally weight is an integer number of GRAMS. That keeps the same
 * "no floats for quantities that must reconcile" discipline as lib/money.ts:
 * a scale reading of 1.235 kg is 1235, not 1.2349999999999999.
 *
 * Never round a weight to 2 dp. 10 g of fillet at KSh 1,800/kg is KSh 18 —
 * losing it on every line is how a butchery quietly bleeds margin.
 */

import { assertCents, roundHalfUp, type Cents } from "./money";

/** Integer grams. 1 kg = 1000 g. */
export type Grams = number;

export const GRAMS_PER_KG = 1000;

/** The scale and the catalogue both work to gram precision. */
export const WEIGHT_DECIMALS = 3;

export function assertGrams(value: number, label = "weight"): Grams {
  if (!Number.isFinite(value)) throw new Error(`${label}: not a finite number`);
  if (!Number.isInteger(value)) {
    throw new Error(`${label}: weight must be integer grams, got ${value}`);
  }
  return value;
}

/** Parse a typed or scale-reported kilogram value ("1.235") into grams. */
export function kgToGrams(input: string | number): Grams {
  const raw = typeof input === "number" ? String(input) : input.trim().replace(/,/g, "");
  if (raw === "" || raw === "-") throw new Error("kgToGrams: empty weight");
  if (!/^-?\d*(\.\d*)?$/.test(raw)) throw new Error(`kgToGrams: bad weight "${input}"`);
  // Round rather than truncate: a scale that reports 1.2356 kg is 1236 g.
  return roundHalfUp(Number(raw) * GRAMS_PER_KG);
}

export function gramsToKg(grams: Grams): number {
  assertGrams(grams);
  return grams / GRAMS_PER_KG;
}

/** "1.235" — always three decimals, so receipts line up in a fixed-width font. */
export function formatKg(grams: Grams, opts: { unit?: boolean } = {}): string {
  assertGrams(grams);
  const negative = grams < 0;
  const abs = Math.abs(grams);
  const whole = Math.floor(abs / GRAMS_PER_KG);
  const frac = String(abs % GRAMS_PER_KG).padStart(WEIGHT_DECIMALS, "0");
  return `${negative ? "-" : ""}${whole}.${frac}${opts.unit ? " kg" : ""}`;
}

export function sumGrams(values: readonly Grams[]): Grams {
  return values.reduce<Grams>((total, v) => total + assertGrams(v), 0);
}

/**
 * The core per-kilogram line calculation: price/kg x weight.
 * Rounded half-up once, here, at the line level.
 */
export function weightLineTotal(pricePerKg: Cents, grams: Grams): Cents {
  assertCents(pricePerKg, "pricePerKg");
  assertGrams(grams);
  return roundHalfUp((pricePerKg * grams) / GRAMS_PER_KG);
}

/**
 * Back-calculate weight from a shilling amount.
 *
 * A customer asking for "meat worth 500 bob" is a primary flow at the Newmark
 * counter, not an edge case. The cashier types 500, the scale target comes
 * back in grams, they cut to it and the line is then priced from the ACTUAL
 * weight — so the amount is a target, never the stored quantity.
 */
export function weightForAmount(pricePerKg: Cents, amount: Cents): Grams {
  assertCents(pricePerKg, "pricePerKg");
  assertCents(amount, "amount");
  if (pricePerKg <= 0) throw new Error("weightForAmount: price per kg must be above zero");
  return roundHalfUp((amount * GRAMS_PER_KG) / pricePerKg);
}

/**
 * Tare: net = gross - container. Returned as grams, never negative — a tare
 * heavier than the gross means the cashier weighed the tub without the meat.
 */
export function netWeight(gross: Grams, tare: Grams): Grams {
  assertGrams(gross, "gross");
  assertGrams(tare, "tare");
  const net = gross - tare;
  if (net < 0) throw new Error("netWeight: tare is heavier than the gross weight");
  return net;
}

/**
 * Yield percentage of a carcass breakdown output against its input weight,
 * to one decimal place. Yields never sum to 100 — the balance is shrinkage.
 */
export function yieldPercent(outputGrams: Grams, inputGrams: Grams): number {
  assertGrams(outputGrams, "output");
  assertGrams(inputGrams, "input");
  if (inputGrams <= 0) throw new Error("yieldPercent: input weight must be above zero");
  return Math.round((outputGrams / inputGrams) * 1000) / 10;
}
