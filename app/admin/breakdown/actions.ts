"use server";

import { revalidatePath } from "next/cache";
import { requirePermission, AuthorisationError } from "@/lib/session";
import { recordBreakdown } from "@/lib/services/stock";
import { breakdownSchema } from "@/lib/validation";
import { kgToGrams } from "@/lib/weight";
import { shillingsToCents } from "@/lib/money";

export interface BreakdownState {
  error?: string;
  success?: string;
  warnings?: string[];
}

/**
 * Post a carcass breakdown.
 *
 * The outputs arrive as repeated form fields — a row per cut off the block.
 * Rows with no weight are dropped rather than rejected: the operator works
 * down a list of possible cuts and leaves the ones this carcass did not yield.
 */
export async function postBreakdown(
  _prev: BreakdownState,
  formData: FormData,
): Promise<BreakdownState> {
  try {
    const actor = await requirePermission("stock.breakdown");

    const productIds = formData.getAll("outputProductId").map(String);
    const weights = formData.getAll("outputWeightKg").map(String);

    const outputs = productIds
      .map((productId, index) => ({ productId, weightKg: weights[index] ?? "" }))
      .filter((row) => row.productId !== "" && row.weightKg.trim() !== "")
      .map((row) => ({ productId: row.productId, weightGrams: kgToGrams(row.weightKg) }));

    if (outputs.length === 0) {
      return { error: "Add at least one cut with a weight" };
    }

    const parsed = breakdownSchema.safeParse({
      sourceProductId: formData.get("sourceProductId"),
      inputWeightGrams: kgToGrams(String(formData.get("inputWeightKg") ?? "")),
      inputCost: formData.get("inputCost")
        ? shillingsToCents(String(formData.get("inputCost")))
        : 0,
      supplier: formData.get("supplier") || undefined,
      notes: formData.get("notes") || undefined,
      outputs,
    });

    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Check the breakdown" };
    }

    const result = await recordBreakdown(parsed.data, actor);

    revalidatePath("/admin/breakdown");
    revalidatePath("/admin/stock");
    revalidatePath("/till");

    return {
      success:
        `Breakdown posted. ${(result.lossGrams / 1000).toFixed(3)} kg loss ` +
        `(${result.lossPercent}% of the carcass).`,
      warnings: result.warnings,
    };
  } catch (error) {
    if (error instanceof AuthorisationError) return { error: error.message };
    return { error: error instanceof Error ? error.message : "Could not post the breakdown" };
  }
}
