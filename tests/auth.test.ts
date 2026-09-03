import { beforeEach, describe, expect, it } from "vitest";
import {
  clearFailedPins,
  hashPin,
  isValidPinFormat,
  isWeakPin,
  MAX_PIN_ATTEMPTS,
  PIN_MIN_LENGTH,
  pinLockoutRemainingMs,
  pinLookup,
  recordFailedPin,
  terminalScope,
  verifyPin,
} from "@/lib/auth";
import {
  can,
  canApprove,
  needsAdminApproval,
  permissionsFor,
  PERMISSIONS,
  ROLES,
} from "@/lib/permissions";

describe("PIN hashing", () => {
  it("never stores the PIN itself", async () => {
    const stored = await hashPin("270496");
    expect(stored.pinLookup).not.toContain("270496");
    expect(stored.pinHash).not.toContain("270496");
    expect(stored.pinSalt).not.toContain("270496");
    expect(stored.pinHash.length).toBeGreaterThan(64);
  });

  it("salts per user, so two people with the same PIN hash differently", async () => {
    const a = await hashPin("270496");
    const b = await hashPin("270496");
    expect(a.pinHash).not.toBe(b.pinHash);
    expect(a.pinSalt).not.toBe(b.pinSalt);
  });

  it("gives the same PIN the same lookup value, so duplicates can be caught", async () => {
    // This is the whole point of the lookup column: the scrypt hashes differ
    // per person, so only a deterministic keyed digest can spot two people
    // sharing a PIN — and find whose PIN was just typed at the till.
    const a = await hashPin("270496");
    const b = await hashPin("270496");
    const c = await hashPin("418205");
    expect(a.pinLookup).toBe(b.pinLookup);
    expect(a.pinLookup).not.toBe(c.pinLookup);
    expect(pinLookup("270496")).toBe(a.pinLookup);
  });

  it("keys the lookup to the pepper, so a stolen database alone reveals nothing", () => {
    const original = process.env.PIN_PEPPER;
    process.env.PIN_PEPPER = "a".repeat(64);
    const first = pinLookup("270496");
    process.env.PIN_PEPPER = "b".repeat(64);
    const second = pinLookup("270496");
    process.env.PIN_PEPPER = original;
    expect(first).not.toBe(second);
  });

  it("refuses to work at all without a pepper", () => {
    const pepper = process.env.PIN_PEPPER;
    const secret = process.env.SESSION_SECRET;
    delete process.env.PIN_PEPPER;
    delete process.env.SESSION_SECRET;
    expect(() => pinLookup("270496")).toThrow(/PIN_PEPPER/);
    process.env.PIN_PEPPER = pepper;
    process.env.SESSION_SECRET = secret;
  });

  it("accepts the right PIN and rejects everything else", async () => {
    const stored = await hashPin("270496");
    expect(await verifyPin("270496", stored)).toBe(true);
    expect(await verifyPin("270497", stored)).toBe(false);
    expect(await verifyPin("27049", stored)).toBe(false);
    expect(await verifyPin("2704960", stored)).toBe(false);
    expect(await verifyPin("", stored)).toBe(false);
  });

  it("requires six digits, because the PIN is now the whole credential", async () => {
    // Four digits across a dozen staff is a one-in-a-few-hundred chance that a
    // guess lands on somebody. Six is not.
    expect(PIN_MIN_LENGTH).toBe(6);
    await expect(hashPin("1234")).rejects.toThrow();
    await expect(hashPin("12345")).rejects.toThrow();
  });

  it("returns false rather than throwing on a corrupt stored hash", async () => {
    expect(await verifyPin("270496", { pinHash: "not-hex", pinSalt: "also-not-hex" })).toBe(false);
  });

  it("refuses to set a PIN that is too short or not numeric", async () => {
    await expect(hashPin("123")).rejects.toThrow();
    await expect(hashPin("abcdef")).rejects.toThrow();
    await expect(hashPin("123456789")).rejects.toThrow();
  });

  it("knows a valid PIN format", () => {
    expect(isValidPinFormat("270496")).toBe(true);
    expect(isValidPinFormat("12345678")).toBe(true);
    expect(isValidPinFormat("12345")).toBe(false);
    expect(isValidPinFormat("12a456")).toBe(false);
  });
});

