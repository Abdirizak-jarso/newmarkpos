"use client";

import { useActionState, useState } from "react";
import { changePrice, type ActionState } from "./actions";
import { centsToShillings, formatCents } from "@/lib/money";

/**
 * Inline price change with the manager PIN attached.
 *
 * The price is typed in shillings because that is how the shop thinks about
 * it, and converted to cents at the boundary — the number that leaves this
 * component is always integer cents.
 */
export function PriceEditor({
  productId,
  name,
  price,
}: {
  productId: string;
  name: string;
  price: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(changePrice, {});
  const [shillings, setShillings] = useState(String(centsToShillings(price)));

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="tabular sheet px-2 py-1 font-semibold text-char-900 hover:bg-char-100"
      >
        {formatCents(price)}
      </button>
    );
  }

  return (
    <form action={formAction} className="inline-block text-left">
      <input type="hidden" name="productId" value={productId} />
      <input
        type="hidden"
        name="price"
        value={Math.round(Number(shillings.replace(/,/g, "") || 0) * 100)}
      />

      <div className="w-64 sheet border border-char-300 bg-char-50 p-3 shadow-lg">
        <p className="mb-2 text-xs font-medium text-char-700">New price for {name}</p>

        <input
          value={shillings}
          onChange={(e) => setShillings(e.target.value)}
          inputMode="decimal"
          aria-label="Price in shillings"
          className="tabular mb-2 h-9 w-full sheet border border-char-300 px-2 text-sm"
        />
        <input
          name="reason"
          placeholder="Reason (optional)"
          className="mb-2 h-9 w-full sheet border border-char-300 px-2 text-sm"
        />

        <p className="mb-1 text-[11px] text-char-500">Manager approval</p>
        <input
          name="pin"
          type="password"
          placeholder="Manager PIN"
          inputMode="numeric"
          autoComplete="off"
          className="mb-2 h-9 w-full sheet border border-char-300 px-2 text-sm"
        />

        {state.error && <p className="mb-2 text-xs text-meat-700">{state.error}</p>}
        {state.success && <p className="mb-2 text-xs text-emerald-700">{state.success}</p>}

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="h-9 sheet bg-char-100 text-sm font-medium text-char-700 hover:bg-char-200"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="h-9 sheet bg-brass-500 text-sm font-semibold text-white hover:bg-brass-400 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </form>
  );
}
