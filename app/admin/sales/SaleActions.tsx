"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatCents } from "@/lib/money";

/**
 * Void, refund and reprint from the sales list.
 *
 * Every one of these posts the manager's credentials with the request and
 * lets the SERVER decide. The dialog is a convenience for the manager standing
 * there; it is not the check.
 */
export function SaleActions({
  saleId,
  receiptNumber,
  status,
  total,
  awaitingCodePaymentId,
  permissions,
}: {
  saleId: string;
  receiptNumber: string;
  status: string;
  total: number;
  /** Set when this sale has an M-Pesa payment with no confirmation code yet. */
  awaitingCodePaymentId: string | null;
  permissions: { void: boolean; refund: boolean; reprint: boolean; reconcile: boolean };
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"VOID" | "REFUND" | "CODE" | null>(null);
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [code, setCode] = useState("");
  const [paidAt, setPaidAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const reversible = status === "COMPLETED" && total >= 0;

  const submit = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const endpoint = dialog === "VOID" ? "/api/sales/void" : "/api/sales/refund";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          saleId,
          reason,
          ...(dialog === "REFUND" ? { lines: [], method: "MPESA" } : {}),
          approval: { pin },
        }),
      });

      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(data.error ?? "That did not go through");
        return;
      }

      setDialog(null);
      setReason("");
      setPin("");
      router.refresh();
    } catch {
      setMessage("Could not reach the server");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Record the M-Pesa code on a sale that was paid and printed earlier.
   *
   * No manager PIN: this is not a change to the sale, it is filling in the
   * proof that the money arrived, and the server checks the permission.
   */
  const submitCode = async () => {
    if (!awaitingCodePaymentId) return;
    setBusy(true);
    setMessage(null);
    try {
      const at = /^(\d{1,2}):(\d{2})$/.exec(paidAt.trim());
      if (!at) {
        setMessage("Enter the time as HH:MM");
        return;
      }
      const when = new Date();
      when.setHours(Number(at[1]), Number(at[2]), 0, 0);
      if (when.getTime() > Date.now() + 60_000) when.setDate(when.getDate() - 1);

      const response = await fetch("/api/sales/mpesa-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          saleId,
          paymentId: awaitingCodePaymentId,
          reference: code.trim().toUpperCase(),
          transactedAt: when.toISOString(),
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(data.error ?? "Could not record the code");
        return;
      }
      setDialog(null);
      setCode("");
      setPaidAt("");
      router.refresh();
    } catch {
      setMessage("Could not reach the server");
    } finally {
      setBusy(false);
    }
  };

  const reprint = async () => {
    setBusy(true);
    try {
      await fetch("/api/sales/reprint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ saleId }),
      });
      setMessage("Queued for printing");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex justify-end gap-1">
      {permissions.reconcile && awaitingCodePaymentId && (
        <button
          type="button"
          onClick={() => {
            const now = new Date();
            setPaidAt(
              `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
            );
            setDialog("CODE");
          }}
          className="sheet border-l-2 border-brass-500 px-2 py-1 text-xs font-medium text-brass-800 hover:bg-brass-50"
        >
          Add code
        </button>
      )}
      {permissions.reprint && (
        <button
          type="button"
          onClick={reprint}
          disabled={busy}
          className="sheet px-2 py-1 text-xs font-medium text-char-600 hover:bg-char-100 disabled:opacity-50"
        >
          Reprint
        </button>
      )}
      {permissions.refund && reversible && (
        <button
          type="button"
          onClick={() => setDialog("REFUND")}
          className="sheet px-2 py-1 text-xs font-medium text-brass-700 hover:bg-brass-50"
        >
          Refund
        </button>
      )}
      {permissions.void && reversible && (
        <button
          type="button"
          onClick={() => setDialog("VOID")}
          className="sheet px-2 py-1 text-xs font-medium text-meat-700 hover:bg-meat-50"
        >
          Void
        </button>
      )}

      {message && !dialog && (
        <span className="absolute right-0 top-8 z-10 whitespace-nowrap sheet bg-char-900 px-2 py-1 text-xs text-white">
          {message}
        </span>
      )}

      {dialog === "CODE" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm sheet bg-char-50 p-5 text-left shadow-2xl">
            <h2 className="text-base font-semibold text-char-900">
              M-Pesa code for {receiptNumber}
            </h2>
            <p className="mt-1 text-sm text-char-500">
              From the customer&rsquo;s confirmation message. This does not change the sale — it
              records the proof that {formatCents(total, { symbol: true })} arrived.
            </p>

            <label className="mt-4 block">
              <span className="mb-1 block text-xs font-medium text-char-600">Transaction code</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="SJH4K2L9XZ"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
                className="h-10 w-full sheet border border-char-300 px-2 text-sm uppercase tracking-wider"
              />
            </label>

            <label className="mt-2 block">
              <span className="mb-1 block text-xs font-medium text-char-600">
                Time on the message
              </span>
              <input
                value={paidAt}
                onChange={(e) => setPaidAt(e.target.value)}
                placeholder="14:32"
                inputMode="numeric"
                className="tabular h-10 w-full sheet border border-char-300 px-2 text-sm"
              />
            </label>

            {message && <p className="mt-3 text-sm text-meat-700">{message}</p>}

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setDialog(null);
                  setMessage(null);
                }}
                className="h-10 sheet bg-char-100 text-sm font-medium text-char-700 hover:bg-char-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitCode}
                disabled={busy || code.trim().length < 8}
                className="h-10 sheet bg-brass-500 text-sm font-semibold text-char-950 hover:bg-brass-400 disabled:opacity-50"
              >
                {busy ? "Recording…" : "Record code"}
              </button>
            </div>
          </div>
        </div>
      )}

      {(dialog === "VOID" || dialog === "REFUND") && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm sheet bg-char-50 p-5 text-left shadow-2xl">
            <h2 className="text-base font-semibold text-char-900">
              {dialog === "VOID" ? "Void" : "Refund"} {receiptNumber}
            </h2>
            <p className="mt-1 text-sm text-char-500">
              {dialog === "VOID"
                ? "The sale stays on record, marked voided, and the meat goes back into stock."
                : `A reversal of ${formatCents(total, { symbol: true })} will be recorded as its own sale.`}
            </p>

            <label className="mt-4 block">
              <span className="mb-1 block text-xs font-medium text-char-600">Reason</span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this being reversed?"
                className="h-10 w-full sheet border border-char-300 px-2 text-sm"
              />
            </label>

            <p className="mt-3 text-[11px] text-char-500">
              Manager approval
            </p>
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              type="password"
              placeholder="Manager PIN"
              inputMode="numeric"
              autoComplete="off"
              className="mt-1 h-10 w-full sheet border border-char-300 px-2 text-sm"
            />

            {message && <p className="mt-3 text-sm text-meat-700">{message}</p>}

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setDialog(null);
                  setMessage(null);
                }}
                className="h-10 sheet bg-char-100 text-sm font-medium text-char-700 hover:bg-char-200"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy || reason.trim().length < 3 || pin.length < 6}
                className={`h-10 sheet text-sm font-semibold text-white disabled:opacity-40 ${
                  dialog === "VOID"
                    ? "bg-brass-500 hover:bg-brass-400"
                    : "bg-brass-500 hover:bg-brass-500"
                }`}
              >
                {busy ? "Working…" : dialog === "VOID" ? "Void sale" : "Refund sale"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
