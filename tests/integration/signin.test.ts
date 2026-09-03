import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  clearFailedPins,
  hashPin,
  MAX_PIN_ATTEMPTS,
  pinLockoutRemainingMs,
  recordFailedPin,
} from "@/lib/auth";
import { identifyByPin, pinTaken } from "@/lib/services/staff";
import { verifyApprover } from "@/lib/session";

/**
 * Signing in with a PIN alone.
 *
 * The PIN is the whole credential: six digits identify the person and say what
 * they may do. That only holds together if a PIN points at exactly one person,
 * so these tests are mostly about the ways that could stop being true.
 */

const ADMIN_PIN = "907143";
const CASHIER_PIN = "270496";
const SECOND_CASHIER_PIN = "583017";

beforeAll(async () => {
  // Every seeded member of staff must be reachable by PIN alone; a NULL
  // lookup would mean somebody silently cannot sign in.
  expect(await db.user.count({ where: { pinLookup: null } })).toBe(0);
});

beforeEach(() => clearFailedPins());

describe("identifying a person from their PIN", () => {
  it("finds the cashier", async () => {
    const user = await identifyByPin(CASHIER_PIN);
    expect(user?.name).toBe("Cashier One");
    expect(user?.role).toBe("CASHIER");
  });

  it("finds the admin", async () => {
    const user = await identifyByPin(ADMIN_PIN);
    expect(user?.name).toBe("Shop Admin");
    expect(user?.role).toBe("ADMIN");
  });

  it("returns nobody for a PIN that is not in use", async () => {
    expect(await identifyByPin("314159")).toBeNull();
  });

  it("returns nobody for a malformed PIN rather than throwing", async () => {
    expect(await identifyByPin("")).toBeNull();
    expect(await identifyByPin("abc")).toBeNull();
    expect(await identifyByPin("12")).toBeNull();
  });

  it("gives every member of staff a different identity", async () => {
    const pins = [ADMIN_PIN, CASHIER_PIN, SECOND_CASHIER_PIN];
    const ids = await Promise.all(pins.map((pin) => identifyByPin(pin).then((u) => u?.id)));
    expect(new Set(ids).size).toBe(pins.length);
    expect(ids.every(Boolean)).toBe(true);
  });

  it("refuses a deactivated person's PIN, exactly like a wrong one", async () => {
    const user = await db.user.findUniqueOrThrow({ where: { staffCode: "4002" } });
    await db.user.update({ where: { id: user.id }, data: { active: false } });

    expect(await identifyByPin(SECOND_CASHIER_PIN)).toBeNull();

    await db.user.update({ where: { id: user.id }, data: { active: true } });
    expect((await identifyByPin(SECOND_CASHIER_PIN))?.id).toBe(user.id);
  });

  it("still verifies the scrypt hash, so a forged lookup value gets nobody in", async () => {
    const victim = await db.user.findUniqueOrThrow({ where: { staffCode: "4001" } });
    const original = victim.pinLookup;

    // Point the cashier's lookup row at a PIN whose scrypt hash it does not
    // match — the indexed digest finds the row, and verification rejects it.
    const other = await hashPin("864209");
    await db.user.update({ where: { id: victim.id }, data: { pinLookup: other.pinLookup } });

    expect(await identifyByPin("864209")).toBeNull();

    await db.user.update({ where: { id: victim.id }, data: { pinLookup: original } });
  });
});

describe("PINs must belong to one person", () => {
  it("knows when a PIN is already taken", async () => {
    expect(await pinTaken(CASHIER_PIN)).toBe(true);
    expect(await pinTaken("314159")).toBe(false);
  });

  it("does not count a person's own PIN against them when editing", async () => {
    const cashier = await db.user.findUniqueOrThrow({ where: { staffCode: "4001" } });
    expect(await pinTaken(CASHIER_PIN, cashier.id)).toBe(false);
    expect(await pinTaken(CASHIER_PIN, "someone-else")).toBe(true);
  });

  it("refuses at the database level to give two people the same PIN", async () => {
    const admin = await db.user.findUniqueOrThrow({ where: { staffCode: "1000" } });
    const duplicate = await hashPin(CASHIER_PIN);

    // Even if a caller skipped the check, the unique index stops it — the till
    // could not say who rang up a sale if two people shared a PIN.
    await expect(
      db.user.update({ where: { id: admin.id }, data: { pinLookup: duplicate.pinLookup } }),
    ).rejects.toThrow();
  });
});

describe("admin approval by PIN", () => {
  it("accepts the admin's PIN", async () => {
    const approver = await verifyApprover(ADMIN_PIN, "sale.void");
    expect(approver.name).toBe("Shop Admin");
    expect(approver.role).toBe("ADMIN");
  });

  it("rejects a PIN nobody has", async () => {
    await expect(verifyApprover("314159", "sale.void")).rejects.toThrow(/not recognised/);
  });

  it("names the person when their PIN is right but their role is not", async () => {
    // The cashier is standing there; a vague refusal just gets them to try
    // the same PIN again.
    await expect(verifyApprover(CASHIER_PIN, "sale.void")).rejects.toThrow(
      /Cashier One cannot authorise/,
    );
  });

  it("will not let one cashier authorise another cashier's void", async () => {
    await expect(verifyApprover(SECOND_CASHIER_PIN, "sale.refund")).rejects.toThrow(
      /cannot authorise/,
    );
  });

  it("lets the admin authorise a stock adjustment too", async () => {
    expect((await verifyApprover(ADMIN_PIN, "stock.adjust")).role).toBe("ADMIN");
  });
});

describe("brute force", () => {
  it("locks the pad after repeated wrong PINs", async () => {
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i += 1) recordFailedPin();
    expect(pinLockoutRemainingMs()).toBeGreaterThan(0);

    // Even the correct PIN is refused while the pad is locked — otherwise the
    // lockout would only slow down a guesser who never gets lucky.
    await expect(verifyApprover(ADMIN_PIN, "sale.void")).rejects.toThrow(/Too many wrong PINs/);

    clearFailedPins();
    expect((await verifyApprover(ADMIN_PIN, "sale.void")).role).toBe("ADMIN");
  });

  it("clears the count once someone gets in", async () => {
    recordFailedPin();
    recordFailedPin();
    await verifyApprover(ADMIN_PIN, "sale.void");
    expect(pinLockoutRemainingMs()).toBe(0);
  });
});
