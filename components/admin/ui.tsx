import type { ReactNode } from "react";
import { formatCents } from "@/lib/money";

/** Shared back-office furniture, so every page reads the same way. */

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-char-200 bg-char-50 px-8 py-5">
      <div>
        <h1 className="wide text-xl font-semibold text-char-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-char-500">{description}</p>}
      </div>
      {action}
    </header>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const tones = {
    neutral: "text-char-900",
    good: "text-emerald-700",
    warn: "text-brass-700",
    bad: "text-meat-700",
  } as const;

  return (
    <div className="sheet border border-char-200 bg-char-50 p-4">
      <p className={`readout text-3xl font-bold leading-none ${tones[tone]}`}>{value}</p>
      <p className="mt-2 text-sm text-char-600">{label}</p>
      {hint && <p className="mt-0.5 text-xs text-char-500">{hint}</p>}
    </div>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="sheet border border-char-200 bg-char-50">
      {title && (
        <h2 className="border-b border-char-200 px-4 py-3 text-sm font-semibold text-char-800">
          {title}
        </h2>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Table({
  headers,
  children,
  empty,
}: {
  headers: string[];
  children: ReactNode;
  empty?: string;
}) {
  const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children);

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-full text-sm">
        <thead>
          <tr className="border-b border-char-200 text-left">
            {headers.map((header, i) => (
              <th
                key={header}
                className={`px-3 py-2 text-xs font-medium text-char-500 ${
                  i > 0 && i === headers.length - 1 ? "text-right" : ""
                }`}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-char-100">
          {hasRows ? (
            children
          ) : (
            <tr>
              <td colSpan={headers.length} className="px-3 py-8 text-center text-char-500">
                {empty ?? "Nothing to show yet."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Money({ cents, bold = false }: { cents: number; bold?: boolean }) {
  return (
    <span
      className={`tabular ${bold ? "font-semibold" : ""} ${cents < 0 ? "text-meat-700" : "text-char-900"}`}
    >
      {formatCents(cents)}
    </span>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  const tones = {
    neutral: "border-char-300 text-char-700",
    good: "border-emerald-500 text-emerald-800",
    warn: "border-brass-500 text-brass-800",
    bad: "border-meat-500 text-meat-700",
  } as const;

  // Marked with a rule down one edge, the way a ledger is annotated, rather
  // than a filled pill.
  return (
    <span className={`border-l-2 pl-2 text-xs font-medium ${tones[tone]}`}>{children}</span>
  );
}
