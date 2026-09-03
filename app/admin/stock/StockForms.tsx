"use client";

import { useActionState, useState } from "react";
import { adjust, count, intake, type StockState } from "./actions";
import { formatKg } from "@/lib/weight";

/**
 * The three ways stock legitimately moves outside a sale or a breakdown:
 * receiving it, correcting it, and counting it.
 *
 * A correction needs a manager PIN; receiving and counting do not, because
 * they add evidence rather than remove it — an intake is checked against a
 * delivery note and a count's variance is the number that gets scrutinised.
 */
export function StockForms({
  products,
  permissions,
}: {
  products: { id: string; name: string; sku: string; stockGrams: number }[];
  permissions: { intake: boolean; adjust: boolean; count: boolean };
}) {
  const tabs = [
    permissions.intake && { key: "INTAKE" as const, label: "Receive stock" },
    permissions.adjust && { key: "ADJUST" as const, label: "Adjust / write off" },
    permissions.count && { key: "COUNT" as const, label: "Stocktake" },
  ].filter(Boolean) as { key: "INTAKE" | "ADJUST" | "COUNT"; label: string }[];

  const [tab, setTab] = useState(tabs[0]?.key ?? "INTAKE");

  return (
    <section className="sheet border border-char-200 bg-char-50">
      <div className="flex gap-1 border-b border-char-200 p-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`sheet px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.key ? "bg-brass-500 text-white" : "text-char-600 hover:bg-char-100"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="p-4">
        {tab === "INTAKE" && <IntakeForm products={products} />}
        {tab === "ADJUST" && <AdjustForm products={products} />}
        {tab === "COUNT" && <CountForm products={products} />}
      </div>
    </section>
  );
}

function ProductSelect({ products, ...props }: { products: { id: string; name: string; sku: string }[] } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      name="productId"
      required
      className="h-10 w-full sheet border border-char-300 bg-char-50 px-2 text-sm"
      {...props}
    >
      <option value="">Choose a product…</option>
      {products.map((product) => (
        <option key={product.id} value={product.id}>
          {product.name} ({product.sku})
        </option>
      ))}
    </select>
  );
}

function Result({ state }: { state: StockState }) {
  if (state.error) return <p className="mt-2 text-sm text-meat-700">{state.error}</p>;
  if (state.success) return <p className="mt-2 text-sm text-emerald-700">{state.success}</p>;
  return null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-char-600">{label}</span>
      {children}
    </label>
  );
}

const input = "h-10 w-full sheet border border-char-300 px-2 text-sm";

function IntakeForm({ products }: { products: { id: string; name: string; sku: string }[] }) {
  const [state, action, pending] = useActionState<StockState, FormData>(intake, {});

  return (
    <form action={action} className="grid grid-cols-1 gap-3 md:grid-cols-5">
      <div className="md:col-span-2">
        <Field label="Product">
          <ProductSelect products={products} />
        </Field>
      </div>
      <Field label="Weight received (kg)">
        <input name="weightKg" inputMode="decimal" placeholder="0.000" required className={`tabular ${input}`} />
      </Field>
      <Field label="Cost per kg (KSh)">
        <input name="costPerKg" inputMode="decimal" placeholder="0.00" className={`tabular ${input}`} />
      </Field>
      <Field label="Supplier">
        <input name="supplier" placeholder="Optional" className={input} />
      </Field>

      <div className="md:col-span-5">
        <button
          type="submit"
          disabled={pending}
          className="h-10 sheet bg-brass-500 px-5 text-sm font-semibold text-white hover:bg-brass-400 disabled:opacity-50"
        >
          {pending ? "Receiving…" : "Receive stock"}
        </button>
        <Result state={state} />
      </div>
    </form>
  );
}

function AdjustForm({ products }: { products: { id: string; name: string; sku: string }[] }) {
  const [state, action, pending] = useActionState<StockState, FormData>(adjust, {});

  return (
    <form action={action} className="grid grid-cols-1 gap-3 md:grid-cols-6">
      <div className="md:col-span-2">
        <Field label="Product">
          <ProductSelect products={products} />
        </Field>
      </div>
      <Field label="Direction">
        <select name="direction" className={input} defaultValue="OUT">
          <option value="OUT">Take out</option>
          <option value="IN">Put back</option>
        </select>
      </Field>
      <Field label="Weight (kg)">
        <input name="weightKg" inputMode="decimal" placeholder="0.000" required className={`tabular ${input}`} />
      </Field>
      <Field label="Reason">
        <select name="reason" className={input} defaultValue="WASTE">
          <option value="WASTE">Waste / spoilage</option>
          <option value="ADJUSTMENT">Correction</option>
          <option value="STAFF_MEAT">Staff meat</option>
          <option value="TRANSFER">Transfer</option>
        </select>
      </Field>
      <Field label="Note (required)">
        <input name="note" placeholder="What happened" required className={input} />
      </Field>

      <div className="md:col-span-6">
        <Field label="Manager PIN">
          <input
            name="pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder="A manager taps their PIN to authorise this"
            required
            className={input}
          />
        </Field>
      </div>

      <div className="md:col-span-6">
        <button
          type="submit"
          disabled={pending}
          className="h-10 sheet bg-brass-500 px-5 text-sm font-semibold text-white hover:bg-brass-500 disabled:opacity-50"
        >
          {pending ? "Adjusting…" : "Adjust stock"}
        </button>
        <Result state={state} />
      </div>
    </form>
  );
}

function CountForm({ products }: { products: { id: string; name: string; sku: string; stockGrams: number }[] }) {
  const [state, action, pending] = useActionState<StockState, FormData>(count, {});
  const [productId, setProductId] = useState("");

  const selected = products.find((p) => p.id === productId);

  return (
    <form action={action} className="grid grid-cols-1 gap-3 md:grid-cols-4">
      <div className="md:col-span-2">
        <Field label="Product">
          <ProductSelect
            products={products}
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Counted weight (kg)">
        <input name="countedKg" inputMode="decimal" placeholder="0.000" required className={`tabular ${input}`} />
      </Field>
      <Field label="Note">
        <input name="note" placeholder="Optional" className={input} />
      </Field>

      <div className="md:col-span-4">
        {selected && (
          <p className="mb-2 text-sm text-char-600">
            System says{" "}
            <span className="tabular font-semibold">{formatKg(selected.stockGrams)} kg</span>. The
            difference is recorded as its own movement, so the variance stays visible.
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="h-10 sheet bg-char-800 px-5 text-sm font-semibold text-white hover:bg-char-700 disabled:opacity-50"
        >
          {pending ? "Recording…" : "Record count"}
        </button>
        <Result state={state} />
      </div>
    </form>
  );
}
