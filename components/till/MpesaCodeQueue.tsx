"use client";

import { useCallback, useEffect, useState } from "react";
import { useDialogFocus } from "@/components/useDialogFocus";
import { formatCents } from "@/lib/money";
import { MPESA_CODE, toTimestamp } from "@/components/till/PaymentPad";
import type { UnconfirmedPayment } from "@/lib/services/sales";

/**
 * Sales waiting for their M-Pesa code.
 *
 * Every row here is money the shop took but cannot yet match against the
 * Safaricom statement. The cashier clears them between customers, as each
 * confirmation message comes through, which is why this lives at the till and
 * not only in the back office.
 *
 * Oldest first: the ones that have been sitting longest are the ones about to
 * be forgotten, and a forgotten one is the shop's loss to argue.
 */
export function MpesaCodeQueue({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: (waiting: number) => void;
}) {
  const dialogRef = useDialogFocus<HTMLDivElement>();
  const [waiting, setWaiting] = useState<UnconfirmedPayment[] | null>(null);
  const [selected, setSelected] = useState<UnconfirmedPayment | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/sales/mpesa-code");
      if (!response.ok) throw new Error("Could not read the list");
      const data = (await response.json()) as { waiting: UnconfirmedPayment[] };
      setWaiting(data.waiting);
      onChanged(data.waiting.length);
    } catch {
      setError("Could not load the list. The sales are safe — try again.");
    }
  }, [onChanged]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        data-keypad-layer
        role="dialog"
        aria-modal="true"
        aria-label="Sales waiting for an M-Pesa code"
        className="sheet flex max-h-[85vh] w-full max-w-xl flex-col border border-char-700 bg-char-900 shadow-2xl outline-none"
      >
        <header className="flex items-baseline justify-between gap-4 border-b border-char-800 p-4">
          <div>
            <h2 className="wide text-lg font-semibold text-bone">Waiting for a code</h2>
            <p className="mt-0.5 text-xs text-char-400">
              Paid and printed. Add the code from the customer&rsquo;s message.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="key shrink-0 bg-char-800 px-4 py-2 text-sm text-char-200 hover:bg-char-700"
          >
            Close
          </button>
        </header>

        <div className="till-scroll min-h-0 flex-1 overflow-y-auto p-4">
          {error && (
            <p role="alert" className="sheet mb-3 border-l-2 border-meat-500 bg-meat-950 px-3 py-2 text-sm text-meat-100">
              {error}
            </p>
          )}

          {waiting === null ? (
            <p className="py-10 text-center text-sm text-char-500">Loading…</p>
          ) : waiting.length === 0 ? (
            <p className="py-10 text-center text-sm text-char-400">
              Every M-Pesa payment has its code. Nothing outstanding.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {waiting.map((row) => (
                <li key={row.paymentId}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(row);
                      setError(null);
                    }}
                    className="key flex w-full items-center justify-between gap-4 bg-char-800 px-4 py-3 text-left hover:bg-char-700"
                  >
                    <span className="min-w-0">
                      <span className="tabular block text-sm font-medium text-bone">
                        {row.receiptNumber}
                      </span>
                      <span className="tabular mt-0.5 block text-[11px] text-char-400">
                        {new Date(row.takenAt).toLocaleTimeString("en-KE", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </span>
                    <span className="readout shrink-0 text-lg font-semibold text-brass-300">
                      {formatCents(row.amount)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {selected && (
        <CodeDialog
          payment={selected}
          onCancel={() => setSelected(null)}
          onRecorded={() => {
            setSelected(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/** Entering one code, against one payment. */
function CodeDialog({
  payment,
  onCancel,
  onRecorded,
}: {
  payment: UnconfirmedPayment;
  onCancel: () => void;
  onRecorded: () => void;
}) {
  const dialogRef = useDialogFocus<HTMLDivElement>();
  const [reference, setReference] = useState("");
  const [paidAt, setPaidAt] = useState(() => {
    // Default to the time the sale was rung up: the payment happened within a
    // minute or two of it, so this is usually right or one keystroke away.
    const at = new Date(payment.takenAt);
    return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const code = reference.trim().toUpperCase();
  const codeOk = MPESA_CODE.test(code);
  const transactedAt = toTimestamp(paidAt);
  const ready = codeOk && transactedAt !== null;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/sales/mpesa-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          saleId: payment.saleId,
          paymentId: payment.paymentId,
          reference: code,
          transactedAt,
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(data.error ?? "Could not record the code");
        return;
      }
      onRecorded();
    } catch {
      setError("The till could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        data-keypad-layer
        role="dialog"
        aria-modal="true"
        aria-label={`Code for receipt ${payment.receiptNumber}`}
        className="sheet w-full max-w-sm border border-char-700 bg-char-900 p-5 shadow-2xl outline-none"
      >
        <h2 className="wide text-lg font-semibold text-bone">{payment.receiptNumber}</h2>
        <p className="tabular mt-0.5 text-sm text-char-400">
          {formatCents(payment.amount, { symbol: true })} by M-Pesa
        </p>

        <label className="mt-4 block">
          <span className="mb-1 block text-xs text-char-400">Transaction code</span>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value.toUpperCase())}
            placeholder="SJH4K2L9XZ"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            className={`sheet h-11 w-full border bg-char-950 px-3 text-sm uppercase tracking-wider text-bone placeholder:text-char-600 focus:outline-none ${
              reference === "" || codeOk ? "border-char-700 focus:border-brass-500" : "border-meat-500"
            }`}
          />
        </label>

        <label className="mt-2 block">
          <span className="mb-1 block text-xs text-char-400">Time on the message</span>
          <input
            value={paidAt}
            onChange={(e) => setPaidAt(e.target.value)}
            placeholder="14:32"
            inputMode="numeric"
            className={`tabular sheet h-11 w-full border bg-char-950 px-3 text-sm text-bone placeholder:text-char-600 focus:outline-none ${
              transactedAt !== null ? "border-char-700 focus:border-brass-500" : "border-meat-500"
            }`}
          />
        </label>

        {reference !== "" && !codeOk && (
          <p className="mt-2 text-xs text-meat-300">
            An M-Pesa code is 10 characters, letters and numbers.
          </p>
        )}

        {error && (
          <p role="alert" className="sheet mt-3 border-l-2 border-meat-500 bg-meat-950 px-3 py-2 text-sm text-meat-100">
            {error}
          </p>
        )}

        <div className="mt-4 grid grid-cols-2 gap-2">
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
            disabled={!ready || busy}
            className="key touch-target bg-brass-500 font-semibold text-char-950 hover:bg-brass-400 disabled:bg-char-800 disabled:text-char-600 disabled:shadow-none"
          >
            {busy ? "Recording…" : "Record code"}
          </button>
        </div>
      </div>
    </div>
  );
}
