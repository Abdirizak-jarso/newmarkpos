/**
 * Carcass breakdown.
 *
 * A whole carcass comes in at one weight and leaves as many products at a
 * lower total weight. The difference is real — trim, bone dust, drip, fat
 * pulled off — and it must be RECORDED, not silently absorbed. A breakdown
 * that always balanced to zero would mean nobody is measuring the loss, and
 * loss is where a butchery's margin actually goes.
 *
 * By-products (Soup Bones, Meaty Bones, Cat Food) enter stock here, from
 * breakdown, never from a purchase order.
 */

import { allocate, assertCents, sumCents, type Cents } from "./money";
import { assertGrams, gramsToKg, sumGrams, yieldPercent, type Grams } from "./weight";

export interface BreakdownOutputInput {
  productId: string;
  sku: string;
  name: string;
  weightGrams: Grams;
  /** Marks Soup Bones / Meaty Bones / Cat Food and friends in reporting. */
  isByProduct?: boolean;
}

export interface BreakdownInput {
  /** The product being broken down, e.g. BEEF-WHOLE-CARCASS. */
  sourceProductId: string;
  sourceSku: string;
  inputWeightGrams: Grams;
  /** What the carcass cost, in cents. Used to cost the outputs. */
  inputCost: Cents;
  outputs: readonly BreakdownOutputInput[];
}

export interface BreakdownOutput extends BreakdownOutputInput {
  isByProduct: boolean;
  /** Share of the input weight this output represents, to one decimal place. */
  yieldPercent: number;
  /** Share of the input cost carried by this output, in cents. */
  costAllocated: Cents;
  /** Effective cost per kg of this output once loss is absorbed. */
  costPerKg: Cents;
}

export interface BreakdownResult {
  sourceProductId: string;
  sourceSku: string;
  inputWeightGrams: Grams;
  inputCost: Cents;
  outputs: BreakdownOutput[];
  /** Total weight recovered as saleable product. */
  outputWeightGrams: Grams;
  /** inputWeight - outputWeight. Never negative; zero is suspicious, not ideal. */
  lossGrams: Grams;
  /** Loss as a percentage of the input, to one decimal place. */
  lossPercent: number;
  /** Recovered weight as a percentage of the input. */
  totalYieldPercent: number;
}

/**
 * Anything above this is almost certainly a weighing or typing mistake rather
 * than a real breakdown. The UI warns; it does not block, because an unusual
 * carcass is the operator's call to make and record.
 */
export const IMPLAUSIBLE_LOSS_PERCENT = 35;

export function computeBreakdown(input: BreakdownInput): BreakdownResult {
  assertGrams(input.inputWeightGrams, "inputWeightGrams");
  assertCents(input.inputCost, "inputCost");

  if (input.inputWeightGrams <= 0) {
    throw new Error("computeBreakdown: input weight must be above zero");
  }
  if (input.outputs.length === 0) {
    throw new Error("computeBreakdown: a breakdown must produce at least one output");
  }
  for (const output of input.outputs) {
    assertGrams(output.weightGrams, `${output.sku} weight`);
    if (output.weightGrams <= 0) {
      throw new Error(`computeBreakdown: ${output.sku} must have a weight above zero`);
    }
  }

  const outputWeightGrams = sumGrams(input.outputs.map((o) => o.weightGrams));
  if (outputWeightGrams > input.inputWeightGrams) {
    throw new Error(
      `computeBreakdown: outputs weigh ${gramsToKg(outputWeightGrams)} kg but the carcass came in at ` +
        `${gramsToKg(input.inputWeightGrams)} kg — meat cannot be created by cutting it up`,
    );
  }

  // The cost of the whole carcass is carried entirely by the saleable outputs,
  // spread by weight. Loss has no cost of its own; it makes everything else
  // dearer, which is exactly what it does in reality.
  const costShares = allocate(
    input.inputCost,
    input.outputs.map((o) => o.weightGrams),
  );

  const outputs: BreakdownOutput[] = input.outputs.map((output, i) => {
    const costAllocated = costShares[i] ?? 0;
    return {
      ...output,
      isByProduct: output.isByProduct ?? false,
      yieldPercent: yieldPercent(output.weightGrams, input.inputWeightGrams),
      costAllocated,
      costPerKg: Math.round((costAllocated * 1000) / output.weightGrams),
    };
  });

  const lossGrams = input.inputWeightGrams - outputWeightGrams;

  return {
    sourceProductId: input.sourceProductId,
    sourceSku: input.sourceSku,
    inputWeightGrams: input.inputWeightGrams,
    inputCost: input.inputCost,
    outputs,
    outputWeightGrams,
    lossGrams,
    lossPercent: yieldPercent(lossGrams, input.inputWeightGrams),
    totalYieldPercent: yieldPercent(outputWeightGrams, input.inputWeightGrams),
  };
}

/** The cost allocation must add back up to what was paid for the carcass. */
export function assertCostBalances(result: BreakdownResult): void {
  const allocated = sumCents(result.outputs.map((o) => o.costAllocated));
  if (allocated !== result.inputCost) {
    throw new Error(
      `Breakdown cost allocation lost money: allocated ${allocated} of ${result.inputCost} cents`,
    );
  }
}

export function breakdownWarnings(result: BreakdownResult): string[] {
  const warnings: string[] = [];
  if (result.lossGrams === 0) {
    warnings.push(
      "No loss recorded. A breakdown with zero shrinkage usually means an output weight was estimated rather than weighed.",
    );
  }
  if (result.lossPercent > IMPLAUSIBLE_LOSS_PERCENT) {
    warnings.push(
      `Loss is ${result.lossPercent}% of the input weight. Check the scale and the output weights before posting.`,
    );
  }
  return warnings;
}
