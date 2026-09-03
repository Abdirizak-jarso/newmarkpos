"use server";

import { revalidatePath } from "next/cache";
import { record } from "@/lib/audit";
import { requirePermission, AuthorisationError } from "@/lib/session";
import { setSetting, type ShopSettings } from "@/lib/settings";
import { settingsSchema } from "@/lib/validation";
import { shillingsToCents } from "@/lib/money";
import { kgToGrams } from "@/lib/weight";

export interface SettingsState {
  error?: string;
  success?: string;
}

export async function saveSettings(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  try {
    const actor = await requirePermission("settings.edit");

    const lines = (value: FormDataEntryValue | null) =>
      String(value ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

    const parsed = settingsSchema.safeParse({
      shopName: formData.get("shopName") || undefined,
      tagline: formData.get("tagline") || undefined,
      addressLines: lines(formData.get("addressLines")),
      phone: formData.get("phone") || undefined,
      kraPin: formData.get("kraPin") || undefined,
      receiptFooter: lines(formData.get("receiptFooter")),
      standardVatRatePercent: Number(formData.get("standardVatRatePercent")),
      cashRoundingStep: formData.get("cashRoundingStep")
        ? shillingsToCents(String(formData.get("cashRoundingStep")))
        : 0,
      discountApprovalThreshold: shillingsToCents(
        String(formData.get("discountApprovalThreshold") ?? "0"),
      ),
      discountApprovalPercent: Number(formData.get("discountApprovalPercent")),
      paperWidthMm: Number(formData.get("paperWidthMm")) === 58 ? 58 : 80,
      lowStockWarningGrams: kgToGrams(String(formData.get("lowStockWarningKg") ?? "0")),
    });

    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Check the settings" };
    }

    // Each key is written separately so the audit log carries the before and
    // after of the individual setting that moved, not a wall of JSON.
    const changed: Record<string, { from: unknown; to: unknown }> = {};

    for (const [key, value] of Object.entries(parsed.data)) {
      if (value === undefined) continue;
      const previous = await setSetting(
        key as keyof ShopSettings,
        value as ShopSettings[keyof ShopSettings],
      );
      if (JSON.stringify(previous) !== JSON.stringify(value)) {
        changed[key] = { from: previous, to: value };
      }
    }

    if (Object.keys(changed).length === 0) return { success: "Nothing changed." };

    await record({
      action: "SETTING_CHANGED",
      entity: "Setting",
      before: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.from])),
      after: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.to])),
      actorId: actor.id,
    });

    revalidatePath("/admin/settings");
    revalidatePath("/till");

    return { success: `Saved ${Object.keys(changed).length} change(s).` };
  } catch (error) {
    if (error instanceof AuthorisationError) return { error: error.message };
    return { error: error instanceof Error ? error.message : "Could not save the settings" };
  }
}
