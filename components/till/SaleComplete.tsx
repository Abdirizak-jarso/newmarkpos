"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatCents } from "@/lib/money";
import { receiptToPlainText } from "@/lib/adapters/escpos";
import type { CheckoutResponse } from "@/app/till/types";

/**
 * The done screen.
 *
 * Change due is the biggest thing on it, because that is the number the
 * cashier acts on with a queue behind them. Everything else — the receipt, a
 * warning about an offline sale — sits below it and never blocks the "next
 * customer" button.
 *
 * The receipt is sent to the printer automatically the moment this screen
 * appears. The sale is already banked by then, so a printer that is off costs
 * the shop a retry press, never a sale.
 */

interface FlushResult {
  printed: number;
  failed: number;
  pending: number;
  lastError?: string;
  adapter: string;
  connected: boolean;
}

type PrintState =
  | { kind: "sending" }
  | { kind: "printed"; count: number }
  | { kind: "no-printer"; detail: string }
  | { kind: "failed"; detail: string };

export function SaleComplete({
  result,
  onNext,
  shopName,
}: {
  result: CheckoutResponse;
  onNext: () => void;
  shopName: string;
}) {
  const [print, setPrint] = useState<PrintState>({ kind: "sending" });
  const [showReceipt, setShowReceipt] = useState(false);
  // React runs effects twice in development; the queue must not be drained
  // twice for one sale just because Strict Mode remounted the screen.
  const sent = useRef(false);

  const flush = useCallback(async () => {
    setPrint({ kind: "sending" });
    try {
      const response = await fetch("/api/print/flush", { method: "POST" });
      const data = (await response.json()) as FlushResult;

      if (!data.connected) {
        setPrint({
          kind: "no-printer",
          detail: "No printer connected — show the customer the receipt on screen.",
        });
        return;
      }
      if (data.printed > 0) {
        setPrint({ kind: "printed", count: data.printed });
        return;
      }
      setPrint({
        kind: "failed",
        detail: data.lastError ?? "The printer did not respond. The receipt is still queued.",
      });
    } catch {
      setPrint({ kind: "failed", detail: "Could not reach the print queue." });
    }
  }, []);

  useEffect(() => {
    // An offline sale has nothing queued on this terminal's server yet; its
    // receipt goes out when the outbox syncs.
    if (result.queuedOffline) {
      setPrint({ kind: "no-printer", detail: "Sold offline — the receipt prints once this till syncs." });
      return;
    }
    if (sent.current) return;
    sent.current = true;
    void flush();
  }, [flush, result.queuedOffline]);

  // The counter should clear itself. A cashier who has handed over the change
  // and turned to the next customer should not come back to a stale screen.
  // Reading the on-screen receipt to a customer takes longer than 20 seconds,
  // so opening it stops the clock.
  useEffect(() => {
    if (showReceipt) return;
    const timer = setTimeout(onNext, 20_000);
    return () => clearTimeout(timer);
  }, [onNext, showReceipt]);

  const receiptText = result.receiptPayload ? decodeReceipt(result.receiptPayload) : null;

  return (
    <main className="flex h-screen flex-col items-center justify-center bg-char-950 p-6">
      {/* Hidden while printing — ReceiptSheet below is a sibling, not a
          child, so hiding this leaves only the receipt itself on the page. */}
      <div className="no-print w-full max-w-md">
        {/*
          No tick in a circle. The one thing that matters on this screen is the
          figure the cashier is about to count into somebody's hand, so that is
          the lit readout and everything else is a caption around it.
        */}
        <div className="flex items-baseline justify-between text-sm text-char-400">
          <span>Sale complete</span>
          <span className="tabular text-char-300">{result.receiptNumber}</span>
        </div>

        {result.changeDue > 0 ? (
          <div className="sheet lit mt-2 px-5 py-5">
            <p className="readout flex items-baseline justify-end gap-2 text-6xl font-bold leading-none text-char-950">
              <span className="text-2xl text-char-500">KSh</span>
              {formatCents(result.changeDue)}
            </p>
            <p className="mt-3 border-t border-char-300 pt-2.5 text-sm text-char-600">
              Change to hand back
            </p>
          </div>
        ) : (
          <div className="sheet lit mt-2 px-5 py-5">
            <p className="readout flex items-baseline justify-end gap-2 text-5xl font-bold leading-none text-char-950">
              <span className="text-2xl text-char-500">KSh</span>
              {formatCents(result.total)}
            </p>
            <p className="mt-3 border-t border-char-300 pt-2.5 text-sm text-char-600">
              Paid exactly — no change
            </p>
          </div>
        )}

        <PrintStatus state={print} />

        {result.warnings.length > 0 && (
          <ul className="mt-3 space-y-2 text-left">
            {result.warnings.map((warning) => (
              <li key={warning} className="sheet bg-brass-950 px-3 py-2 text-sm text-brass-100">
                {warning}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-6 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => (print.kind === "printed" ? setShowReceipt(true) : void flush())}
            disabled={print.kind === "sending"}
            className="touch-target key bg-char-800 font-semibold text-char-200 hover:bg-char-700 disabled:opacity-50"
          >
            {print.kind === "sending"
              ? "Printing…"
              : print.kind === "printed"
                ? "View receipt"
                : "Retry print"}
          </button>
          <button
            type="button"
            onClick={onNext}
            autoFocus
            className="touch-target key bg-brass-500 text-lg font-bold text-char-950 hover:bg-brass-400"
          >
            Next customer
          </button>
        </div>

        {receiptText && print.kind !== "printed" && print.kind !== "sending" && (
          <button
            type="button"
            onClick={() => setShowReceipt(true)}
            className="mt-3 text-sm text-char-400 underline hover:text-char-200"
          >
            Show the receipt on screen
          </button>
        )}

        <p className="mt-6 text-xs text-char-600">{shopName}</p>
      </div>

      {showReceipt && receiptText && (
        <ReceiptSheet text={receiptText} onClose={() => setShowReceipt(false)} onReprint={flush} />
      )}
    </main>
  );
}

function PrintStatus({ state }: { state: PrintState }) {
  const tones = {
    sending: "bg-char-900 text-char-300",
    printed: "bg-emerald-950 text-emerald-300",
    "no-printer": "bg-char-900 text-char-300",
    failed: "bg-brass-950 text-brass-100",
  } as const;

  const text =
    state.kind === "sending"
      ? "Sending the receipt to the printer…"
      : state.kind === "printed"
        ? `Receipt printed${state.count > 1 ? ` (${state.count} jobs cleared)` : ""}.`
        : state.detail;

  return <p className={`mt-3 sheet px-3 py-2 text-sm ${tones[state.kind]}`}>{text}</p>;
}

/**
 * The receipt exactly as the printer renders it, for a customer who wants to
 * see the weights and the arithmetic when no paper is coming out.
 *
 * Two completely different "print" buttons live here, because they go to two
 * completely different places:
 *
 *   Print again    resends the ESC/POS bytes to the configured thermal
 *                  printer adapter — NetworkPrinter or UsbPrinter, a raw
 *                  socket or USB port, nothing to do with the OS.
 *   Print / PDF    hands this same content to the BROWSER's own print
 *                  pipeline (`window.print()`) — the one behind File > Print,
 *                  which is also where "Save as PDF" lives on every desktop
 *                  OS. A shop with no thermal printer, or one that answers an
 *                  OS test page but not the till's socket, still has a paper
 *                  or PDF receipt through this path with no server-side PDF
 *                  library and no adapter at all.
 *
 * `.receipt-print-area` / `-sheet` / `-scroll` are hooked to the `@media
 * print` rules in globals.css so what prints is the receipt at full length,
 * not a screen-height scroll box with the rest of the page's chrome around it.
 */
function ReceiptSheet({
  text,
  onClose,
  onReprint,
}: {
  text: string;
  onClose: () => void;
  onReprint: () => void;
}) {
  return (
    <div className="receipt-print-area fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="receipt-print-sheet flex max-h-[90vh] w-full max-w-sm flex-col sheet bg-white shadow-2xl">
        <div className="receipt-print-scroll till-scroll min-h-0 flex-1 overflow-y-auto p-4">
          <pre className="receipt-paper text-char-900">{text}</pre>
        </div>
        <div className="no-print grid grid-cols-2 gap-2 border-t border-char-200 p-3">
          <button
            type="button"
            onClick={onReprint}
            className="touch-target key bg-char-100 font-semibold text-char-700 hover:bg-char-200"
          >
            Print again
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="touch-target key bg-char-100 font-semibold text-char-700 hover:bg-char-200"
          >
            Print / Save as PDF
          </button>
          <button
            type="button"
            onClick={onClose}
            className="touch-target key col-span-2 bg-brass-500 font-semibold text-char-950 hover:bg-brass-400"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * base64 ESC/POS to readable text, in the browser.
 *
 * `fromBase64` in the adapter uses Buffer, which the till does not have, so
 * the decode is done here with atob and handed to the shared renderer.
 */
function decodeReceipt(payload: string): string | null {
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return receiptToPlainText(bytes);
  } catch {
    return null;
  }
}
