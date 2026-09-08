/**
 * The shop's clock.
 *
 * Every date in this system is an instant, and every instant has to be read
 * somewhere. The obvious somewhere - `getHours()`, `toLocaleString()` with no
 * timezone - is wherever the process happens to be running, and this one runs
 * on Vercel in UTC while the counter is in Nairobi. That is not a rounding
 * error: it puts 03:48 EAT on a receipt as 00:48, three hours before the
 * customer was standing there, and it makes "today" begin at 03:00.
 *
 * A receipt's time is not decoration. It is what the shop and Safaricom match
 * a disputed M-Pesa payment on.
 *
 * Kenya is UTC+3 and has never observed daylight saving, so the offset is the
 * whole of the rule and a fixed number is honest here. The IANA name is kept
 * beside it for `Intl`, which wants a zone rather than an offset.
 */

export const SHOP_TIME_ZONE = "Africa/Nairobi";
export const SHOP_OFFSET_MS = 3 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The same instant, shifted so the UTC accessors read as the shop's clock. */
function atCounter(at: Date): Date {
  return new Date(at.getTime() + SHOP_OFFSET_MS);
}

/** Midnight at the counter, expressed as the instant it happens. */
export function startOfDay(at = new Date()): Date {
  const shopClock = atCounter(at);
  const midnight = Date.UTC(
    shopClock.getUTCFullYear(),
    shopClock.getUTCMonth(),
    shopClock.getUTCDate(),
  );
  return new Date(midnight - SHOP_OFFSET_MS);
}

export function endOfDay(at = new Date()): Date {
  return new Date(startOfDay(at).getTime() + DAY_MS - 1);
}

export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * DAY_MS);
}

/** `2026-09-08` as the counter would date it, for grouping and for URLs. */
export function shopDateKey(at: Date): string {
  return atCounter(at).toISOString().slice(0, 10);
}

/** The hour of the shop's day, 0-23, that this instant fell in. */
export function shopHour(at: Date): number {
  return atCounter(at).getUTCHours();
}

/**
 * `08/09/2026 03:48` on the counter's clock.
 *
 * Hand-formatted rather than left to `Intl`, because this also goes through
 * the ESC/POS byte builder, which strips anything outside plain ASCII - and
 * some locales quietly render a non-breaking space between the date and the
 * time, which would arrive on the paper as a missing character.
 */
export function formatShopDateTime(at: Date): string {
  const shopClock = atCounter(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${pad(shopClock.getUTCDate())}/${pad(shopClock.getUTCMonth() + 1)}/` +
    `${shopClock.getUTCFullYear()} ` +
    `${pad(shopClock.getUTCHours())}:${pad(shopClock.getUTCMinutes())}`
  );
}
