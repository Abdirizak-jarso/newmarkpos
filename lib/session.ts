import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "./db";
import { generateSessionToken } from "./auth";
import { can, isRole, type Permission, type Role } from "./permissions";

/**
 * Server-side sessions and the real authorisation checks.
 *
 * Every mutation in this application starts by calling `requirePermission`.
 * The client is never trusted to say who it is or what it may do.
 */

const COOKIE_NAME = "newmark_session";
const SESSION_HOURS = 14; // A long day at the counter, and then some.

export interface CurrentUser {
  id: string;
  name: string;
  staffCode: string;
  role: Role;
}

export async function createSession(userId: string): Promise<string> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000);

  await db.session.create({ data: { userId, token, expiresAt } });

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    // The till runs on the shop LAN over plain HTTP; forcing Secure there
    // would lock every cashier out. Set it in production over TLS.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });

  return token;
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (token) await db.session.deleteMany({ where: { token } });
  store.delete(COOKIE_NAME);
}

/** The signed-in user, or null. Never throws — used by layouts to redirect. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await db.session.findUnique({ where: { token }, include: { user: true } });
  if (!session || session.expiresAt < new Date()) return null;
  if (!session.user.active) return null;
  if (!isRole(session.user.role)) return null;

  return {
    id: session.user.id,
    name: session.user.name,
    staffCode: session.user.staffCode,
    role: session.user.role,
  };
}

export class AuthorisationError extends Error {
  constructor(
    message: string,
    readonly permission?: Permission,
  ) {
    super(message);
    this.name = "AuthorisationError";
  }
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthorisationError("Not signed in");
  return user;
}

/**
 * The gate. Call this at the top of every server action and route handler that
 * changes anything — before validating input, before touching the database.
 */
export async function requirePermission(permission: Permission): Promise<CurrentUser> {
  const user = await requireUser();
  if (!can(user.role, permission)) {
    throw new AuthorisationError(`${user.name} is not permitted to ${permission}`, permission);
  }
  return user;
}

/**
 * The same gate, for a PAGE rather than a mutation.
 *
 * A cashier who follows a link into the back office should land back at the
 * till, not at a 500. The check is identical — only the failure mode differs,
 * because a person navigating is not the same as a request being rejected.
 */
export async function requirePagePermission(permission: Permission): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!can(user.role, permission)) {
    redirect(can(user.role, "sale.create") ? "/till" : "/login");
  }
  return user;
}

/**
 * Manager approval at the till: a supervisor or manager physically enters
 * their staff code and PIN to authorise the cashier's action.
 *
 * Returns the approver so the caller can record them on the audit event. The
 * approver is deliberately not signed in — the cashier keeps the session.
 */
export async function verifyApprover(pin: string, permission: Permission): Promise<CurrentUser> {
  const { recordFailedPin, clearFailedPins, pinLockoutRemainingMs } = await import("./auth");
  const { identifyByPin } = await import("./services/staff");

  const lockedMs = pinLockoutRemainingMs();
  if (lockedMs > 0) {
    throw new AuthorisationError(`Too many wrong PINs. Try again in ${Math.ceil(lockedMs / 1000)}s`);
  }

  const approver = await identifyByPin(pin);
  if (!approver) {
    const remaining = recordFailedPin();
    throw new AuthorisationError(`PIN not recognised (${remaining} attempts left)`);
  }

  clearFailedPins();

  // The PIN is genuine but belongs to someone who cannot authorise this. Say
  // whose it is — the manager is standing right there, and a vague refusal
  // just gets the same wrong person to try again.
  if (!can(approver.role, permission)) {
    throw new AuthorisationError(`${approver.name} cannot authorise ${permission}`, permission);
  }

  return approver;
}

/** Housekeeping, run at login rather than on a timer the till may never hit. */
export async function pruneExpiredSessions(): Promise<void> {
  await db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}
