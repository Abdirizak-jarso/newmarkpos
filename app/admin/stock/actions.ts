"use server";

import { revalidatePath } from "next/cache";
import { requirePermission, AuthorisationError } from "@/lib/session";
import { adjustStock, countStock, receiveStock } from "@/lib/services/stock";
import { stockAdjustmentSchema, stockCountSchema, stockIntakeSchema } from "@/lib/validation";
import { kgToGrams } from "@/lib/weight";
import { shillingsToCents } from "@/lib/money";

export interface StockState {
  error?: string;
  success?: string;
}

/** Weights arrive from the form in kilograms and become grams here, once. */
function gramsFromForm(value: FormDataEntryValue | null, label: string): number {
  try {
    return kgToGrams(String(value ?? ""));
  } catch {
    throw new Error(`${label} is not a valid weight`);
  }
}

export async function intake(_prev: StockState, formData: FormData): Promise<StockState> {
  try {
    const actor = await requirePermission("stock.intake");

    const parsed = stockIntakeSchema.safeParse({
      productId: formData.get("productId"),
      weightGrams: gramsFromForm(formData.get("weightKg"), "Weight"),
      costPerKg: formData.get("costPerKg")
        ? shillingsToCents(String(formData.get("costPerKg")))
        : 0,
      supplier: formData.get("supplier") || undefined,
      note: formData.get("note") || undefined,
    });
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Check the intake details" };
    }

    await receiveStock(parsed.data, actor);
    revalidatePath("/admin/stock");
    revalidatePath("/till");

    return { success: "Stock received." };
  } catch (error) {
    if (error instanceof AuthorisationError) return { error: error.message };
    return { error: error instanceof Error ? error.message : "Could not receive the stock" };
  }
}

export async function adjust(_prev: StockState, formData: FormData): Promise<StockState> {
  try {
    const actor = await requirePermission("stock.adjust");

    const magnitude = gramsFromForm(formData.get("weightKg"), "Weight");
    const direction = String(formData.get("direction") ?? "OUT");

    const parsed = stockAdjustmentSchema.safeParse({
      productId: formData.get("productId"),
      // Waste and write-offs take stock out; a correction can go either way.
      deltaGrams: direction === "IN" ? magnitude : -magnitude,
      reason: formData.get("reason"),
      note: formData.get("note"),
      approval: { pin: formData.get("pin") },
    });
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Check the adjustment" };
    }

    await adjustStock(parsed.data, actor);
    revalidatePath("/admin/stock");
    revalidatePath("/till");

    return { success: "Stock adjusted." };
  } catch (error) {
    if (error instanceof AuthorisationError) return { error: error.message };
    return { error: error instanceof Error ? error.message : "Could not adjust the stock" };
  }
}

export async function count(_prev: StockState, formData: FormData): Promise<StockState> {
  try {
    const actor = await requirePermission("stock.count");

    const parsed = stockCountSchema.safeParse({
      productId: formData.get("productId"),
      countedGrams: gramsFromForm(formData.get("countedKg"), "Counted weight"),
      note: formData.get("note") || undefined,
    });
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Check the count" };
    }

    const result = await countStock(parsed.data, actor);
    revalidatePath("/admin/stock");

    if (result.varianceGrams === 0) return { success: "Count matches the system." };
    const sign = result.varianceGrams > 0 ? "+" : "";
    return {
      success: `Counted in. Variance ${sign}${(result.varianceGrams / 1000).toFixed(3)} kg.`,
    };
  } catch (error) {
    if (error instanceof AuthorisationError) return { error: error.message };
    return { error: error instanceof Error ? error.message : "Could not record the count" };
  }
}
