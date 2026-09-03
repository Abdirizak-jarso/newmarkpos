/**
 * Who gets the keystroke — the pure half.
 *
 * The till's number pads listen on the window rather than on a focused field,
 * because the cashier is tapping a touch screen and nothing is focused most of
 * the time. That means a pad has to decide, on every key, whether the keystroke
 * was really meant for it or for a text field somebody is typing into.
 *
 * The rule is about LAYERS, not about focus. A field sitting beside a pad — the
 * M-Pesa transaction code next to the amount pad — must keep its own keystrokes.
 * A field on the screen behind a pad must not: the cashier cannot see it, so
 * every digit they type would vanish into it and the pad would look broken.
 * That is exactly what used to happen when the product search kept focus and an
 * entry pad opened over the top of it.
 */

/** The parts of the focused element the decision actually turns on. */
export type KeyTarget = {
  /** Uppercase tag name, as the DOM reports it. */
  tagName: string;
  isContentEditable: boolean;
  /** True when the element is inside the same layer as the pad — a dialog, or
   *  the payment panel — rather than on a screen behind it. */
  inPadLayer: boolean;
};

const TYPING_TAGS = /^(INPUT|TEXTAREA|SELECT)$/;

/** Is this element something a person types words into? */
export function isTypingField(target: KeyTarget): boolean {
  return TYPING_TAGS.test(target.tagName) || target.isContentEditable;
}

/**
 * Should the pad act on a keystroke aimed at `target`?
 *
 * Nothing focused (or focus on the body, a button, the dialog itself) means the
 * pad takes it. A typing field takes it only when it shares the pad's layer.
 */
export function padShouldHandle(target: KeyTarget | null): boolean {
  if (!target) return true;
  if (!isTypingField(target)) return true;
  return !target.inPadLayer;
}