describe("weak PINs", () => {
  it("rejects the ones a thief tries first", () => {
    // A manager account on 123456 defeats every approval check in the system.
    for (const pin of ["123456", "654321", "111111", "000000", "121212"]) {
      expect(isWeakPin(pin)).toBe(true);
    }
  });

  it("rejects a straight run or a single repeated digit of any length", () => {
    expect(isWeakPin("456789")).toBe(true);
    expect(isWeakPin("987654")).toBe(true);
    expect(isWeakPin("7777777")).toBe(true);
  });

  it("allows an ordinary PIN", () => {
    expect(isWeakPin("270496")).toBe(false);
    expect(isWeakPin("418205")).toBe(false);
  });
});

describe("PIN lockout", () => {
  beforeEach(() => clearFailedPins("TEST"));

  it("locks the pad, not an account — with only a PIN typed there is no account", () => {
    // The scope defaults to the terminal precisely because a failed sign-in
    // cannot be attributed to anybody: nothing identifying was entered.
    expect(terminalScope()).toMatch(/^terminal:/);
  });

  it("counts down the remaining attempts", () => {
    expect(recordFailedPin("TEST")).toBe(MAX_PIN_ATTEMPTS - 1);
    expect(recordFailedPin("TEST")).toBe(MAX_PIN_ATTEMPTS - 2);
  });

  it("locks the staff code after too many wrong PINs", () => {
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i += 1) recordFailedPin("TEST");
    expect(pinLockoutRemainingMs("TEST")).toBeGreaterThan(0);
  });

  it("clears on a successful sign-in", () => {
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i += 1) recordFailedPin("TEST");
    clearFailedPins("TEST");
    expect(pinLockoutRemainingMs("TEST")).toBe(0);
  });

  it("locks one terminal without locking the other tills out", () => {
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i += 1) recordFailedPin("TEST");
    expect(pinLockoutRemainingMs("OTHER")).toBe(0);
  });
});

describe("permissions", () => {
  it("keeps a cashier off the things that need a manager", () => {
    expect(can("CASHIER", "sale.create")).toBe(true);
    expect(can("CASHIER", "sale.void")).toBe(false);
    expect(can("CASHIER", "sale.refund")).toBe(false);
    expect(can("CASHIER", "product.price")).toBe(false);
    expect(can("CASHIER", "stock.adjust")).toBe(false);
    expect(can("CASHIER", "audit.view")).toBe(false);
    expect(can("CASHIER", "settings.edit")).toBe(false);
  });

  it("gives the admin everything a cashier has, and more", () => {
    for (const permission of permissionsFor("CASHIER")) {
      expect(can("ADMIN", permission)).toBe(true);
    }
    expect(permissionsFor("ADMIN").length).toBeGreaterThan(permissionsFor("CASHIER").length);
  });

  it("keeps the back office to the admin", () => {
    expect(can("CASHIER", "settings.edit")).toBe(false);
    expect(can("ADMIN", "settings.edit")).toBe(true);
    expect(can("CASHIER", "product.delete")).toBe(false);
    expect(can("ADMIN", "product.delete")).toBe(true);
    expect(can("CASHIER", "report.margin")).toBe(false);
    expect(can("ADMIN", "report.margin")).toBe(true);
  });

  it("no longer carries any shift or cash-drawer permission", () => {
    // Shifts and cash-up were removed from this till. A permission that names
    // a feature nobody can reach reads like a check that is still happening.
    expect(PERMISSIONS.filter((p) => /^shift\.|^cash\./.test(p))).toEqual([]);
  });

  it("has exactly two roles", () => {
    expect(ROLES).toEqual(["CASHIER", "ADMIN"]);
  });

  it("names the actions that need a second person's PIN", () => {
    expect(needsAdminApproval("sale.void")).toBe(true);
    expect(needsAdminApproval("sale.refund")).toBe(true);
    expect(needsAdminApproval("product.price")).toBe(true);
    expect(needsAdminApproval("stock.adjust")).toBe(true);
    expect(needsAdminApproval("sale.create")).toBe(false);
  });

  it("will not let a cashier authorise their own void", () => {
    // Otherwise the approval step is theatre: the person doing the thing that
    // needs approving is the one approving it.
    expect(canApprove("CASHIER", "sale.void")).toBe(false);
    expect(canApprove("ADMIN", "sale.void")).toBe(true);
  });

  it("has a permission list for every role", () => {
    for (const role of ROLES) {
      expect(permissionsFor(role).length).toBeGreaterThan(0);
    }
  });
});
