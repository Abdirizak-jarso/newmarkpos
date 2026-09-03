"use client";

import { useEffect, useRef } from "react";

/**
 * Moves focus into a dialog when it opens and puts it back when it closes.
 *
 * The pads read the keyboard from a window listener and deliberately ignore
 * keystrokes aimed at a real input, so that the M-Pesa code typed beside a pad
 * does not also land on it. Without this hook the product search box keeps
 * focus underneath the modal that just opened over it: every digit the cashier
 * types goes into a field they cannot see, the pad stays empty, and the
 * keyboard looks broken.
 *
 * Attach the returned ref to the dialog's panel — the element with the border
 * around it, not the backdrop — and give that element `tabIndex={-1}` so it can
 * hold focus itself until the cashier tabs or taps somewhere inside it.
 */
export function useDialogFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    // Where the keyboard was before we took it, so closing the dialog does not
    // strand focus on the body and leave the next keystroke going nowhere.
    const restoreTo = document.activeElement as HTMLElement | null;

    const node = ref.current;
    node?.focus({ preventScroll: true });

    return () => {
      if (restoreTo && restoreTo.isConnected) restoreTo.focus({ preventScroll: true });
    };
  }, []);

  return ref;
}
