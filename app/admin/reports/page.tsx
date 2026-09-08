import { requirePagePermission, getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import {
  addDays,
  carcassLedger,
  endOfDay,
  marginReport,
  periodTotals,
  previousPeriod,
  salesSummary,
  shopDateKey,
  startOfDay,
  yieldReport,
} from "@/lib/services/reports";
import { CarcassLedger } from "./CarcassLedger";
import { formatCents } from "@/lib/money";
import { formatKg } from "@/lib/weight";
import {
  Card,
  Money,
  PageHeader,
  StatCard,
  Table,
} from "@/components/admin/ui";
import { SHOP_TIME_ZONE } from "@/lib/shop-clock";

export const dynamic = "force-dynamic";

/**
 * How a figure moved against the same window a period earlier.
 *
 * Percentages only, and only when there is a base to be a percentage of: a
 * week that follows a week with no trading is not "up 100%", it is the first
 * week there is anything to compare.
 */
function compare(now: number, before: number): string {
  if (before === 0)
    return now === 0 ? "nothing either period" : "no figure to compare";
  const change = Math.round(((now - before) / before) * 100);
  if (change === 0) return "level with the period before";
  return `${change > 0 ? "up" : "down"} ${Math.abs(change)}% on the period before`;
}

/** Ranges the owner actually asks for, rather than a date picker nobody uses. */
const RANGES = {
  today: { label: "Today", days: 0 },
  yesterday: { label: "Yesterday", days: 0 },
  week: { label: "Last 7 days", days: 7 },
  month: { label: "Last 30 days", days: 30 },
  quarter: { label: "Last 90 days", days: 90 },
} as const;

type RangeKey = keyof typeof RANGES;

/**
 * The window being reported on.
 *
 * `?day=2026-09-08` wins over a named range, which is what makes stepping back
 * through single days possible - the arrows on a one-day view just link to the
 * day either side of it.
 */
function resolveWindow(params: { range?: string; day?: string }): {
  from: Date;
  to: Date;
  rangeKey: RangeKey | null;
  day: string | null;
} {
  if (params.day && /^\d{4}-\d{2}-\d{2}$/.test(params.day)) {
    const at = new Date(`${params.day}T12:00:00Z`);
    if (!Number.isNaN(at.getTime())) {
      return {
        from: startOfDay(at),
        to: endOfDay(at),
        rangeKey: null,
        day: params.day,
      };
    }
  }

  const rangeKey: RangeKey =
    params.range && params.range in RANGES
      ? (params.range as RangeKey)
      : "week";

  if (rangeKey === "yesterday") {
    const at = addDays(new Date(), -1);
    return {
      from: startOfDay(at),
      to: endOfDay(at),
      rangeKey,
      day: shopDateKey(at),
    };
  }
  if (rangeKey === "today") {
    return {
      from: startOfDay(),
      to: endOfDay(),
      rangeKey,
      day: shopDateKey(new Date()),
    };
  }

  return {
    from: startOfDay(addDays(new Date(), -RANGES[rangeKey].days)),
    to: endOfDay(),
    rangeKey,
    day: null,
  };
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; day?: string }>;
}) {
  await requirePagePermission("report.sales");
  const user = await getCurrentUser();
  const mayMargin = user ? can(user.role, "report.margin") : false;

  const params = await searchParams;
  const { from, to, rangeKey, day } = resolveWindow(params);
  const previous = previousPeriod(from, to);
  const singleDay = day !== null;

  const [summary, before, margins, yields, carcasses] = await Promise.all([
    // Days, hours and cashiers come off this same read - see bucketSales.
    salesSummary(from, to),
    // The same window, one period earlier, so every headline figure can say
    // which way it moved rather than standing on its own. Four numbers, so it
    // is an aggregate rather than a second full summary.
    periodTotals(previous.from, previous.to),
    mayMargin ? marginReport(from, to) : Promise.resolve([]),
    yieldReport(from, to),
    // The ledger puts a cost against the meat, so it is a margin view.
    mayMargin ? carcassLedger(from, to) : Promise.resolve([]),
  ]);

  const today = shopDateKey(new Date());

  return (
    <>
      <PageHeader
        title="Reports"
        description={
          singleDay
            ? from.toLocaleDateString("en-KE", {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
                timeZone: "Africa/Nairobi",
              })
            : `${from.toLocaleDateString("en-KE", { timeZone: SHOP_TIME_ZONE })} to ${to.toLocaleDateString("en-KE", { timeZone: SHOP_TIME_ZONE })}`
        }
        action={
          <div className="flex items-center gap-2">
            {/* On a single day, arrows step to the day either side. There is no
                arrow into tomorrow: there are no sales there yet. */}
            {singleDay && day && (
              <nav className="flex items-center gap-1">
                <a
                  href={`/admin/reports?day=${shopDateKey(addDays(from, -1))}`}
                  aria-label="Previous day"
                  className="flex h-8 w-8 items-center justify-center sheet border border-char-300 text-char-700 hover:bg-char-100"
                >
                  &larr;
                </a>
                <a
                  href={
                    day >= today
                      ? "/admin/reports?range=today"
                      : `/admin/reports?day=${shopDateKey(addDays(from, 1))}`
                  }
                  aria-label="Next day"
                  aria-disabled={day >= today}
                  className={`flex h-8 w-8 items-center justify-center sheet border border-char-300 ${
                    day >= today
                      ? "cursor-not-allowed text-char-300"
                      : "text-char-700 hover:bg-char-100"
                  }`}
                >
                  &rarr;
                </a>
              </nav>
            )}
            <nav className="flex gap-1 sheet bg-char-100 p-1">
              {(Object.keys(RANGES) as RangeKey[]).map((key) => (
                <a
                  key={key}
                  href={`/admin/reports?range=${key}`}
                  className={`sheet px-3 py-1.5 text-sm font-medium ${
                    key === rangeKey
                      ? "bg-char-50 text-char-900 shadow-sm"
                      : "text-char-600"
                  }`}
                >
                  {RANGES[key].label}
                </a>
              ))}
            </nav>
          </div>
        }
      />

      <div className="space-y-6 p-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Takings"
            value={formatCents(summary.net, { symbol: true })}
            hint={compare(summary.net, before.net)}
          />
          <StatCard
            label="Sales"
            value={String(summary.saleCount)}
            hint={
              summary.refundCount > 0
                ? `${summary.refundCount} refunds - ${compare(summary.saleCount, before.saleCount)}`
                : compare(summary.saleCount, before.saleCount)
            }
          />
          <StatCard
            label="Meat sold"
            value={`${formatKg(summary.weightGrams)} kg`}
            hint={compare(summary.weightGrams, before.weightGrams)}
          />
          {mayMargin ? (
            <StatCard
              label="Margin"
              value={`${summary.margin.percent}%`}
              tone={summary.margin.percent >= 0 ? "good" : "bad"}
              hint={
                summary.costedPercent >= 99.5
                  ? `${formatCents(summary.margin.profit)} on ${formatCents(summary.margin.cost)} of meat`
                  : `${summary.costedPercent}% of takings have a cost on file - this is a floor`
              }
            />
          ) : (
            <StatCard
              label="Average sale"
              value={formatCents(summary.averageSale, { symbol: true })}
              hint={compare(summary.averageSale, before.averageSale)}
            />
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {/* The margin card took this slot in the row above; without margin
              permission the average is already up there, so it is not repeated. */}
          {mayMargin && (
            <StatCard
              label="Average sale"
              value={formatCents(summary.averageSale, { symbol: true })}
              hint={compare(summary.averageSale, before.averageSale)}
            />
          )}
          <StatCard
            label="Busiest hour"
            value={summary.busiestHour ? summary.busiestHour.label : "-"}
            hint={
              summary.busiestHour
                ? `${formatCents(summary.busiestHour.net)} over ${summary.busiestHour.saleCount} sales`
                : "No sales in this period"
            }
          />
          <StatCard
            label={singleDay ? "Takings" : "Best day"}
            value={
              summary.bestDay
                ? formatCents(summary.bestDay.net, { symbol: true })
                : "-"
            }
            hint={
              summary.bestDay
                ? summary.bestDay.label
                : "No sales in this period"
            }
          />
          <StatCard
            label="Per kilo"
            value={
              summary.weightGrams === 0
                ? "-"
                : formatCents(
                    Math.round(summary.net / (summary.weightGrams / 1000)),
                    {
                      symbol: true,
                    },
                  )
            }
            hint="Takings divided by meat sold"
          />
        </div>

        {/* Days first: the shape of a week is the thing an owner reads before
            anything else, and each bar is a link into that day on its own. */}
        {!singleDay && (
          <Card title="Takings by day">
            <div className="space-y-1 p-3">
              {summary.byDay.map((row) => {
                const peak = Math.max(...summary.byDay.map((d) => d.net), 1);
                return (
                  <a
                    key={row.date}
                    href={`/admin/reports?day=${row.date}`}
                    className="flex items-center gap-3 sheet px-2 py-1.5 hover:bg-char-100"
                  >
                    <span className="w-28 shrink-0 text-sm text-char-700">
                      {row.label}
                    </span>
                    <span className="h-4 flex-1 sheet bg-char-100">
                      <span
                        className="block h-full sheet bg-brass-400"
                        style={{
                          width: `${Math.round((row.net / peak) * 100)}%`,
                        }}
                      />
                    </span>
                    <span className="tabular w-16 shrink-0 text-right text-xs text-char-500">
                      {row.saleCount === 0 ? "-" : `${row.saleCount} sales`}
                    </span>
                    <span className="w-24 shrink-0 text-right">
                      <Money cents={row.net} bold />
                    </span>
                  </a>
                );
              })}
            </div>
          </Card>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="When the shop is busy">
            <div className="space-y-1 p-3">
              {summary.byHour
                .filter((hour) => hour.saleCount > 0)
                .map((row) => {
                  const peak = Math.max(...summary.byHour.map((h) => h.net), 1);
                  return (
                    <div
                      key={row.hour}
                      className="flex items-center gap-3 px-2 py-1"
                    >
                      <span className="tabular w-12 shrink-0 text-sm text-char-700">
                        {row.label}
                      </span>
                      <span className="h-3 flex-1 sheet bg-char-100">
                        <span
                          className="block h-full sheet bg-char-400"
                          style={{
                            width: `${Math.round((row.net / peak) * 100)}%`,
                          }}
                        />
                      </span>
                      <span className="tabular w-14 shrink-0 text-right text-xs text-char-500">
                        {row.saleCount}
                      </span>
                      <span className="w-24 shrink-0 text-right">
                        <Money cents={row.net} />
                      </span>
                    </div>
                  );
                })}
              {summary.byHour.every((hour) => hour.saleCount === 0) && (
                <p className="px-2 py-6 text-center text-sm text-char-500">
                  No sales in this period.
                </p>
              )}
            </div>
          </Card>

          <Card title="By cashier">
            <Table
              headers={["Cashier", "Sales", "Average", "Takings"]}
              empty="No sales in this period."
            >
              {summary.byCashier.map((row) => (
                <tr key={row.userId}>
                  <td className="px-3 py-2 font-medium text-char-900">
                    {row.name}
                  </td>
                  <td className="tabular px-3 py-2 text-char-600">
                    {row.saleCount}
                  </td>
                  <td className="tabular px-3 py-2 text-char-600">
                    {formatCents(row.averageSale)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Money cents={row.net} bold />
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>

        {mayMargin && summary.givenAway > 0 && (
          <Card title="Given away at the counter">
            <p className="text-sm leading-relaxed text-char-600">
              <strong className="readout text-2xl font-bold text-brass-700">
                {formatCents(summary.givenAway, { symbol: true })}
              </strong>{" "}
              came off board prices in this period - cashiers setting a price,
              and discounts. That is{" "}
              {summary.margin.profit + summary.givenAway === 0
                ? "0"
                : Math.round(
                    (summary.givenAway /
                      (summary.margin.profit + summary.givenAway)) *
                      100,
                  )}
              % of what the margin would otherwise have been.
            </p>
          </Card>
        )}

        {mayMargin && <CarcassLedger entries={carcasses} />}

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="How people paid">
            <Table
              headers={["Method", "Count", "Amount"]}
              empty="No payments in this period."
            >
              {summary.byMethod.map((row) => (
                <tr key={row.method}>
                  <td className="px-3 py-2 font-medium text-char-900">
                    {row.method}
                  </td>
                  <td className="tabular px-3 py-2 text-char-600">
                    {row.count}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Money cents={row.amount} />
                  </td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title="By category">
            <Table
              headers={["Category", "Weight", "Takings"]}
              empty="No sales in this period."
            >
              {summary.byCategory.map((row) => (
                <tr key={row.category}>
                  <td className="px-3 py-2 font-medium text-char-900">
                    {row.category}
                  </td>
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
          <Table
            headers={["Product", "SKU", "Lines", "Weight", "Takings"]}
            empty="No sales in this period."
          >
            {summary.topProducts.map((row) => (
              <tr key={row.sku}>
                <td className="px-3 py-2 font-medium text-char-900">
                  {row.name}
                </td>
                <td className="tabular px-3 py-2 text-xs text-char-500">
                  {row.sku}
                </td>
                <td className="tabular px-3 py-2 text-char-600">{row.lines}</td>
                <td className="tabular px-3 py-2 text-char-600">
                  {formatKg(row.weightGrams)} kg
                </td>
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
              Cost comes from each product&rsquo;s cost per kg, which intake and
              carcass breakdown keep current - so a cut that got dearer because
              the last carcass shrank more than usual shows up here.
            </p>
            <Table
              headers={[
                "Product",
                "Weight",
                "Revenue",
                "Cost",
                "Margin",
                "Margin %",
              ]}
              empty="No sales to margin in this period."
            >
              {margins.slice(0, 25).map((row) => (
                <tr key={row.sku}>
                  <td className="px-3 py-2 font-medium text-char-900">
                    {row.name}
                  </td>
                  <td className="tabular px-3 py-2 text-char-600">
                    {formatKg(row.weightGrams)} kg
                  </td>
                  <td className="tabular px-3 py-2 text-char-600">
                    {formatCents(row.revenue)}
                  </td>
                  <td className="tabular px-3 py-2 text-char-600">
                    {formatCents(row.cost)}
                  </td>
                  <td className="px-3 py-2">
                    <Money cents={row.margin} />
                  </td>
                  <td
                    className={`tabular px-3 py-2 text-right font-semibold ${
                      row.marginPercent < 15
                        ? "text-meat-700"
                        : "text-emerald-700"
                    }`}
                  >
                    {row.marginPercent.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        <Card
          title={`Yield - ${yields.breakdowns} breakdowns, ${yields.averageLossPercent}% average loss`}
        >
          <Table
            headers={["Cut", "Breakdowns", "Total weight", "Average yield"]}
            empty="No carcass breakdowns in this period."
          >
            {yields.rows.map((row) => (
              <tr key={row.sku}>
                <td className="px-3 py-2 font-medium text-char-900">
                  {row.name}
                </td>
                <td className="tabular px-3 py-2 text-char-600">
                  {row.breakdowns}
                </td>
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
