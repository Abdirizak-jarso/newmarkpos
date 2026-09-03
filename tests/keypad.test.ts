import { describe, expect, it } from "vitest";
import { kgToGrams, weightLineTotal } from "@/lib/weight";
import { shillingsToCents } from "@/lib/money";
import { isTypingField, padShouldHandle, type KeyTarget } from "@/lib/keyboard";

/**
 * What the number pad produces as a cashier taps or types.
 *
 * The press logic mirrors components/Keypad.tsx. It is duplicated here rather
 * than imported because the component is a client module carrying React and
 * JSX, and this is about the arithmetic of typing, not the rendering.
 *
 * What matters: a cashier must be able to enter 0.5 kg, and whatever the pad
 * produces must parse cleanly into grams or cents.
 */
function press(value: string, key: string, maxLength = 8): string {
  if (key === "back") return value.slice(0, -1);
  if (key === "clear") return "";
  if (key === ".") {
    if (value.includes(".")) return value;
    return value === "" ? "0." : `${value}.`;
  }
  if (value.length >= maxLength) return value;
  if (value === "0" && key !== ".") return key;
  return value + key;
}

const type = (keys: string) => [...keys].reduce((value, key) => press(value, key), "");

describe("entering a weight", () => {
  it("takes half a kilo the obvious way", () => {
    expect(type("0.5")).toBe("0.5");
    expect(kgToGrams(type("0.5"))).toBe(500);
  });

  it("takes half a kilo with a leading point, filling in the zero", () => {
    // A cashier in a hurry taps "." then "5".
    expect(type(".5")).toBe("0.5");
    expect(kgToGrams(type(".5"))).toBe(500);
  });

  it("keeps gram precision to three decimals", () => {
    expect(type("1.235")).toBe("1.235");
    expect(kgToGrams(type("1.235"))).toBe(1235);
  });

  it("takes a small weight", () => {
    expect(kgToGrams(type("0.05"))).toBe(50);
    expect(kgToGrams(type("0.005"))).toBe(5);
  });

  it("takes a weight above ten kilos", () => {
    expect(type("12.5")).toBe("12.5");
    expect(kgToGrams(type("12.5"))).toBe(12_500);
  });

  it("refuses a second decimal point rather than producing nonsense", () => {
    expect(type("1.2.5")).toBe("1.25");
  });

  it("does not leave a leading zero on a whole number", () => {
    // Tapping 0 then 5 means 5, not 05.
    expect(type("05")).toBe("5");
  });

  it("backspaces through the point", () => {
    let value = type("0.5");
    value = press(value, "back");
    expect(value).toBe("0.");
    value = press(value, "back");
    expect(value).toBe("0");
  });

  it("stays parseable at every keystroke, so the total never crashes mid-entry", () => {
    let value = "";
    for (const key of "1.235") {
      value = press(value, key);
      // "1." is a legitimate half-typed state and must not throw.
      expect(() => (value === "" ? 0 : kgToGrams(value))).not.toThrow();
    }
  });
});

describe("entering a shilling amount", () => {
  it("takes a round figure", () => {
    expect(shillingsToCents(type("500"))).toBe(50_000);
  });

  it("takes shillings and cents", () => {
    expect(shillingsToCents(type("1250.50"))).toBe(125_050);
  });

  it("takes a leading-point amount", () => {
    expect(shillingsToCents(type(".5"))).toBe(50);
  });
});

/**
 * Who the keystroke belongs to.
 *
 * This is the rule that decides whether a typed digit reaches the pad at all.
 * It is worth its own tests because getting it wrong is invisible: the cashier
 * types and nothing happens, with no error to go on.
 */
