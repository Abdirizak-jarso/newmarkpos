import { requirePagePermission, getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { carcassLedger, marginReport, salesSummary, yieldReport } from "@/lib/services/reports";
import { CarcassLedger } from "./CarcassLedger";
import { formatCents } from "@/lib/money";
import { formatKg } from "@/lib/weight";
import { Card, Money, PageHeader, StatCard, Table } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

/** Ranges the owner actually asks for, rather than a date picker nobody uses. */
const RANGES = {
  today: { label: "Today", days: 0 },
  week: { label: "Last 7 days", days: 7 },
  month: { label: "Last 30 days", days: 30 },
  quarter: { label: "Last 90 days", days: 90 },
} as const;

type RangeKey = keyof typeof RANGES;

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requirePagePermission("report.sales");
  const user = await getCurrentUser();
  const mayMargin = user ? can(user.role, "report.margin") : false;

  const params = await searchParams;
  const rangeKey: RangeKey =
    params.range && params.range in RANGES ? (params.range as RangeKey) : "week";
  const range = RANGES[rangeKey];

  const to = new Date();
  to.setHours(23, 59, 59, 999);
  const from = new Date();
  from.setDate(from.getDate() - range.days);
  from.setHours(0, 0, 0, 0);

  const [summary, margins, yields, carcasses] = await Promise.all([
    salesSummary(from, to),
    mayMargin ? marginReport(from, to) : Promise.resolve([]),
    yieldReport(from, to),
    // The ledger puts a cost against the meat, so it is a margin view.
    mayMargin ? carcassLedger(from, to) : Promise.resolve([]),
  ]);

  return (
    <>
      <PageHeader
        title="Reports"
        description={`${from.toLocaleDateString("en-KE")} to ${to.toLocaleDateString("en-KE")}`}
        action={
          <nav className="flex gap-1 sheet bg-char-100 p-1">
            {(Object.keys(RANGES) as RangeKey[]).map((key) => (
              <a
                key={key}
                href={`/admin/reports?range=${key}`}
                className={`sheet px-3 py-1.5 text-sm font-medium ${
                  key === rangeKey ? "bg-char-50 text-char-900 shadow-sm" : "text-char-600"
                }`}
              >
                {RANGES[key].label}
              </a>
            ))}
          </nav>
        }
      />

      <div className="space-y-6 p-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Takings" value={formatCents(summary.net, { symbol: true })} />
          <StatCard label="Sales" value={String(summary.saleCount)} hint={`${summary.refundCount} refunds`} />
          <StatCard label="Meat sold" value={`${formatKg(summary.weightGrams)} kg`} />
          {mayMargin ? (
            <StatCard
              label="Margin"
              value={`${summary.margin.percent}%`}
              tone={summary.margin.percent >= 0 ? "good" : "bad"}
              hint={
                summary.costedPercent >= 99.5
                  ? `${formatCents(summary.margin.profit)} on ${formatCents(summary.margin.cost)} of meat`
                  : `${summary.costedPercent}% of takings have a cost on file — this is a floor`
              }
            />
          ) : (
            <StatCard
              label="Average sale"
              value={formatCents(summary.averageSale, { symbol: true })}
            />
          )}
        </div>

        {mayMargin && summary.givenAway > 0 && (
          <Card title="Given away at the counter">
            <p className="text-sm leading-relaxed text-char-600">
              <strong className="readout text-2xl font-bold text-brass-700">
                {formatCents(summary.givenAway, { symbol: true })}
              </strong>{" "}
              came off board prices in this period — cashiers setting a price, and discounts. That
              is{" "}
              {summary.margin.profit + summary.givenAway === 0
                ? "0"
                : Math.round(
                    (summary.givenAway / (summary.margin.profit + summary.givenAway)) * 100,
                  )}
              % of what the margin would otherwise have been.
            </p>
          </Card>
        )}

        {mayMargin && <CarcassLedger entries={carcasses} />}

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="How people paid">
            <Table headers={["Method", "Count", "Amount"]} empty="No payments in this period.">
              {summary.byMethod.map((row) => (
                <tr key={row.method}>
                  <td className="px-3 py-2 font-medium text-char-900">{row.method}</td>
                  <td className="tabular px-3 py-2 text-char-600">{row.count}</td>
                  <td className="px-3 py-2 text-right">
                    <Money cents={row.amount} />
                  </td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title="By category">
            <Table headers={["Category", "Weight", "Takings"]} empty="No sales in this period.">
              {summary.byCategory.map((row) => (
                <tr key={row.category}>
                  <td className="px-3 py-2 font-medium text-char-900">{row.category}</td>
                  <td className="tabular px-3 py-2 text-char-600">
                    {formatKg(row.weightGrams)} kg
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Money cents={row.net} />
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>

        <Card title="Best sellers">
          <Table headers={["Product", "SKU", "Lines", "Weight", "Takings"]} empty="No sales in this period.">
            {summary.topProducts.map((row) => (
              <tr key={row.sku}>
                <td className="px-3 py-2 font-medium text-char-900">{row.name}</td>
                <td className="tabular px-3 py-2 text-xs text-char-500">{row.sku}</td>
                <td className="tabular px-3 py-2 text-char-600">{row.lines}</td>
                <td className="tabular px-3 py-2 text-char-600">{formatKg(row.weightGrams)} kg</td>
                <td className="px-3 py-2 text-right">
                  <Money cents={row.net} bold />
                </td>
              </tr>
            ))}
          </Table>
        </Card>

        {mayMargin && (
          <Card title="Margin by product">
            <p className="mb-3 text-xs text-char-500">
              Cost comes from each product&rsquo;s cost per kg, which intake and carcass breakdown
              keep current — so a cut that got dearer because the last carcass shrank more than
              usual shows up here.
            </p>
            <Table
              headers={["Product", "Weight", "Revenue", "Cost", "Margin", "Margin %"]}
              empty="No sales to margin in this period."
            >
              {margins.slice(0, 25).map((row) => (
                <tr key={row.sku}>
                  <td className="px-3 py-2 font-medium text-char-900">{row.name}</td>
                  <td className="tabular px-3 py-2 text-char-600">
                    {formatKg(row.weightGrams)} kg
                  </td>
                  <td className="tabular px-3 py-2 text-char-600">{formatCents(row.revenue)}</td>
                  <td className="tabular px-3 py-2 text-char-600">{formatCents(row.cost)}</td>
                  <td className="px-3 py-2">
                    <Money cents={row.margin} />
                  </td>
                  <td
                    className={`tabular px-3 py-2 text-right font-semibold ${
                      row.marginPercent < 15 ? "text-meat-700" : "text-emerald-700"
                    }`}
                  >
                    {row.marginPercent.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        <Card title={`Yield — ${yields.breakdowns} breakdowns, ${yields.averageLossPercent}% average loss`}>
          <Table
            headers={["Cut", "Breakdowns", "Total weight", "Average yield"]}
            empty="No carcass breakdowns in this period."
          >
            {yields.rows.map((row) => (
              <tr key={row.sku}>
                <td className="px-3 py-2 font-medium text-char-900">{row.name}</td>
                <td className="tabular px-3 py-2 text-char-600">{row.breakdowns}</td>
                <td className="tabular px-3 py-2 text-char-600">
                  {formatKg(row.totalWeightGrams)} kg
                </td>
                <td className="tabular px-3 py-2 text-right font-semibold text-char-900">
                  {row.averageYieldPercent.toFixed(1)}%
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
