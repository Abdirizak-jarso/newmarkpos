import { roundHalfUp, type Cents } from "./money";
import type { Grams } from "./weight";

/**
 * What the meat cost — the pure half.
 *
 * A butchery's margin is not knowable from its price list. A leg of goat costs
 * what the carcass cost, divided across the cuts by weight, with the trim loss
 * loaded onto whatever survived — which is why shrinkage makes every recovered
 * cut dearer instead of vanishing. `lib/breakdown.ts` does that allocation; this
 * file is what keeps the answer once the cuts go into the case and get sold.
 *
 * Two rules, both here so there is one place to argue with:
 *
 *   Cost blends, it does not jump. Twenty kilos on hand at 600/kg and two kilos
 *   arriving at 900/kg is not a 900/kg product; it is 627/kg. Overwriting on
 *   each delivery makes the margin lurch with the last invoice and reports a
 *   number that was never true.
 *
 *   Cost is stamped, not looked up. A sale line records what the meat cost on
 *   the day it left the shop. Reading today's cost back over last month's sales
 *   reprices history every time a delivery arrives, and a margin that changes
 *   after the fact is not a margin.
 */

/**
 * The new average cost per kg after `incomingGrams` arrives at `incomingCostPerKg`.
 *
 * Stock at or below zero has no cost basis to blend against — the shop has sold
 * meat it had not booked in, and the honest answer is that the arriving cost is
 * now the cost. Averaging against a negative balance produces nonsense, and it
 * produces it silently.
 */
export function blendCost(
  onHandGrams: Grams,
  currentCostPerKg: Cents,
  incomingGrams: Grams,
  incomingCostPerKg: Cents,
): Cents {
  if (incomingGrams <= 0) return currentCostPerKg;
  if (incomingCostPerKg < 0) throw new Error("blendCost: cost cannot be negative");
  if (onHandGrams <= 0 || currentCostPerKg <= 0) return incomingCostPerKg;

  const heldValue = onHandGrams * currentCostPerKg;
  const arrivingValue = incomingGrams * incomingCostPerKg;
  return roundHalfUp((heldValue + arrivingValue) / (onHandGrams + incomingGrams));
}

/** What a given weight of a product cost, at a given cost per kg. */
export function costOfWeight(costPerKg: Cents, grams: Grams): Cents {
  if (costPerKg <= 0 || grams <= 0) return 0;
  return roundHalfUp((costPerKg * grams) / 1000);
}

export interface Margin {
  revenue: Cents;
  cost: Cents;
  /** revenue - cost. Negative means the shop sold it for less than it paid. */
  profit: Cents;
  /** Profit as a percentage of revenue, to one decimal place. */
  percent: number;
}

/**
 * Margin on revenue, not on cost — it is the figure a shopkeeper quotes and the
 * one that compares across products.
 *
 * Revenue of zero has no margin to report rather than an infinite one; a line
 * given away entirely is a loss of its whole cost, and says so.
 */
export function margin(revenue: Cents, cost: Cents): Margin {
  const profit = revenue - cost;
  const percent = revenue === 0 ? 0 : Math.round((profit / revenue) * 1000) / 10;
  return { revenue, cost, profit, percent };
}

/** Sum a set of margins into one. */
export function totalMargin(parts: readonly { revenue: Cents; cost: Cents }[]): Margin {
  const revenue = parts.reduce((total, part) => total + part.revenue, 0);
  const cost = parts.reduce((total, part) => total + part.cost, 0);
  return margin(revenue, cost);
}
