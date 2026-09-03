/**
 * PIN rules — the pure half.
 *
 * Deliberately free of `node:crypto` so the sign-in pad, the manager-approval
 * dialog and the staff form can all import it. `lib/auth.ts` holds everything
 * that hashes or compares a PIN and must stay server-side; anything a client
 * component needs to know about the SHAPE of a PIN belongs here.
 *
 * If you find yourself importing lib/auth from a "use client" file, the thing
 * you want is almost certainly in this file instead.
 */

/**
 * Six digits minimum: the PIN is the whole credential — it identifies the
 * person and authorises them, with nothing else typed. Four digits across a
 * dozen staff is roughly a one-in-800 chance that a guess lands on somebody,
 * which is not a lock. Six makes it one in 80,000.
 */
export const PIN_MIN_LENGTH = 6;
export const PIN_MAX_LENGTH = 8;

export function isValidPinFormat(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}$`).test(pin);
}

/**
 * PINs a thief would try first, and the patterns a bored cashier picks.
 * Refused at the point a PIN is set — "123456" on a manager account defeats
 * every approval check in the application.
 */
const OBVIOUS_PINS = new Set([
  "123456", "654321", "111111", "000000", "222222", "333333", "444444",
  "555555", "666666", "777777", "888888", "999999", "121212", "123123",
  "112233", "696969", "159753", "147258", "012345", "101010", "123321",
  "1234567", "12345678", "87654321", "11111111", "00000000",
]);

export function isWeakPin(pin: string): boolean {
  if (OBVIOUS_PINS.has(pin)) return true;
  // All one digit.
  if (/^(\d)\1+$/.test(pin)) return true;
  return isSequential(pin);
}

/** A straight run up or down, of any length: 456789, 987654. */
function isSequential(pin: string): boolean {
  let up = true;
  let down = true;
  for (let i = 1; i < pin.length; i += 1) {
    const step = pin.charCodeAt(i) - pin.charCodeAt(i - 1);
    if (step !== 1) up = false;
    if (step !== -1) down = false;
  }
  return up || down;
}
