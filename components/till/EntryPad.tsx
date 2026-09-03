"use client";

import { useEffect, useState } from "react";
import { Keypad } from "@/components/Keypad";
import { useDialogFocus } from "@/components/useDialogFocus";
import { formatCents, shillingsToCents } from "@/lib/money";
import { formatKg, kgToGrams, weightForAmount, weightLineTotal } from "@/lib/weight";
import type { TillLine, TillProduct } from "@/app/till/types";

/**
 * Rate and quantity entry.
 *
 * The product grid quotes no prices. A cut is chosen by name, and the price it
 * sells at is typed here, at the counter, next to the customer it was agreed
 * with — so this pad always asks for two figures rather than one:
 *
 *   Rate      what a kilo costs (or what one piece or one pack costs)
 *   Weight    what the scale says — or, on the amount tab, the shillings the
 *             customer asked for, which the pad turns back into a weight
 *
 * line total = rate x weight. The rate travels to the server in its own field
 * as `unitPriceOverride`; the server charges it, stamps the catalogue rate
 * beside it on the sale line, and makes an admin approve anything keyed far
 * enough below the board to be worth stealing. A rate ABOVE the board is fine
 * and needs nobody — the shop cannot be robbed upwards, and a catalogue that
 * has fallen behind this morning's price must never stop the counter trading.
 *
 * The board rate is offered as one tap rather than prefilled. Prefilling it
 * would put the catalogue price back on the screen the shop asked to take it
 * off, and would let a cashier bank the board price by tapping through without
 * ever having read it.
 */

type Mode = "WEIGHT" | "AMOUNT";

/** The pad types into one figure at a time; this is which. */
type Field = "RATE" | "QUANTITY";