describe("routing a keystroke to the pad", () => {
  const field = (over: Partial<KeyTarget> = {}): KeyTarget => ({
    tagName: "INPUT",
    isContentEditable: false,
    inPadLayer: false,
    ...over,
  });

  it("takes the key when nothing is focused", () => {
    expect(padShouldHandle(null)).toBe(true);
  });

  it("takes the key when focus is on the page body", () => {
    expect(padShouldHandle(field({ tagName: "BODY" }))).toBe(true);
  });

  it("takes the key when focus is on a button the cashier just tapped", () => {
    expect(padShouldHandle(field({ tagName: "BUTTON" }))).toBe(true);
  });

  it("leaves the key alone for a field beside the pad", () => {
    // The M-Pesa transaction code, typed next to the amount pad.
    expect(padShouldHandle(field({ inPadLayer: true }))).toBe(false);
    expect(padShouldHandle(field({ tagName: "TEXTAREA", inPadLayer: true }))).toBe(false);
    expect(
      padShouldHandle(field({ tagName: "DIV", isContentEditable: true, inPadLayer: true })),
    ).toBe(false);
  });

  it("takes the key from a field stranded behind the pad", () => {
    // The product search keeping focus while an entry pad is open over it. This
    // is the case that made the keyboard look dead: every digit went into a box
    // the cashier could not see.
    expect(padShouldHandle(field({ tagName: "INPUT", inPadLayer: false }))).toBe(true);
    expect(
      padShouldHandle(field({ tagName: "DIV", isContentEditable: true, inPadLayer: false })),
    ).toBe(true);
  });

  it("knows which elements are typed into", () => {
    expect(isTypingField(field({ tagName: "INPUT" }))).toBe(true);
    expect(isTypingField(field({ tagName: "SELECT" }))).toBe(true);
    expect(isTypingField(field({ tagName: "BUTTON" }))).toBe(false);
    expect(isTypingField(field({ tagName: "DIV", isContentEditable: true }))).toBe(true);
  });
});

/**
 * Setting a price at the counter.
 *
 * The cashier types a weight and the money to charge for it. The till never
 * sends a price — the server would ignore it — so it sends the gap between the
 * catalogue figure and what was agreed, as a line discount. These tests pin the
 * arithmetic that has to hold for the customer to be charged exactly what the
 * cashier typed and no more.
 */
describe("setting a price at the counter", () => {
  /** What the entry pad computes: catalogue total for the weight, minus charge. */
  const reduction = (pricePerKg: number, kg: string, charge: string) =>
    weightLineTotal(pricePerKg, kgToGrams(kg)) - shillingsToCents(charge);

  const PRICE = 82_000; // KSh 820.00/kg

  it("charges exactly the figure typed, once the server takes the discount off", () => {
    const grams = kgToGrams("1.240");
    const catalogue = weightLineTotal(PRICE, grams); // 1,016.80
    const off = reduction(PRICE, "1.240", "900");

    expect(catalogue).toBe(101_680);
    expect(off).toBe(11_680);
    // What the server lands on: its own catalogue price, less the discount.
    expect(catalogue - off).toBe(90_000);
  });

  it("works out to a sane per-kilo rate for the cashier to check", () => {
    const grams = kgToGrams("1.240");
    const charged = 90_000;
    expect(Math.round((charged * 1000) / grams)).toBe(72_581); // 725.81/kg
  });

  it("is a zero reduction when the charge matches the catalogue", () => {
    expect(reduction(PRICE, "2", "1640")).toBe(0);
  });

  it("goes negative above the catalogue price, which the pad refuses", () => {
    // There is no such thing as a negative discount, so the pad blocks this
    // rather than quietly charging the list price.
    expect(reduction(PRICE, "1", "900")).toBeLessThan(0);
  });

  it("keeps gram precision, so the reduction is not rounded twice", () => {
    const grams = kgToGrams("0.375");
    expect(grams).toBe(375);
    const catalogue = weightLineTotal(PRICE, grams); // 307.50
    expect(catalogue).toBe(30_750);
    expect(catalogue - reduction(PRICE, "0.375", "300")).toBe(30_000);
  });

  it("sends whole cents, never a fraction", () => {
    for (const [kg, charge] of [
      ["1.237", "900"],
      ["0.333", "250.50"],
      ["12.005", "9500"],
    ] as const) {
      const off = reduction(PRICE, kg, charge);
      expect(Number.isInteger(off)).toBe(true);
    }
  });
});
