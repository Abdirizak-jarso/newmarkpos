"use client";

import { useState } from "react";
import { formatCents } from "@/lib/money";
import type { SaleTotals } from "@/lib/pricing";
import type { TillTender } from "@/app/till/types";

/**
 * Taking the money.
 *
 * The shop takes M-Pesa and nothing else, so there is no method to choose, no
 * amount to key and no split to build: the customer pays the total, and the
 * only question on this screen is whether it has landed.
 *
 * The confirmation code is NOT collected here by default, and that is the whole
 * point of the screen. Safaricom's message reaches the customer's phone seconds
 * to minutes after they authorise the payment, and a counter with people
 * waiting cannot stop for it. So the sale is banked and the receipt printed on
 * the cashier's confirmation, the payment is filed as PENDING, and the code is
 * recorded afterwards from the list of sales still waiting for one.
 *
 * When the message has already arrived — often it has — the cashier opens the
 * code panel and enters it here, and the payment is confirmed outright. That is
 * the better outcome; it is just never the thing holding up the queue.
 */

/** "14:32" — what the cashier reads off the customer's phone. */
function clockNow(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/** Turn "14:32" into a full timestamp on today's date. */
export function toTimestamp(clock: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  const at = new Date();
  at.setHours(hours, minutes, 0, 0);
  // A payment timed later than now is yesterday's — the shop trades past
  // midnight and a cashier keying "23:50" at 00:10 means last night.
  if (at.getTime() > Date.now() + 60_000) at.setDate(at.getDate() - 1);
  return at.toISOString();
}

export const MPESA_CODE = /^[A-Z0-9]{8,15}$/;

export function PaymentPad({
  totals,
  busy,
  error,
  onCancel,
  onComplete,
}: {
  totals: SaleTotals | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onComplete: (
    tenders: TillTender[],
    customer: { name?: string; phone?: string; pin?: string },
  ) => void;
}) {
  const [haveCode, setHaveCode] = useState(false);
  const [reference, setReference] = useState("");
  const [paidAt, setPaidAt] = useState(clockNow);
  const [customerName, setCustomerName] = useState("");
  const [customerPin, setCustomerPin] = useState("");
  const [showCustomer, setShowCustomer] = useState(false);

  const total = totals?.total ?? 0;

  const code = reference.trim().toUpperCase();
  const codeOk = MPESA_CODE.test(code);
  const timeOk = toTimestamp(paidAt) !== null;
  // Opening the panel means the cashier is holding the message. Half a code is
  // worse than none — it would file as confirmed against something unmatchable.
  const codeReady = !haveCode || (codeOk && timeOk);

  const complete = () => {
    if (!codeReady || total <= 0) return;
    onComplete(
      [
        {
          method: "MPESA",
          amount: total,
          reference: haveCode ? code : undefined,
          transactedAt: haveCode ? (toTimestamp(paidAt) ?? undefined) : undefined,
        },
      ],
      {
        name: customerName.trim() || undefined,
        pin: customerPin.trim() || undefined,
      },
    );
  };

  return (
    <div data-keypad-layer className="flex min-h-0 flex-1 flex-col p-4">
      <div className="mb-4 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={onCancel}
          className="key shrink-0 bg-char-800 px-5 py-3 text-sm font-medium text-char-200 hover:bg-char-700"
        >
          Back to the sale
        </button>

        {/* The figure the customer is paying. Same readout as the cart it came from. */}
        <div className="sheet lit flex items-baseline gap-4 px-4 py-2.5">
          <span className="text-sm text-char-600">To pay</span>
          <span className="readout text-3xl font-bold leading-none text-meat-700">
            {formatCents(total, { symbol: true })}
          </span>
        </div>
      </div>

      <div className="till-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="sheet mx-auto max-w-lg border border-char-800 bg-char-900 p-5">
          <h2 className="wide text-lg font-semibold text-bone">Paid by M-Pesa</h2>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-char-400">
            Confirm once the customer has paid. The receipt prints straight away and the sale
            joins the list waiting for a code, so you can carry on serving.
          </p>

          <div className="mt-4 border-t border-char-800 pt-4">
            <button
              type="button"
              onClick={() => setHaveCode((open) => !open)}
              aria-expanded={haveCode}
              className="key w-full bg-char-800 px-4 py-3 text-left text-sm font-medium text-char-200 hover:bg-char-700"
            >
              {haveCode
                ? "Record the code later instead"
                : "The customer already has the message — enter the code now"}
            </button>

            {haveCode && (
              <div className="sheet mt-2 border border-char-700 bg-char-950 p-3">
                <label className="block">
                  <span className="mb-1 block text-xs text-char-400">Transaction code</span>
                  <input
                    value={reference}
                    onChange={(e) => setReference(e.target.value.toUpperCase())}
                    placeholder="SJH4K2L9XZ"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    autoFocus
                    className={`sheet h-11 w-full border bg-char-900 px-3 text-sm uppercase tracking-wider text-bone placeholder:text-char-600 focus:outline-none ${
                      reference === "" || codeOk
                        ? "border-char-700 focus:border-brass-500"
                        : "border-meat-500"
                    }`}
                  />
                </label>

                <label className="mt-2 block">
                  <span className="mb-1 block text-xs text-char-400">Time on the message</span>
                  <div className="flex gap-2">
                    <input
                      value={paidAt}
                      onChange={(e) => setPaidAt(e.target.value)}
                      placeholder="14:32"
                      inputMode="numeric"
                      className={`tabular sheet h-11 w-full border bg-char-900 px-3 text-sm text-bone placeholder:text-char-600 focus:outline-none ${
                        timeOk ? "border-char-700 focus:border-brass-500" : "border-meat-500"
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setPaidAt(clockNow())}
                      className="key h-11 shrink-0 bg-char-800 px-3 text-xs font-medium text-char-300 hover:bg-char-700"
                    >
                      Now
                    </button>
                  </div>
                </label>

                {reference !== "" && !codeOk && (
                  <p className="mt-2 text-xs text-meat-300">
                    An M-Pesa code is 10 characters, letters and numbers.
                  </p>
                )}
                {!timeOk && (
                  <p className="mt-2 text-xs text-meat-300">Enter the time as HH:MM, e.g. 14:32.</p>
                )}
              </div>
            )}
          </div>

          <div className="mt-4 border-t border-char-800 pt-4">
            <button
              type="button"
              onClick={() => setShowCustomer((s) => !s)}
              aria-expanded={showCustomer}
              className="text-xs text-char-400 hover:text-char-200"
            >
              {showCustomer ? "Hide" : "Add"} customer details for a tax invoice
            </button>

            {showCustomer && (
              <div className="mt-2 space-y-2">
                <input
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Customer name"
                  className="sheet h-11 w-full border border-char-700 bg-char-950 px-3 text-sm text-bone placeholder:text-char-500 focus:border-brass-500 focus:outline-none"
                />
                <input
                  value={customerPin}
                  onChange={(e) => setCustomerPin(e.target.value.toUpperCase())}
                  placeholder="KRA PIN"
                  className="sheet h-11 w-full border border-char-700 bg-char-950 px-3 text-sm uppercase text-bone placeholder:text-char-500 focus:border-brass-500 focus:outline-none"
                />
              </div>
            )}
          </div>

          {error && (
            <p role="alert" className="sheet mt-4 border-l-2 border-meat-500 bg-meat-950 px-3 py-2 text-sm text-meat-100">
              {error}
            </p>
          )}

          <button
            type="button"
            disabled={busy || total <= 0 || !codeReady}
            onClick={complete}
            className="key touch-target mt-4 w-full bg-emerald-500 text-lg font-bold text-char-950 hover:bg-emerald-400 disabled:bg-char-800 disabled:text-char-600 disabled:shadow-none"
          >
            {busy
              ? "Completing…"
              : !codeReady
                ? "Finish the code, or record it later"
                : "Mark paid and print"}
          </button>
        </div>
      </div>
    </div>
  );
}