export function EntryPad({
  product,
  existing,
  onCancel,
  onSubmit,
}: {
  product: TillProduct;
  existing?: TillLine;
  onCancel: () => void;
  onSubmit: (values: Partial<TillLine>) => void;
}) {
  const dialogRef = useDialogFocus<HTMLDivElement>();
  const perKg = product.pricingMode === "PER_KG";

  const [mode, setMode] = useState<Mode>("WEIGHT");
  /** The rate, as typed: shillings per kg, per piece or per pack. */
  const [rate, setRate] = useState("");
  /** Kilograms on the weight tab, shillings on the amount tab, pieces otherwise. */
  const [amount, setAmount] = useState("");
  // The rate is the figure the cashier came here to type, so the pad starts on
  // it. Enter moves to the quantity; Enter again adds the line.
  const [field, setField] = useState<Field>("RATE");
  const [scaleError, setScaleError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const unitLabel =
    product.pricingMode === "PER_KG"
      ? "/kg"
      : product.pricingMode === "PER_PIECE"
        ? "each"
        : "/pack";

  // Reopening a line puts back exactly what was typed, including the rate, so
  // an edit is a correction rather than a re-entry from scratch.
  useEffect(() => {
    if (!existing) return;
    setRate(formatCents(existing.unitPriceOverride ?? product.price));
    if (perKg && existing.weightGrams !== undefined) {
      setAmount(formatKg(existing.weightGrams));
      setMode("WEIGHT");
    } else if (existing.quantity !== undefined) {
      setAmount(String(existing.quantity));
    }
    setField("QUANTITY");
  }, [existing, perKg, product.price]);

  // --- Derived figures ------------------------------------------------------
  /** The typed rate in cents. Null while the field is empty or half-typed. */
  let rateCents: number | null = null;
  let grams: number | null = null;
  let quantity: number | null = null;
  /** On the amount tab: the weight the typed shillings buy at the typed rate. */
  let targetGrams: number | null = null;
  let lineTotal = 0;

  try {
    if (rate !== "") {
      const parsed = shillingsToCents(rate);
      if (parsed > 0) rateCents = parsed;
    }

    if (!perKg) {
      if (amount !== "") quantity = Math.floor(Number(amount));
      if (rateCents !== null && quantity !== null && quantity > 0) {
        lineTotal = rateCents * quantity;
      }
    } else if (mode === "WEIGHT") {
      if (amount !== "") grams = kgToGrams(amount);
      if (rateCents !== null && grams !== null && grams > 0) {
        lineTotal = weightLineTotal(rateCents, grams);
      }
    } else {
      // By amount: the customer names a figure, the pad works out how much meat
      // that buys AT THE RATE JUST TYPED, and the cashier cuts to it.
      const asked = amount === "" ? 0 : shillingsToCents(amount);
      if (rateCents !== null && asked > 0) {
        targetGrams = weightForAmount(rateCents, asked);
        lineTotal = asked;
      }
    }
  } catch {
    // A partially typed number ("1." mid-entry) is not an error worth showing.
  }

  const canSubmit =
    rateCents !== null &&
    (perKg
      ? mode === "WEIGHT"
        ? grams !== null && grams > 0
        : targetGrams !== null && targetGrams > 0
      : quantity !== null && quantity > 0);

  const submit = () => {
    if (rateCents === null) return;

    if (!perKg && quantity !== null && quantity > 0) {
      onSubmit({
        unitPriceOverride: rateCents,
        quantity,
        weightGrams: undefined,
        requestedAmount: undefined,
        // Nothing here is a discount any more — the rate itself carries the
        // price. Cleared explicitly so reopening an older line and re-saving
        // it cannot leave a stale reduction sitting under the new rate.
        discount: undefined,
      });
      return;
    }

    if (perKg && mode === "WEIGHT" && grams !== null && grams > 0) {
      onSubmit({
        unitPriceOverride: rateCents,
        weightGrams: grams,
        quantity: undefined,
        requestedAmount: undefined,
        discount: undefined,
      });
      return;
    }

    if (perKg && mode === "AMOUNT" && targetGrams !== null && targetGrams > 0) {
      // Charge the calculated weight. The cashier cuts to it; if the cut lands
      // at 0.615 kg rather than 0.610 they switch to the weight tab and type
      // what the scale says. The shillings asked for stay on the receipt.
      onSubmit({
        unitPriceOverride: rateCents,
        weightGrams: targetGrams,
        quantity: undefined,
        requestedAmount: shillingsToCents(amount),
        discount: undefined,
      });
    }
  };

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    // Kilograms and shillings are not the same number; carrying one across
    // would silently charge for the wrong thing. The rate stays — it is the
    // same rate either way.
    setAmount("");
    setField("QUANTITY");
  };

  /** Read the scale through the adapter. A missing scale is not an error. */
  const readScale = async () => {
    setReading(true);
    setScaleError(null);
    try {
      const response = await fetch("/api/scale");
      const data = (await response.json()) as {
        grams?: number;
        stable?: boolean;
        connected?: boolean;
        detail?: string;
      };

      if (!data.connected || data.grams === undefined) {
        setScaleError(data.detail ?? "No scale connected — type the weight");
        return;
      }
      if (!data.stable) {
        setScaleError("Scale is still settling — wait a moment");
        return;
      }
      setMode("WEIGHT");
      setAmount(formatKg(data.grams));
      setField(rate === "" ? "RATE" : "QUANTITY");
    } catch {
      setScaleError("Could not reach the scale — type the weight");
    } finally {
      setReading(false);
    }
  };

  const quantityLabel = !perKg ? "Quantity" : mode === "WEIGHT" ? "Weight" : "Amount";
  const quantityUnit = !perKg
    ? quantity === 1
      ? "piece"
      : "pieces"
    : mode === "WEIGHT"
      ? "kg"
      : "KSh";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        data-keypad-layer
        role="dialog"
        aria-modal="true"
        aria-label={`Enter ${product.name}`}
        className="sheet w-full max-w-lg border border-char-700 bg-char-900 shadow-2xl outline-none"
      >
        <header className="border-b border-char-800 p-4">
          <h2 className="wide text-xl font-semibold text-bone">{product.name}</h2>
          <p className="mt-0.5 text-xs text-char-500">{product.sku}</p>
        </header>

        {perKg && (
          <div className="flex gap-2 px-4 pt-4">
            <ModeTab active={mode === "WEIGHT"} onClick={() => switchMode("WEIGHT")}>
              By weight
            </ModeTab>
            <ModeTab active={mode === "AMOUNT"} onClick={() => switchMode("AMOUNT")}>
              By amount
            </ModeTab>
            <button
              type="button"
              onClick={readScale}
              disabled={reading}
              className="key h-11 shrink-0 bg-char-800 px-4 text-sm font-medium text-char-200 hover:bg-char-700 disabled:opacity-50"
            >
              {reading ? "Reading…" : "Scale"}
            </button>
          </div>
        )}

        <div className="p-4">
          <div className="sheet lit mb-3 px-4 py-3">
            <EntryRow
              label="Price"
              unit={unitLabel === "each" ? "KSh each" : `KSh ${unitLabel}`}
              value={rate}
              active={field === "RATE"}
              onSelect={() => setField("RATE")}
            />
            <EntryRow
              label={quantityLabel}
              unit={quantityUnit}
              value={amount}
              active={field === "QUANTITY"}
              onSelect={() => setField("QUANTITY")}
            />

            <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-char-300 pt-2.5">
              {mode === "AMOUNT" && perKg && targetGrams !== null ? (
                <>
                  <span className="tabular text-sm text-char-600">
                    Cut <span className="font-semibold text-char-950">{formatKg(targetGrams)} kg</span>
                  </span>
                  <span className="readout text-2xl font-bold text-meat-700">
                    {formatCents(lineTotal, { symbol: true })}
                  </span>
                </>
              ) : lineTotal > 0 ? (
                <>
                  <span className="text-sm text-char-600">Line total</span>
                  <span className="readout text-2xl font-bold text-meat-700">
                    {formatCents(lineTotal, { symbol: true })}
                  </span>
                </>
              ) : (
                <span className="text-sm text-char-600">
                  {rateCents === null
                    ? `Type the price ${unitLabel === "each" ? "of one" : unitLabel}`
                    : `Now the ${quantityLabel.toLowerCase()}`}
                </span>
              )}
            </div>
          </div>

          {/*
            The board rate, offered rather than filled in. One tap when today's
            price is the catalogue's, and no figure on the screen the cashier
            can bank without having read it.
          */}
          {product.price > 0 && rateCents !== product.price && (
            <button
              type="button"
              onClick={() => {
                setRate(formatCents(product.price));
                setField("QUANTITY");
              }}
              className="sheet mb-3 flex w-full items-baseline justify-between px-3 py-2 text-left text-xs text-char-400 hover:bg-char-800 hover:text-brass-200"
            >
              <span>Board price</span>
              <span className="tabular font-semibold">
                {formatCents(product.price)} {unitLabel} — tap to use
              </span>
            </button>
          )}

          {scaleError && (
            <p className="sheet mb-3 border-l-2 border-brass-400 bg-brass-950 px-3 py-2 text-sm text-brass-100">
              {scaleError}
            </p>
          )}

          {perKg && mode === "AMOUNT" && field === "QUANTITY" && (
            <div className="mb-3 grid grid-cols-4 gap-2">
              {[100, 200, 500, 1000].map((shillings) => (
                <button
                  key={shillings}
                  type="button"
                  onClick={() => setAmount(String(shillings))}
                  className="key h-11 bg-char-800 text-sm font-semibold text-char-200 hover:bg-char-700"
                >
                  {shillings}
                </button>
              ))}
            </div>
          )}

          <Keypad
            value={field === "RATE" ? rate : amount}
            onChange={field === "RATE" ? setRate : setAmount}
            // Whole pieces only; everything else takes a decimal point.
            decimal={field === "RATE" || perKg}
            maxLength={field === "QUANTITY" && !perKg ? 3 : 8}
            onEnter={
              // Enter on the rate moves to the quantity rather than adding half
              // a line; Enter on the quantity adds it.
              field === "RATE"
                ? rateCents !== null
                  ? () => setField("QUANTITY")
                  : undefined
                : canSubmit
                  ? submit
                  : undefined
            }
          />

          <p className="mt-2 text-center text-[11px] text-char-600">
            {field === "RATE"
              ? "Typing the price — Enter moves to the quantity"
              : !perKg
                ? "Whole pieces"
                : mode === "WEIGHT"
                  ? "Typing the weight — 0.5 and .5 both work"
                  : "Typing the shillings the customer asked for"}
          </p>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="key touch-target bg-char-800 font-semibold text-char-200 hover:bg-char-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className="key touch-target bg-brass-500 font-semibold text-char-950 hover:bg-brass-400 disabled:bg-char-800 disabled:text-char-600 disabled:shadow-none"
            >
              {existing ? "Update line" : "Add to sale"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One of the two figures on the pad.
 *
 * The selected row is the one being typed into, marked by a rule down its left
 * edge — under strip lighting that reads faster than a change of tint, and it
 * survives being looked at from an angle.
 */
function EntryRow({
  label,
  unit,
  value,
  active,
  onSelect,
}: {
  label: string;
  unit: string;
  value: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={`flex w-full items-baseline justify-between gap-3 border-l-[3px] py-1.5 pl-3 text-left ${
        active ? "border-meat-700" : "border-transparent"
      }`}
    >
      <span className={`text-sm ${active ? "font-medium text-char-950" : "text-char-600"}`}>
        {label}
      </span>
      <span className="readout flex items-baseline gap-1.5 text-3xl font-bold leading-none text-char-950">
        {value || <span className="text-char-300">0</span>}
        <span className="text-base font-medium text-char-500">{unit}</span>
      </span>
    </button>
  );
}

function ModeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`key h-11 flex-1 text-sm font-medium ${
        active ? "bg-meat-600 text-white" : "bg-char-800 text-char-300 hover:bg-char-700"
      }`}
    >
      {children}
    </button>
  );
}
