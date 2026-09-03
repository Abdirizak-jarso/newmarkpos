"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { login, type LoginState } from "./actions";
import { Keypad } from "@/components/Keypad";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from "@/lib/pin";

/**
 * The sign-in pad.
 *
 * One field. The cashier taps their PIN and the till knows who they are —
 * no staff code, no name to pick off a list. It is the fastest thing that can
 * happen at a counter, and it is why the PIN has to be unique per person.
 *
 * The PIN is masked: there is a queue of customers behind the cashier who can
 * see the screen.
 */
export function LoginPad({ terminalId }: { terminalId: string }) {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(login, {});
  const [pin, setPin] = useState("");
  const submitRef = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);

  // Clear the pad after a rejection so the next person is not correcting
  // somebody else's half-typed PIN.
  useEffect(() => {
    if (state.error) {
      setPin("");
      submitted.current = false;
    }
  }, [state.error]);

  const ready = pin.length >= PIN_MIN_LENGTH;

  return (
    <form
      action={formAction}
      data-keypad-layer
      className="sheet border border-char-800 bg-char-900 p-4"
    >
      <input type="hidden" name="pin" value={pin} />

      {/*
        The readout. Masked, because there is a queue behind the cashier who
        can see this screen — but lit, so they can count their own digits.
      */}
      <div className="sheet lit flex h-16 items-center justify-between px-4">
        <span className="flex items-center gap-2.5" aria-live="polite">
          {pin.length === 0 ? (
            <span className="text-sm text-char-500">Tap your PIN</span>
          ) : (
            Array.from({ length: pin.length }).map((_, i) => (
              <span key={i} className="h-3 w-3 rounded-full bg-char-950" />
            ))
          )}
        </span>
        <span className="readout text-sm text-char-500">
          {pin.length}/{PIN_MAX_LENGTH}
        </span>
      </div>

      <p className="mt-2 flex items-center justify-between text-xs text-char-500">
        <span>Till {terminalId}</span>
        <span>{PIN_MIN_LENGTH} digits or more</span>
      </p>

      {state.error && (
        <p
          role="alert"
          className="sheet mt-3 border-l-2 border-meat-500 bg-meat-950 px-3 py-2 text-sm text-meat-100"
        >
          {state.error}
        </p>
      )}

      <Keypad
        value={pin}
        onChange={(next) => {
          setPin(next);
          // A PIN long enough to be complete submits itself at the maximum
          // length; below that the cashier presses Sign in, because PINs are
          // allowed to be shorter than the maximum.
          if (next.length === PIN_MAX_LENGTH && !submitted.current) {
            submitted.current = true;
            queueMicrotask(() => submitRef.current?.click());
          }
        }}
        maxLength={PIN_MAX_LENGTH}
        className="mt-3"
      />

      <button
        ref={submitRef}
        type="submit"
        disabled={pending || !ready}
        className="key touch-target mt-3 w-full bg-brass-500 text-lg font-semibold text-char-950 hover:bg-brass-400 disabled:bg-char-800 disabled:text-char-600 disabled:shadow-none"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
