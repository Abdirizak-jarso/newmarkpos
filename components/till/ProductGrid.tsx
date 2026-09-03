"use client";

import { useMemo, useState } from "react";
import { formatKg } from "@/lib/weight";
import type { TillCategory, TillProduct } from "@/app/till/types";

/**
 * The product grid.
 *
 * Cashiers find things by shape and position, not by reading — so categories
 * are colour-coded, the grid order is stable, and a product never moves
 * because it happened to sell well this morning. Search is there for the long
 * tail (a customer asking for ossobuco by name), not as the primary path.
 *
 * No prices. A tile names a cut and says how it sells — by the kilo, each, or
 * by the pack — and the price is typed on the entry pad, at the counter, with
 * the customer standing there. Putting a figure here would be quoting a price
 * nobody has agreed to yet, and a cashier who half-reads a tile they have seen
 * ten thousand times is exactly how the wrong one gets charged.
 */
export function ProductGrid({
  products,
  categories,
  lowStockGrams,
  onSelect,
}: {
  products: TillProduct[];
  categories: TillCategory[];
  lowStockGrams: number;
  onSelect: (product: TillProduct) => void;
}) {
  const [categoryId, setCategoryId] = useState<string | "ALL">("ALL");
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return products.filter((product) => {
      if (categoryId !== "ALL" && product.categoryId !== categoryId) return false;
      if (needle === "") return true;
      return (
        product.name.toLowerCase().includes(needle) || product.sku.toLowerCase().includes(needle)
      );
    });
  }, [products, categoryId, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-char-800 p-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a cut or a code"
          className="sheet h-11 flex-1 border border-char-700 bg-char-950 px-4 text-sm text-bone placeholder:text-char-500 focus:border-brass-500 focus:outline-none"
        />
        {query !== "" && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="key h-11 bg-char-800 px-4 text-sm text-char-300 hover:bg-char-700"
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-char-800 p-3">
        <CategoryChip
          label="All"
          active={categoryId === "ALL"}
          onClick={() => setCategoryId("ALL")}
        />
        {categories.map((category) => (
          <CategoryChip
            key={category.id}
            label={category.name}
            colour={category.colour}
            active={categoryId === category.id}
            onClick={() => setCategoryId(category.id)}
          />
        ))}
      </div>

      <div className="till-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {visible.length === 0 ? (
          <p className="py-16 text-center text-sm text-char-500">
            Nothing matches “{query}”.
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2.5">
            {visible.map((product) => (
              <ProductButton
                key={product.id}
                product={product}
                colour={categories.find((c) => c.id === product.categoryId)?.colour}
                lowStockGrams={lowStockGrams}
                onClick={() => onSelect(product)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CategoryChip({
  label,
  colour,
  active,
  onClick,
}: {
  label: string;
  colour?: string | null;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`key flex h-11 shrink-0 items-center gap-2 px-4 text-sm font-medium ${
        active ? "bg-char-700 text-bone" : "bg-char-800/60 text-char-400 hover:bg-char-800"
      }`}
    >
      <span
        className="h-1.5 w-1.5 shrink-0"
        style={{ backgroundColor: colour ?? "var(--color-char-500)" }}
        aria-hidden
      />
      {label}
    </button>
  );
}

function ProductButton({
  product,
  colour,
  lowStockGrams,
  onClick,
}: {
  product: TillProduct;
  colour?: string | null;
  lowStockGrams: number;
  onClick: () => void;
}) {
  const low = product.stockGrams <= lowStockGrams;
  const out = product.stockGrams <= 0;

  // How it sells, not what it costs — this is what tells the cashier whether
  // the pad is about to ask them for a weight or a count.
  const unitLabel =
    product.pricingMode === "PER_KG"
      ? "By the kilo"
      : product.pricingMode === "PER_PIECE"
        ? "Each"
        : "By the pack";

  return (
    <button
      type="button"
      onClick={onClick}
      className="key touch-target relative flex flex-col justify-between overflow-hidden border border-char-700 bg-char-900 py-3 pl-4 pr-3 text-left hover:border-char-600 hover:bg-char-800"
    >
      <span
        className="absolute inset-y-0 left-0 w-1.5"
        style={{ backgroundColor: colour ?? "var(--color-char-600)" }}
        aria-hidden
      />

      <span className="line-clamp-2 text-sm font-medium leading-snug text-bone">
        {product.name}
      </span>

      <span className="mt-2 flex items-end justify-between gap-2">
        <span className="text-xs font-medium text-char-400">{unitLabel}</span>
        {/* Stock is shown, never used to block a sale: the meat is physically
            in the case whatever the number says, and a cashier arguing with a
            screen in front of a customer is worse than a negative balance. */}
        <span
          className={`tabular text-[11px] ${
            out ? "text-meat-400" : low ? "text-brass-400" : "text-char-500"
          }`}
        >
          {formatKg(product.stockGrams)} kg
        </span>
      </span>
    </button>
  );
}
