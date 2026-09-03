"use client";

import { useActionState, useMemo, useState } from "react";
import { postBreakdown, type BreakdownState } from "./actions";
import { formatKg, kgToGrams } from "@/lib/weight";
import { formatCents } from "@/lib/money";

/**
 * The breakdown sheet.
 *
 * The running total at the bottom is the point of this screen: as the butcher
 * enters each cut, the loss figure moves. A breakdown that comes out at zero
 * loss means somebody estimated a weight instead of weighing it, and one at
 * 40% means the scale is wrong — both are worth seeing before posting, which
 * is why the numbers update live rather than after submission.
 */

interface SourceProduct {
  id: string;
  name: string;
  sku: string;
  costPerKg: number;
  stockGrams: number;
}

interface OutputProduct {
  id: string;
  name: string;
  sku: string;
  category: string;
  isByProduct: boolean;
}

interface Row {
  key: string;
  productId: string;
  weightKg: string;
}

const input = "h-10 w-full sheet border border-char-300 px-2 text-sm";

export function BreakdownForm({
  sources,
  outputs,
}: {
  sources: SourceProduct[];
  outputs: OutputProduct[];
}) {
  const [state, action, pending] = useActionState<BreakdownState, FormData>(postBreakdown, {});
  const [sourceId, setSourceId] = useState("");
  const [inputKg, setInputKg] = useState("");
  const [rows, setRows] = useState<Row[]>([
    { key: "r1", productId: "", weightKg: "" },
    { key: "r2", productId: "", weightKg: "" },
    { key: "r3", productId: "", weightKg: "" },
  ]);

  const source = sources.find((s) => s.id === sourceId);

  const { inputGrams, outputGrams, lossGrams, lossPercent } = useMemo(() => {
    const parse = (value: string) => {
      try {
        return value.trim() === "" ? 0 : kgToGrams(value);
      } catch {
        return 0;
      }
    };

    const inGrams = parse(inputKg);
    const outGrams = rows.reduce((total, row) => total + parse(row.weightKg), 0);
    const loss = inGrams - outGrams;

    return {
      inputGrams: inGrams,
      outputGrams: outGrams,
      lossGrams: loss,
      lossPercent: inGrams > 0 ? Math.round((loss / inGrams) * 1000) / 10 : 0,
    };
  }, [inputKg, rows]);

  const overweight = outputGrams > inputGrams && inputGrams > 0;

  const grouped = useMemo(() => {
    const map = new Map<string, OutputProduct[]>();
    for (const product of outputs) {
      const key = product.isByProduct ? "By-products" : product.category;
      map.set(key, [...(map.get(key) ?? []), product]);
    }
    return [...map.entries()];
  }, [outputs]);

  return (
    <form action={action} className="sheet border border-char-200 bg-char-50">
      <div className="grid grid-cols-1 gap-3 border-b border-char-200 p-4 md:grid-cols-4">
        <label className="block md:col-span-2">
          <span className="mb-1 block text-xs font-medium text-char-600">Carcass / bulk intake</span>
          <select
            name="sourceProductId"
            required
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            className={input}
          >
            <option value="">Choose…</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {formatKg(s.stockGrams)} kg on hand
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-char-600">Input weight (kg)</span>
          <input
            name="inputWeightKg"
            value={inputKg}
            onChange={(e) => setInputKg(e.target.value)}
            inputMode="decimal"
            placeholder="0.000"
            required
            className={`tabular ${input}`}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-char-600">
            Carcass cost (KSh)
          </span>
          <input
            name="inputCost"
            inputMode="decimal"
            placeholder={
              source && inputGrams > 0
                ? formatCents(Math.round((source.costPerKg * inputGrams) / 1000))
                : "0.00"
            }
            className={`tabular ${input}`}
          />
        </label>
      </div>

      <div className="p-4">
        <h3 className="mb-2 text-sm font-semibold text-char-800">Cuts off the block</h3>

        <div className="space-y-2">
          {rows.map((row, index) => (
            <div key={row.key} className="flex gap-2">
              <select
                name="outputProductId"
                value={row.productId}
                onChange={(e) =>
                  setRows((current) =>
                    current.map((r, i) => (i === index ? { ...r, productId: e.target.value } : r)),
                  )
                }
                className={`${input} flex-1`}
              >
                <option value="">Choose a cut…</option>
                {grouped.map(([group, items]) => (
                  <optgroup key={group} label={group}>
                    {items.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>

              <input
                name="outputWeightKg"
                value={row.weightKg}
                onChange={(e) =>
                  setRows((current) =>
                    current.map((r, i) => (i === index ? { ...r, weightKg: e.target.value } : r)),
                  )
                }
                inputMode="decimal"
                placeholder="0.000"
                aria-label="Weight in kilograms"
                className={`tabular ${input} w-32`}
              />

              <button
                type="button"
                onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                aria-label="Remove this cut"
                className="h-10 w-10 shrink-0 sheet text-char-400 hover:bg-char-100 hover:text-meat-700"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() =>
            setRows((current) => [
              ...current,
              { key: `r${Date.now()}`, productId: "", weightKg: "" },
            ])
          }
          className="mt-2 sheet px-3 py-2 text-sm font-medium text-meat-700 hover:bg-meat-50"
        >
          + Add another cut
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 border-t border-char-200 bg-char-50 p-4 md:grid-cols-4">
        <Figure label="Carcass in" value={`${formatKg(inputGrams)} kg`} />
        <Figure label="Cuts out" value={`${formatKg(outputGrams)} kg`} />
        <Figure
          label="Loss"
          value={`${formatKg(Math.max(0, lossGrams))} kg`}
          tone={overweight ? "bad" : lossPercent > 35 ? "warn" : "neutral"}
        />
        <Figure
          label="Loss %"
          value={`${Math.max(0, lossPercent).toFixed(1)}%`}
          tone={overweight ? "bad" : lossPercent > 35 ? "warn" : "neutral"}
        />
      </div>

      {overweight && (
        <p className="border-t border-meat-200 bg-meat-50 px-4 py-2 text-sm text-meat-800">
          The cuts weigh more than the carcass came in at. Check the scale before posting — meat
          cannot be created by cutting it up.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-char-200 p-4">
        <input
          name="supplier"
          placeholder="Supplier (optional)"
          className={`${input} max-w-xs`}
        />
        <input name="notes" placeholder="Notes (optional)" className={`${input} max-w-sm`} />

        <button
          type="submit"
          disabled={pending || overweight}
          className="h-10 sheet bg-brass-500 px-5 text-sm font-semibold text-white hover:bg-brass-400 disabled:opacity-50"
        >
          {pending ? "Posting…" : "Post breakdown"}
        </button>
      </div>

      {(state.error || state.success) && (
        <div className="border-t border-char-200 px-4 py-3">
          {state.error && <p className="text-sm text-meat-700">{state.error}</p>}
          {state.success && <p className="text-sm text-emerald-700">{state.success}</p>}
          {state.warnings?.map((warning) => (
            <p key={warning} className="mt-1 text-sm text-brass-700">
              {warning}
            </p>
          ))}
        </div>
      )}
    </form>
  );
}

function Figure({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "warn" | "bad";
}) {
  const tones = {
    neutral: "text-char-900",
    warn: "text-brass-700",
    bad: "text-meat-700",
  } as const;

  return (
    <div>
      <p className="text-xs font-medium text-char-500">{label}</p>
      <p className={`tabular text-xl font-semibold ${tones[tone]}`}>{value}</p>
    </div>
  );
}
