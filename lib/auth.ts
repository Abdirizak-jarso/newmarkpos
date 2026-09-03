import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH, isValidPinFormat } from "./pin";

/**
 * Staff PINs.
 *
 * The PIN is the whole credential: a cashier taps six digits and the till
 * knows who they are. Nothing else is typed. That is the right trade at a shop
 * counter — a staff code as well would be two-factor in name only, since it is
 * printed on the rota and everyone knows everyone else's — but it does mean
 * the PIN carries all the weight, so:
 *
 *   - PINs are six to eight digits, not four. Four digits across a dozen staff
 *     is a one-in-a-few-hundred chance that a guess lands on somebody.
 *   - No two members of staff may share a PIN, enforced by the database.
 *   - Obvious PINs are refused at the point they are set.
 *   - Wrong PINs lock the pad for the whole terminal, because with nothing but
 *     a PIN there is no account to lock instead.
 *
 * The PIN itself is never stored, logged, or written to the audit trail.
 *
 * SERVER ONLY. This module imports node:crypto; importing it from a "use
 * client" component puts an empty crypto stub in the browser bundle and the
 * module throws on evaluation. Client components want lib/pin.ts.
 */

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;

// The shape rules live in lib/pin.ts, which has no crypto import, so that
// client components can read them without dragging node:crypto into the
// browser bundle. Re-exported here so server code has one place to import
// everything about PINs from.
export { PIN_MAX_LENGTH, PIN_MIN_LENGTH, isValidPinFormat, isWeakPin } from "./pin";

export interface PinHash {
  pinHash: string;
  pinSalt: string;
}

export interface PinCredentials extends PinHash {
  pinLookup: string;
}

export async function hashPin(pin: string): Promise<PinCredentials> {
  if (!isValidPinFormat(pin)) {
    throw new Error(`PIN must be ${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits`);
  }
  const salt = randomBytes(16);
  const derived = await scrypt(pin, salt, KEY_LENGTH);
  return {
    pinHash: derived.toString("hex"),
    pinSalt: salt.toString("hex"),
    pinLookup: pinLookup(pin),
  };
}

export async function verifyPin(pin: string, stored: PinHash): Promise<boolean> {
  // Not a format complaint at this point — a malformed PIN is simply wrong,
  // and answering differently would tell an attacker something.
  if (!/^\d+$/.test(pin)) return false;

  try {
    const salt = Buffer.from(stored.pinSalt, "hex");
    const expected = Buffer.from(stored.pinHash, "hex");
    const derived = await scrypt(pin, salt, expected.length || KEY_LENGTH);
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * A keyed, deterministic fingerprint of a PIN.
 *
 * Signing in with nothing but a PIN means the till has to find the owner from
 * the PIN alone. Testing the scrypt hash of every member of staff would work
 * but costs ~50ms each — a second of dead time at the counter with twenty
 * staff — so this indexed HMAC finds the one candidate and scrypt then
 * confirms it. It doubles as the uniqueness constraint on PINs.
 *
 * The pepper lives in the environment, never in the database. Without it these
 * values are meaningless; with the database alone, a stolen copy reveals
 * nothing about anyone's PIN.
 */
export function pinLookup(pin: string): string {
  const pepper = process.env.PIN_PEPPER ?? process.env.SESSION_SECRET;
  if (!pepper || pepper.length < 16) {
    throw new Error(
      "PIN_PEPPER (or SESSION_SECRET) must be set to at least 16 characters before PINs can be used",
    );
  }
  return createHmac("sha256", pepper).update(`newmark-pin:${pin}`).digest("hex");
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Lockout after repeated wrong PINs.
 *
 * Keyed by terminal rather than by person: with nothing typed but a PIN there
 * is no account to attribute a failure to, so the pad itself locks. That is
 * also the right shape for the actual threat — somebody standing at an
 * unattended till working through six-digit guesses.
 *
 * Held in memory. A till is a single long-running process, and a lockout that
 * survived a restart would let a shift be sabotaged by whoever can reach the
 * power switch. It is a brute-force brake, not an account boundary.
 */
const attempts = new Map<string, { count: number; firstAt: number; lockedUntil?: number }>();

export const MAX_PIN_ATTEMPTS = 5;
export const LOCKOUT_MS = 60_000;
const WINDOW_MS = 5 * 60_000;

/** The scope a failure counts against. One pad, one counter. */
export function terminalScope(): string {
  return `terminal:${process.env.TERMINAL_ID ?? "T1"}`;
}

export function pinLockoutRemainingMs(scope: string = terminalScope(), now = Date.now()): number {
  const record = attempts.get(scope);
  if (!record?.lockedUntil) return 0;
  return Math.max(0, record.lockedUntil - now);
}

export function recordFailedPin(scope: string = terminalScope(), now = Date.now()): number {
  const record = attempts.get(scope);
  if (!record || now - record.firstAt > WINDOW_MS) {
    attempts.set(scope, { count: 1, firstAt: now });
    return MAX_PIN_ATTEMPTS - 1;
  }
  record.count += 1;
  if (record.count >= MAX_PIN_ATTEMPTS) record.lockedUntil = now + LOCKOUT_MS;
  return Math.max(0, MAX_PIN_ATTEMPTS - record.count);
}

export function clearFailedPins(scope: string = terminalScope()): void {
  attempts.delete(scope);
}
