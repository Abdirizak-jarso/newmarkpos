import { formatCents } from "@/lib/money";
import { formatKg } from "@/lib/weight";
import { Card } from "@/components/admin/ui";
import type { CarcassLedgerEntry } from "@/lib/services/reports";

/**
 * Did the animal earn its keep?
 *
 * One card per carcass, reading top to bottom the way the money actually moved:
 * what it cost, what the cuts were worth on the board, what came back over the
 * counter, and what is still hanging in the case. The bar underneath is the
 * whole story in one line, which is the only bit most people will read.
 */
export function CarcassLedger({ entries }: { entries: CarcassLedgerEntry[] }) {
  if (entries.length === 0) {
    return (
      <Card title="Carcass ledger">
        <p className="py-6 text-center text-sm text-char-500">
          No carcasses broken down in this period.
        </p>
      </Card>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="wide text-lg font-semibold text-char-900">Carcass ledger</h2>
        <p className="text-xs text-char-500">
          Sales attributed by time, from each breakdown to the next of the same animal
        </p>
      </div>

      {entries.map((entry) => (
        <CarcassCard key={entry.breakdownId} entry={entry} />
      ))}
    </section>
  );
}

function CarcassCard({ entry }: { entry: CarcassLedgerEntry }) {
  const uncosted = entry.costIn === 0;
  const stillOut = Math.max(0, entry.costIn - entry.sold);

  return (
    <article className="sheet border border-char-200 bg-char-50">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-char-200 px-4 py-3">
        <h3 className="wide text-base font-semibold text-char-900">{entry.sourceName}</h3>
        <p className="text-xs text-char-500">
          {formatKg(entry.inputWeightGrams)} kg in,{" "}
          {formatKg(entry.outputWeightGrams)} kg of cuts, {entry.lossPercent}% lost to trim
          {entry.supplier ? ` · ${entry.supplier}` : ""}
          {" · "}
          {entry.brokenDownAt.toLocaleDateString("en-KE", { day: "2-digit", month: "short" })}
        </p>
      </header>

      <div className="grid gap-x-8 gap-y-4 p-4 md:grid-cols-2">
        <dl className="space-y-1.5 text-sm">
          <Line label="Cost of the animal" value={formatCents(entry.costIn)} />
          <Line label="Cuts at board price" value={formatCents(entry.boardValue)} muted />

          <div className="!mt-3 border-t border-char-200 pt-2.5">
            <Line label="Sold so far" value={formatCents(entry.sold)} strong />
            {entry.givenAway > 0 && (
              <Line
                label="given away at the counter"
                value={`−${formatCents(entry.givenAway)}`}
                indent
                tone="brass"
              />
            )}
            <Line
              label="still in the case"
              value={formatCents(entry.onHandValue)}
              indent
              muted
            />
          </div>
        </dl>

        <div>
          {uncosted ? (
            <p className="text-sm text-char-500">
              No cost was recorded for this carcass, so there is nothing to measure the sales
              against. Enter what it cost on the breakdown to see whether it paid.
            </p>
          ) : (
            <>
              <RecoveryBar entry={entry} />
              <p className="mt-3 text-sm leading-relaxed text-char-600">
                {entry.sold >= entry.costIn ? (
                  <>
                    Paid for itself and made{" "}
                    <strong className="text-emerald-800">{formatCents(entry.realised)}</strong> so
                    far, with {formatCents(entry.onHandValue)} of cuts still to sell.
                  </>
                ) : (
                  <>
                    <strong className="text-char-900">{formatCents(stillOut)}</strong> of its cost
                    is still out there — {formatCents(entry.onHandValue)} of it hanging in the
                    case at board price.
                  </>
                )}
              </p>
            </>
          )}
        </div>
      </div>

      <details className="border-t border-char-200">
        <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium text-char-600 hover:bg-char-100">
          What came off it — {entry.outputs.length} cuts
        </summary>
        <div className="overflow-x-auto px-4 pb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-char-200 text-left">
                <th className="py-2 pr-3 text-xs font-medium text-char-500">Cut</th>
                <th className="py-2 pr-3 text-xs font-medium text-char-500">Weight</th>
                <th className="py-2 pr-3 text-xs font-medium text-char-500">Yield</th>
                <th className="py-2 pr-3 text-right text-xs font-medium text-char-500">Cost/kg</th>
                <th className="py-2 text-right text-xs font-medium text-char-500">Board/kg</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-char-100">
              {entry.outputs.map((output) => {
                // Where the shrinkage landed: a cut costing more than it sells
                // for is one the breakdown loaded too heavily, or one the board
                // has underpriced.
                const underwater =
                  output.costPerKg > 0 && output.costPerKg >= output.boardPricePerKg;
                return (
                  <tr key={output.sku}>
                    <td className="py-2 pr-3 text-char-900">
                      {output.name}
                      {output.isByProduct && (
                        <span className="ml-2 text-xs text-char-500">by-product</span>
                      )}
                    </td>
                    <td className="tabular py-2 pr-3 text-char-600">
                      {formatKg(output.weightGrams)} kg
                    </td>
                    <td className="tabular py-2 pr-3 text-char-600">{output.yieldPercent}%</td>
                    <td className="tabular py-2 pr-3 text-right text-char-600">
                      {formatCents(output.costPerKg)}
                    </td>
                    <td
                      className={`tabular py-2 text-right ${
                        underwater ? "font-semibold text-meat-700" : "text-char-900"
                      }`}
                    >
                      {formatCents(output.boardPricePerKg)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </article>
  );
}

/**
 * How much of the carcass's cost has come back, and how much is still riding on
 * the meat in the case. Capped at 100% so a profitable carcass does not draw a
 * bar off the end of the card; the figure beside it carries the overshoot.
 */
function RecoveryBar({ entry }: { entry: CarcassLedgerEntry }) {
  const recovered = Math.min(100, entry.recoveredPercent);
  const paidBack = entry.sold >= entry.costIn;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-char-500">Cost recovered</span>
        <span
          className={`readout text-2xl font-bold ${
            paidBack ? "text-emerald-700" : "text-char-900"
          }`}
        >
          {entry.recoveredPercent}%
        </span>
      </div>
      <div
        className="mt-1.5 h-2.5 w-full overflow-hidden bg-char-200"
        role="img"
        aria-label={`${entry.recoveredPercent}% of the carcass cost recovered`}
      >
        <div
          className={`h-full ${paidBack ? "bg-emerald-600" : "bg-brass-500"}`}
          style={{ width: `${recovered}%` }}
        />
      </div>
    </div>
  );
}

function Line({
  label,
  value,
  strong,
  muted,
  indent,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
  indent?: boolean;
  tone?: "brass";
}) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${indent ? "pl-3" : ""}`}>
      <dt className={muted ? "text-char-500" : "text-char-700"}>{label}</dt>
      <dd
        className={`tabular ${
          tone === "brass"
            ? "text-brass-700"
            : strong
              ? "font-semibold text-char-900"
              : muted
                ? "text-char-500"
                : "text-char-900"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
