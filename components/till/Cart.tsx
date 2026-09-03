"use client";

import { useState } from "react";
import { formatCents } from "@/lib/money";
import { formatKg } from "@/lib/weight";
import type { SaleTotals } from "@/lib/pricing";
import type { TillLine, TillProduct } from "@/app/till/types";

/**
 * The basket.
 *
 * Weights show three decimals and prices show two, both in tabular figures, so
 * a cashier scanning the column can see at a glance that 1.235 is not 1.35 —
 * which at KSh 1,800/kg is a KSh 200 mistake.
 */
export function Cart({
  lines,
  totals,
  productsById,
  onEdit,
  onRemove,
  onDiscount,
  onClear,
  onPay,
  payDisabled,
}: {
  lines: TillLine[];
  totals: SaleTotals | null;
  productsById: Map<string, TillProduct>;
  onEdit: (lineId: string) => void;
  onRemove: (lineId: string) => void;
  onDiscount: (lineId: string, discount: TillLine["discount"]) => void;
  onClear: () => void;
  onPay: () => void;
  payDisabled: boolean;
}) {
  const [discountFor, setDiscountFor] = useState<string | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-baseline justify-between border-b border-char-800 px-4 py-3">
        <h2 className="text-sm font-medium text-char-200">
          {lines.length === 0
            ? "This sale"
            : `This sale — ${lines.length} ${lines.length === 1 ? "line" : "lines"}`}
        </h2>
        {lines.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="sheet px-2.5 py-1.5 text-xs text-char-400 hover:bg-char-800 hover:text-meat-300"
          >
            Clear all
          </button>
        )}
      </header>

      <div className="till-scroll min-h-0 flex-1 overflow-y-auto">
        {lines.length === 0 ? (
          <p className="px-6 py-16 text-center text-sm text-char-500">
            Pick a cut to start. Weigh it, or type the shillings the customer asked for.
          </p>
        ) : (
          <ul className="divide-y divide-char-800">
            {lines.map((line) => {
              const product = productsById.get(line.productId);
              const priced = totals?.lines.find((l) => l.lineId === line.lineId);
              if (!product) return null;

              return (
                <li key={line.lineId} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => onEdit(line.lineId)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className="truncate text-sm font-medium text-bone">{product.name}</p>
                      {/* The rate the cashier typed, not the board's — this
                          line has to read back as what the customer was told. */}
                      <p className="tabular mt-0.5 text-xs text-char-400">
                        {product.pricingMode === "PER_KG"
                          ? `${formatKg(line.weightGrams ?? 0)} kg × ${formatCents(priced?.unitPrice ?? line.unitPriceOverride ?? product.price)}/kg`
                          : `${line.quantity ?? 0} × ${formatCents(priced?.unitPrice ?? line.unitPriceOverride ?? product.price)}`}
                      </p>
                      {line.requestedAmount !== undefined && (
                        <p className="mt-0.5 text-[11px] text-char-500">
                          Cut to order · {formatCents(line.requestedAmount, { symbol: true })}
                        </p>
                      )}
                      {/* Only shown when the typed rate went BELOW the board.
                          Above it needs no explanation and no colour — the
                          shop charging its own price is not an exception. */}
                      {priced && priced.priceOverride < 0 && (
                        <p className="mt-0.5 text-[11px] text-brass-300">
                          {formatCents(-priced.priceOverride)} under the board price of{" "}
                          {formatCents(priced.catalogueUnitPrice)}
                        </p>
                      )}
                      {priced && priced.discount > 0 && (
                        <p className="mt-0.5 text-[11px] text-brass-300">
                          Discount −{formatCents(priced.discount)}
                        </p>
                      )}
                    </button>

                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="tabular text-sm font-semibold text-bone">
                        {formatCents(priced?.net ?? 0)}
                      </span>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() =>
                            setDiscountFor(discountFor === line.lineId ? null : line.lineId)
                          }
                          aria-label="Discount this line"
                          className="sheet px-2 py-1 text-[11px] text-char-400 hover:bg-char-800 hover:text-brass-300"
                        >
                          %
                        </button>
                        <button
                          type="button"
                          onClick={() => onRemove(line.lineId)}
                          aria-label="Remove this line"
                          className="sheet px-2 py-1 text-[11px] text-char-400 hover:bg-char-800 hover:text-meat-300"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  </div>

                  {discountFor === line.lineId && (
                    <div className="mt-2 flex gap-1.5">
                      {[5, 10, 15].map((percent) => (
                        <button
                          key={percent}
                          type="button"
                          onClick={() => {
                            onDiscount(line.lineId, { kind: "PERCENT", value: percent });
                            setDiscountFor(null);
                          }}
                          className="key flex-1 bg-char-800 py-2 text-xs font-semibold text-char-200 hover:bg-brass-800 hover:text-brass-100"
                        >
                          {percent}%
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => {
                          onDiscount(line.lineId, undefined);
                          setDiscountFor(null);
                        }}
                        className="key flex-1 bg-char-800 py-2 text-xs font-semibold text-char-300 hover:bg-char-700"
                      >
                        None
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="shrink-0 border-t border-char-800 p-4">
        {totals && (
          <dl className="mb-3 space-y-1.5 text-sm">
            <Row label="Subtotal" value={formatCents(totals.gross)} />
            {totals.discount > 0 && (
              <Row label="Discount" value={`−${formatCents(totals.discount)}`} tone="brass" />
            )}
            {totals.roundingAdjustment !== 0 && (
              <Row label="Cash rounding" value={formatCents(totals.roundingAdjustment)} />
            )}
            {totals.totalWeightGrams > 0 && (
              <Row label="On the scale" value={`${formatKg(totals.totalWeightGrams)} kg`} />
            )}
          </dl>
        )}

        {/*
          The readout. Both the cashier and the customer read this figure, so it
          is the only lit thing on the till and it is set in the wide cut a
          weighing machine uses. The unit sits with the number, not in a label
          above it.
        */}
        <div className="sheet lit mb-3 flex items-baseline justify-between px-4 py-3">
          <span className="readout text-base font-medium text-char-500">KSh</span>
          <span className="readout text-[2.75rem] font-bold leading-none text-meat-700">
            {totals ? formatCents(totals.total) : "0.00"}
          </span>
        </div>

        <button
          type="button"
          onClick={onPay}
          disabled={payDisabled}
          className="key touch-target w-full bg-brass-500 text-lg font-semibold text-char-950 hover:bg-brass-400 disabled:bg-char-800 disabled:text-char-600 disabled:shadow-none"
        >
          Take payment
        </button>
      </footer>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "brass" }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-char-400">{label}</dt>
      <dd className={`tabular ${tone === "brass" ? "text-brass-300" : "text-char-200"}`}>{value}</dd>
    </div>
  );
}
