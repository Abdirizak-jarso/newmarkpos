"use client";

import { useEffect, useRef } from "react";
import { isTypingField, padShouldHandle } from "@/lib/keyboard";

/**
 * The numeric pad.
 *
 * One component for PINs, weights and money, because a cashier should not have
 * to learn three layouts. `decimal` adds a point for weight and amount entry;
 * PIN entry leaves it off so a stray tap cannot make a PIN unenterable.
 *
 * It also accepts the keyboard. The counter till is a touch screen, but it is
 * set up, trained on and tested with a keyboard attached, and a cashier who
 * has one will use it — typing "0.5" has to work as well as tapping it.
 */

/**
 * Only the most recently mounted pad listens to the keyboard, so a dialog
 * opening over the till takes the keys with it instead of both pads reacting
 * to the same press.
 */
const stack: symbol[] = [];

export function Keypad({
  value,
  onChange,
  maxLength = 12,
  decimal = false,
  onEnter,
  captureKeyboard = true,
  className = "",
}: {
  value: string;
  onChange: (next: string) => void;
  maxLength?: number;
  decimal?: boolean;
  onEnter?: () => void;
  /** Set false for a pad that is on screen but not the one being typed into. */
  captureKeyboard?: boolean;
  className?: string;
}) {
  const press = (key: string) => {
    if (key === "back") {
      onChange(value.slice(0, -1));
      return;
    }
    if (key === "clear") {
      onChange("");
      return;
    }
    if (key === ".") {
      // A second point would make the number unparseable, and a leading point
      // is what someone means by ".5" — allow that, silently prefix the zero.
      if (value.includes(".")) return;
      onChange(value === "" ? "0." : `${value}.`);
      return;
    }
    if (value.length >= maxLength) return;
    // Stop "007" happening from a double tap on a fresh field.
    if (value === "0" && key !== ".") {
      onChange(key);
      return;
    }
    onChange(value + key);
  };

  // Used to work out which layer this pad is in, so it can tell an input it
  // sits beside from one stranded behind it.
  const rootRef = useRef<HTMLDivElement>(null);

  // `press` closes over the current value, so the listener needs the latest one
  // rather than the one from the render that attached it.
  const pressRef = useRef(press);
  pressRef.current = press;
  const enterRef = useRef(onEnter);
  enterRef.current = onEnter;

  useEffect(() => {
    if (!captureKeyboard) return;

    const id = Symbol("keypad");
    stack.push(id);

    const onKeyDown = (event: KeyboardEvent) => {
      // Not the active pad — a dialog is open over this one.
      if (stack[stack.length - 1] !== id) return;

      if (event.ctrlKey || event.metaKey || event.altKey) return;

      // Whose keystroke is this? See lib/keyboard.ts — a field beside the pad
      // keeps its own keys, a field stranded on the screen behind it does not.
      const target = event.target as HTMLElement | null;
      if (target) {
        const layer = rootRef.current?.closest("[data-keypad-layer]");
        const descriptor = {
          tagName: target.tagName,
          isContentEditable: target.isContentEditable,
          inPadLayer: Boolean(layer?.contains(target)),
        };
        if (!padShouldHandle(descriptor)) return;
        // It is behind us. Take the keyboard off it so the rest of the sale is
        // typed at the pad rather than into a field nobody can see.
        if (isTypingField(descriptor)) target.blur();
      }

      if (event.key >= "0" && event.key <= "9") {
        pressRef.current(event.key);
      } else if (decimal && (event.key === "." || event.key === ",")) {
        // Some keyboards put a comma on the numeric pad; a cashier pressing it
        // means a decimal point.
        pressRef.current(".");
      } else if (event.key === "Backspace") {
        pressRef.current("back");
      } else if (event.key === "Delete" || event.key === "Escape") {
        pressRef.current("clear");
      } else if (event.key === "Enter" && enterRef.current) {
        enterRef.current();
      } else {
        return;
      }

      // Only reached when the key was one we handled, so ordinary shortcuts
      // and tabbing still work.
      event.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const at = stack.lastIndexOf(id);
      if (at !== -1) stack.splice(at, 1);
    };
  }, [captureKeyboard, decimal]);

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", decimal ? "." : "clear", "0", "back"];

  return (
    <div ref={rootRef} className={`grid grid-cols-3 gap-2 ${className}`}>
      {keys.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => press(key)}
          aria-label={key === "back" ? "Backspace" : key === "clear" ? "Clear" : key}
          className={`key touch-target readout text-xl font-medium ${
            key === "back" || key === "clear"
              ? "bg-char-800 text-char-300 hover:bg-char-700"
              : "bg-char-700 text-bone hover:bg-char-600"
          }`}
        >
          {key === "back" ? "⌫" : key === "clear" ? "C" : key}
        </button>
      ))}
      {onEnter && (
        <button
          type="button"
          onClick={onEnter}
          className="key touch-target col-span-3 bg-brass-500 text-lg font-semibold text-char-950 hover:bg-brass-400"
        >
          Enter
        </button>
      )}
    </div>
  );
}
