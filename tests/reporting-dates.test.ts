import { describe, expect, it } from "vitest";
import { previousPeriod } from "@/lib/services/reports";
import { addDays, endOfDay, formatShopDateTime, shopDateKey, startOfDay } from "@/lib/shop-clock";

/**
 * Day boundaries are the counter's, not the server's.
 *
 * These run on a machine in any timezone and against a server in UTC, so they
 * assert the instants rather than what `toString()` happens to render.
 */
describe("the shop's day", () => {
  it("starts at midnight in Nairobi, not wherever the server is", () => {
    // 00:30 EAT on 8 Sept is 21:30 UTC on 7 Sept. Both belong to 8 Sept at the
    // counter; on a UTC server the naive version put them on different days.
    const earlyMorning = new Date("2026-09-07T21:30:00Z");
    expect(shopDateKey(earlyMorning)).toBe("2026-09-08");
    expect(startOfDay(earlyMorning).toISOString()).toBe("2026-09-07T21:00:00.000Z");
  });

  it("ends a millisecond before the next one begins", () => {
    const at = new Date("2026-09-08T09:00:00Z");
    expect(endOfDay(at).getTime() + 1).toBe(startOfDay(addDays(at, 1)).getTime());
  });

  it("puts a sale rung just before closing on the right day", () => {
    // 23:45 EAT is 20:45 UTC the same day.
    const closingTime = new Date("2026-09-08T20:45:00Z");
    expect(shopDateKey(closingTime)).toBe("2026-09-08");
  });

  it("puts a sale rung just after midnight on the new day", () => {
    // 00:15 EAT on the 9th is 21:15 UTC on the 8th.
    const afterMidnight = new Date("2026-09-08T21:15:00Z");
    expect(shopDateKey(afterMidnight)).toBe("2026-09-09");
  });

  it("steps a whole day at a time", () => {
    const at = new Date("2026-09-08T09:00:00Z");
    expect(shopDateKey(addDays(at, -1))).toBe("2026-09-07");
    expect(shopDateKey(addDays(at, 1))).toBe("2026-09-09");
  });
});

describe("comparing against the period before", () => {
  it("takes the window of the same length immediately before this one", () => {
    const from = startOfDay(new Date("2026-09-08T09:00:00Z"));
    const to = endOfDay(new Date("2026-09-08T09:00:00Z"));
    const before = previousPeriod(from, to);

    expect(shopDateKey(before.from)).toBe("2026-09-07");
    expect(shopDateKey(before.to)).toBe("2026-09-07");
    // Butts up against this period without overlapping it by so much as a
    // millisecond, or a sale would be counted in both.
    expect(before.to.getTime() + 1).toBe(from.getTime());
    expect(to.getTime() - from.getTime()).toBe(before.to.getTime() - before.from.getTime());
  });

  it("compares a week against the week before it", () => {
    const to = endOfDay(new Date("2026-09-08T09:00:00Z"));
    const from = startOfDay(addDays(new Date("2026-09-08T09:00:00Z"), -6));
    const before = previousPeriod(from, to);

    expect(shopDateKey(before.from)).toBe("2026-08-26");
    expect(shopDateKey(before.to)).toBe("2026-09-01");
  });
});

describe("the receipt's clock", () => {
  it("stamps the counter's time, not the server's", () => {
    // A sale rung at 03:48 in Nairobi is 00:48 UTC. On Vercel the receipt was
    // being stamped 00:48 - three hours before the customer was standing
    // there, and three hours off whatever Safaricom's statement says.
    expect(formatShopDateTime(new Date("2026-09-08T00:48:00Z"))).toBe("08/09/2026 03:48");
  });

  it("rolls the date over at midnight on the counter's clock", () => {
    // 21:30 UTC is 00:30 the next morning in Nairobi.
    expect(formatShopDateTime(new Date("2026-09-07T21:30:00Z"))).toBe("08/09/2026 00:30");
  });
});
