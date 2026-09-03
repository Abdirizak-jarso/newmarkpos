import "server-only";
import { db } from "../db";
import { pinLookup, verifyPin } from "../auth";
import { isRole, type Role } from "../permissions";

/**
 * Finding a person from their PIN.
 *
 * One place does this, and both the sign-in pad and the manager-approval
 * dialog call it, so there is a single answer to "whose PIN is this".
 */

export interface IdentifiedUser {
  id: string;
  name: string;
  staffCode: string;
  role: Role;
}

/**
 * Identify the member of staff whose PIN this is, or null.
 *
 * The indexed HMAC narrows it to one candidate; scrypt then confirms it, so a
 * forged or colliding lookup value still cannot get anybody in. Deactivated
 * staff are excluded here rather than by the caller — a PIN that no longer
 * belongs to anyone working must behave exactly like a wrong PIN.
 */
export async function identifyByPin(pin: string): Promise<IdentifiedUser | null> {
  if (!/^\d+$/.test(pin)) return null;

  let candidate: Awaited<ReturnType<typeof db.user.findUnique>> = null;
  try {
    candidate = await db.user.findUnique({ where: { pinLookup: pinLookup(pin) } });
  } catch {
    // A missing pepper is a deployment fault, not a failed sign-in. Refuse the
    // login rather than falling back to something weaker.
    return null;
  }

  if (!candidate || !candidate.active || !isRole(candidate.role)) return null;

  const ok = await verifyPin(pin, {
    pinHash: candidate.pinHash,
    pinSalt: candidate.pinSalt,
  });
  if (!ok) return null;

  return {
    id: candidate.id,
    name: candidate.name,
    staffCode: candidate.staffCode,
    role: candidate.role,
  };
}

/**
 * Is this PIN already somebody's?
 *
 * Two people sharing a PIN would make the till unable to say who rang up a
 * sale, so it is refused when the PIN is set. Checked against everyone,
 * including deactivated staff, so a returning employee's PIN is still theirs.
 */
export async function pinTaken(pin: string, exceptUserId?: string): Promise<boolean> {
  const owner = await db.user.findUnique({
    where: { pinLookup: pinLookup(pin) },
    select: { id: true },
  });
  if (!owner) return false;
  return owner.id !== exceptUserId;
}
