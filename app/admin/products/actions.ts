"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { record } from "@/lib/audit";
import { requirePermission, verifyApprover, AuthorisationError } from "@/lib/session";
import { priceChangeSchema } from "@/lib/validation";

export interface ActionState {
  error?: string;
  success?: string;
}

/**
 * Change a shelf price.
 *
 * Needs the manager PIN and records the before and after. A price change is
 * the single easiest way to walk value out of a butchery, so the audit line
 * carries both figures and both people.
 */
export async function changePrice(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const actor = await requirePermission("product.price");

    const parsed = priceChangeSchema.safeParse({
      productId: formData.get("productId"),
      price: Number(formData.get("price")),
      reason: formData.get("reason") || undefined,
      approval: { pin: formData.get("pin") },
    });
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Check the price and the PIN" };
    }

    const approver = await verifyApprover(parsed.data.approval.pin, "product.price");

    const before = await db.product.findUnique({
      where: { id: parsed.data.productId },
      select: { price: true, name: true, sku: true },
    });
    if (!before) return { error: "Product not found" };
    if (before.price === parsed.data.price) return { success: "Price unchanged." };

    await db.product.update({
      where: { id: parsed.data.productId },
      data: { price: parsed.data.price },
    });

    await record({
      action: "PRICE_CHANGE",
      entity: "Product",
      entityId: parsed.data.productId,
      before: { price: before.price },
      after: { price: parsed.data.price },
      actorId: actor.id,
      approverId: approver.id,
      reason: parsed.data.reason,
    });

    revalidatePath("/admin/products");
    revalidatePath("/till");

    return { success: `${before.name} updated.` };
  } catch (error) {
    if (error instanceof AuthorisationError) return { error: error.message };
    console.error("[products] price change failed", error);
    return { error: "Could not change the price" };
  }
}
