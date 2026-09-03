/**
 * Money. Every shilling figure in this system is an integer number of CENTS.
 *
 * There is exactly one rounding rule in Newmark POS and it lives here:
 * round-half-up, applied at the line-item level, then lines are summed. The
 * till, the receipt and every report call these functions so they cannot drift
 * apart. If you are rounding money anywhere else, you are creating a
 * discrepancy that will show up in the cash-up.
 */

/** Integer cents. 1 KSh = 100 cents. */
export type Cents = number;

export const CENTS_PER_SHILLING = 100;

export function assertCents(value: number, label = "amount"): Cents {
  if (!Number.isFinite(value)) throw new Error(`${label}: not a finite number`);
  if (!Number.isInteger(value)) {
    throw new Error(`${label}: money must be integer cents, got ${value}`);
  }
  return value;
}

/**
 * Round-half-up to the nearest whole cent. The single rounding primitive.
 *
 * Half-up is applied to the magnitude, so a refund line of -1.5 rounds to -2,
 * mirroring the sale line it reverses. Anything else leaves refunds failing to
 * cancel out the original sale by a cent.
 */
export function roundHalfUp(value: number): Cents {
  if (!Number.isFinite(value)) throw new Error("roundHalfUp: not a finite number");
  const sign = value < 0 ? -1 : 1;
  return sign * Math.floor(Math.abs(value) + 0.5);
}

/** Parse a cashier-typed shilling string ("1,250.50", "1250") into cents. */
export function shillingsToCents(input: string | number): Cents {
  const raw = typeof input === "number" ? String(input) : input.trim().replace(/,/g, "");
  if (raw === "" || raw === "-") throw new Error("shillingsToCents: empty amount");
  if (!/^-?\d*(\.\d*)?$/.test(raw)) throw new Error(`shillingsToCents: bad amount "${input}"`);
  const negative = raw.startsWith("-");
  const [whole = "0", frac = ""] = raw.replace("-", "").split(".");
  const base = Number(whole || "0") * CENTS_PER_SHILLING + Number((frac + "00").slice(0, 2));
  // A third decimal in a typed shilling amount is a typo, not gram precision.
  const bumpsUp = frac.length > 2 && Number(frac[2]) >= 5;
  const total = base + (bumpsUp ? 1 : 0);
  return negative ? -total : total;
}

export function centsToShillings(cents: Cents): number {
  assertCents(cents);
  return cents / CENTS_PER_SHILLING;
}

/** "1,250.50" — for the till display, receipts and reports. */
export function formatCents(cents: Cents, opts: { symbol?: boolean } = {}): string {
  assertCents(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / CENTS_PER_SHILLING);
  const frac = String(abs % CENTS_PER_SHILLING).padStart(2, "0");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${opts.symbol ? "KSh " : ""}${grouped}.${frac}`;
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce<Cents>((total, v) => total + assertCents(v), 0);
}

/**
 * Apply a percentage (VAT at 16, a discount at 5) to a cents amount, rounded
 * half-up so the result is still whole cents.
 */
export function percentOf(cents: Cents, percent: number): Cents {
  assertCents(cents);
  if (!Number.isFinite(percent)) throw new Error("percentOf: bad percent");
  return roundHalfUp((cents * percent) / 100);
}

/**
 * Extract the tax already contained in a VAT-inclusive amount.
 * Kenyan shelf prices are quoted inclusive, so this is the common direction.
 */
export function taxFromInclusive(inclusive: Cents, ratePercent: number): Cents {
  assertCents(inclusive);
  if (ratePercent === 0) return 0;
  return roundHalfUp((inclusive * ratePercent) / (100 + ratePercent));
}

/**
 * Optional cash rounding, e.g. to the nearest 5 shillings. Returns the
 * ADJUSTMENT to add to the total; the receipt shows it as its own line so the
 * customer can see why the figure moved. `step` is in cents; 0 disables it.
 */
export function cashRoundingAdjustment(total: Cents, step: Cents): Cents {
  assertCents(total);
  assertCents(step, "step");
  if (step <= 0) return 0;
  const rounded = Math.round(total / step) * step;
  return rounded - total;
}

/**
 * Split an amount across parts without losing or inventing a cent. Used to
 * prorate a whole-sale discount back onto lines for reporting, and to split a
 * shared line between payers.
 */
export function allocate(total: Cents, weights: readonly number[]): Cents[] {
  assertCents(total);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) throw new Error("allocate: weights must sum above zero");
  const parts = weights.map((w) => Math.floor((total * w) / totalWeight));
  let remainder = total - parts.reduce((a, b) => a + b, 0);
  // Hand the leftover cents out one at a time, largest weight first.
  const order = weights
    .map((w, i) => ({ w, i }))
    .sort((a, b) => b.w - a.w)
    .map((x) => x.i);
  let cursor = 0;
  while (remainder > 0 && order.length > 0) {
    const idx = order[cursor % order.length]!;
    parts[idx] = parts[idx]! + 1;
    remainder -= 1;
    cursor += 1;
  }
  return parts;
}
