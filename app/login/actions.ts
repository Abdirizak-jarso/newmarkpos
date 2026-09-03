"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { clearFailedPins, pinLockoutRemainingMs, recordFailedPin } from "@/lib/auth";
import { createSession, destroySession, pruneExpiredSessions } from "@/lib/session";
import { identifyByPin } from "@/lib/services/staff";
import { recordSafely } from "@/lib/audit";
import { loginSchema } from "@/lib/validation";
import { can } from "@/lib/permissions";

export interface LoginState {
  error?: string;
}

/**
 * Sign in with a PIN.
 *
 * The PIN is the whole credential: it says who you are and what you may do.
 * Nothing identifies the person first, so a wrong PIN can only ever be
 * answered with "not recognised" — there is no account to say it about.
 */
export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({ pin: formData.get("pin") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Enter your PIN" };
  }

  // The pad locks, not an account — with only a PIN typed there is nobody to
  // attribute the failures to, and the threat is someone working through
  // guesses at an unattended till.
  const lockedMs = pinLockoutRemainingMs();
  if (lockedMs > 0) {
    return { error: `Too many wrong PINs. Try again in ${Math.ceil(lockedMs / 1000)} seconds.` };
  }

  const user = await identifyByPin(parsed.data.pin);

  if (!user) {
    const remaining = recordFailedPin();
    // Deliberately not an audit entry. The audit log records who did what, and
    // an unrecognised PIN has no who — attributing it to a placeholder actor
    // would put a fiction in the one table that has to be trustworthy. The
    // server log is the right home for it.
    console.warn(
      `[login] unrecognised PIN at terminal ${process.env.TERMINAL_ID ?? "T1"} — ${remaining} attempts left`,
    );
    return { error: `PIN not recognised (${remaining} attempts left)` };
  }

  clearFailedPins();
  await pruneExpiredSessions();
  await createSession(user.id);
  await db.user.update({ where: { id: user.id }, data: { lastSeen: new Date() } });

  await recordSafely({ action: "LOGIN", entity: "User", entityId: user.id, actorId: user.id });

  redirect(can(user.role, "sale.create") ? "/till" : "/admin");
}

export async function logout(): Promise<void> {
  await destroySession();
  redirect("/login");
}
