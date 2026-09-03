"use client";

import { useState } from "react";
import { Keypad } from "@/components/Keypad";
import { useDialogFocus } from "@/components/useDialogFocus";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "@/lib/pin";
import type { ManagerApproval } from "@/app/till/types";

/**
 * Manager approval at the till.
 *
 * The manager walks over and taps their own PIN; the cashier keeps the
 * session. Nothing is verified here — the PIN goes with the request and the
 * SERVER identifies who it belongs to and whether they may authorise this, so
 * skipping this dialog gets you a rejected request, not an approved discount.
 */
export function ManagerPinDialog({
  reason,
  onCancel,
  onSubmit,
}: {
  reason: string;
  onCancel: () => void;
  onSubmit: (approval: ManagerApproval) => void;
}) {
  const dialogRef = useDialogFocus<HTMLDivElement>();
  const [pin, setPin] = useState("");

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        data-keypad-layer
        role="dialog"
        aria-modal="true"
        aria-label="Manager approval"
        className="w-full max-w-sm sheet bg-char-900 p-5 shadow-2xl outline-none"
      >
        <h2 className="text-lg font-semibold text-bone">Manager approval needed</h2>
        <p className="mt-1 text-sm text-char-400">{reason}</p>

        <div className="mt-4 sheet bg-char-950 px-4 py-4 text-center">
          <span className="block text-[11px] text-char-400">
            Manager PIN
          </span>
          <span className="mt-2.5 flex h-8 items-center justify-center gap-2">
            {pin.length === 0 ? (
              <span className="text-sm text-char-600">Ask a manager to tap their PIN</span>
            ) : (
              Array.from({ length: pin.length }).map((_, i) => (
                <span key={i} className="h-3 w-3 rounded-full bg-amber-400" />
              ))
            )}
          </span>
        </div>

        <Keypad value={pin} onChange={setPin} maxLength={PIN_MAX_LENGTH} className="mt-3" />

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="touch-target key bg-char-800 font-semibold text-char-200 hover:bg-char-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={pin.length < PIN_MIN_LENGTH}
            onClick={() => onSubmit({ pin })}
            className="touch-target key bg-brass-500 font-semibold text-char-950 hover:bg-brass-400 disabled:bg-char-700 disabled:text-char-500"
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
