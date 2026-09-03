"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { record } from "@/lib/audit";
import { hashPin, isWeakPin } from "@/lib/auth";
import { pinTaken } from "@/lib/services/staff";
import { requirePermission, AuthorisationError } from "@/lib/session";
import { userSchema } from "@/lib/validation";
import { isRole } from "@/lib/permissions";

export interface StaffState {
  error?: string;
  success?: string;
}

export async function saveStaff(_prev: StaffState, formData: FormData): Promise<StaffState> {
  try {
    const actor = await requirePermission("staff.manage");

    const id = formData.get("id") ? String(formData.get("id")) : null;
    const parsed = userSchema.safeParse({
      name: formData.get("name"),
      staffCode: formData.get("staffCode"),
      role: formData.get("role"),
      pin: formData.get("pin") || undefined,
      active: formData.get("active") === "on",
    });
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Check the staff details" };
    }

    const { name, staffCode, role, pin, active } = parsed.data;

    // A manager account on "123456" defeats every approval check in the system.
    if (pin && isWeakPin(pin)) {
      return { error: "That PIN is too easy to guess. Choose another." };
    }
    if (!id && !pin) {
      return { error: "A new staff member needs a PIN — it is how they sign in" };
    }

    // The PIN is the only thing typed at the till, so it has to point at one
    // person. Checked here for a clear message; the database has a unique
    // index on it as well, because this check and the write are not atomic.
    if (pin && (await pinTaken(pin, id ?? undefined))) {
      return { error: "Another member of staff already uses that PIN. Choose another." };
    }

    if (id) {
      const before = await db.user.findUnique({ where: { id } });
      if (!before) return { error: "Staff member not found" };

      // Never let the last admin demote themselves out of the back office —
      // there would be nobody left who could put it right.
      if (before.role === "ADMIN" && role !== "ADMIN") {
        const admins = await db.user.count({ where: { role: "ADMIN", active: true } });
        if (admins <= 1) return { error: "The shop must keep at least one active admin" };
      }

      const credentials = pin ? await hashPin(pin) : null;

      await db.user.update({
        where: { id },
        data: {
          name,
          staffCode,
          role,
          active,
          ...(credentials ?? {}),
        },
      });

      if (before.role !== role) {
        await record({
          action: "ROLE_CHANGED",
          entity: "User",
          entityId: id,
          before: { role: before.role },
          after: { role },
          actorId: actor.id,
        });
      }
      if (pin) {
        // The PIN itself is never written to the log — only that it changed.
        await record({
          action: "PIN_CHANGED",
          entity: "User",
          entityId: id,
          after: { changed: true },
          actorId: actor.id,
        });
      }
      if (before.active !== active) {
        await record({
          action: "USER_DEACTIVATED",
          entity: "User",
          entityId: id,
          before: { active: before.active },
          after: { active },
          actorId: actor.id,
        });
      }

      revalidatePath("/admin/staff");
      return { success: `${name} updated.` };
    }

    const credentials = await hashPin(pin!);
    const created = await db.user.create({
      data: { name, staffCode, role, active, ...credentials },
    });

    await record({
      action: "USER_CREATED",
      entity: "User",
      entityId: created.id,
      after: { name, staffCode, role },
      actorId: actor.id,
    });

    revalidatePath("/admin/staff");
    return { success: `${name} added.` };
  } catch (error) {
    if (error instanceof AuthorisationError) return { error: error.message };
    const message = error instanceof Error ? error.message : "Could not save";
    // A duplicate staff code is the common failure; say so plainly.
    if (message.includes("Unique constraint")) {
      return {
        error: message.includes("pinLookup")
          ? "Another member of staff already uses that PIN. Choose another."
          : "That employee number is already taken",
      };
    }
    return { error: message };
  }
}

/** Staff are deactivated, never deleted — their sales must keep their author. */
export async function deactivateStaff(userId: string): Promise<StaffState> {
  try {
    const actor = await requirePermission("staff.manage");

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user || !isRole(user.role)) return { error: "Staff member not found" };

    if (user.role === "ADMIN") {
      const admins = await db.user.count({ where: { role: "ADMIN", active: true } });
      if (admins <= 1) return { error: "The shop must keep at least one active admin" };
    }

    await db.user.update({ where: { id: userId }, data: { active: false } });
    await db.session.deleteMany({ where: { userId } });

    await record({
      action: "USER_DEACTIVATED",
      entity: "User",
      entityId: userId,
      before: { active: true },
      after: { active: false },
      actorId: actor.id,
    });

    revalidatePath("/admin/staff");
    return { success: `${user.name} deactivated.` };
  } catch (error) {
    if (error instanceof AuthorisationError) return { error: error.message };
    return { error: "Could not deactivate" };
  }
}
