import { db } from "@/lib/db";
import { requirePagePermission, getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { formatCents } from "@/lib/money";
import { formatKg } from "@/lib/weight";
import { addDays, endOfDay, shopDateKey, startOfDay } from "@/lib/services/reports";
import { Badge, Card, Money, PageHeader, StatCard, Table } from "@/components/admin/ui";
import { SaleActions } from "./SaleActions";

export const dynamic = "force-dynamic";

/**
 * Which sales the list is showing.
 *
 * `?day=` is a single trading day and wins over everything, so the arrows can
 * walk back through yesterday and the day before. `?period=` is the coarser
 * question - today, this week, this month - and `all` is the search view,
 * where a receipt number matters more than a date.
 */
const PERIODS = {
  today: { label: "Today", days: 0 },
  week: { label: "Last 7 days", days: 6 },
  month: { label: "Last 30 days", days: 29 },
  all: { label: "All", days: null },
} as const;

type PeriodKey = keyof typeof PERIODS;

function resolveWindow(params: { period?: string; day?: string }): {
  from: Date | null;
  to: Date | null;
  periodKey: PeriodKey | null;
  day: string | null;
} {
  if (params.day && /^\d{4}-\d{2}-\d{2}$/.test(params.day)) {
    const at = new Date(`${params.day}T12:00:00Z`);
    if (!Number.isNaN(at.getTime())) {
      return { from: startOfDay(at), to: endOfDay(at), periodKey: null, day: params.day };
    }
  }

  const periodKey: PeriodKey =
    params.period && params.period in PERIODS ? (params.period as PeriodKey) : "today";
  const period = PERIODS[periodKey];

  if (period.days === null) return { from: null, to: null, periodKey, day: null };
  return {
    from: startOfDay(addDays(new Date(), -period.days)),
    to: endOfDay(),
    periodKey,
    day: periodKey === "today" ? shopDateKey(new Date()) : null,
  };
}

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; period?: string; day?: string }>;
}) {
  await requirePagePermission("report.sales");
  const user = await getCurrentUser();
  const params = await searchParams;
  const query = params.q?.trim() ?? "";

  // A search is a search: looking up a receipt number should not be silently
  // limited to today, or the cashier types it in and is told it does not exist.
  const { from, to, periodKey, day } = query
    ? { from: null, to: null, periodKey: "all" as PeriodKey, day: null }
    : resolveWindow(params);

  const sales = await db.sale.findMany({
    where: {
      status: { in: ["COMPLETED", "VOIDED", "REFUNDED"] },
      ...(from && to ? { completedAt: { gte: from, lte: to } } : {}),
      ...(query
        ? {
            OR: [
              { receiptNumber: { contains: query } },
              { customerName: { contains: query } },
              { customerPhone: { contains: query } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      user: true,
      payments: true,
      lines: true,
      invoice: true,
    },
  });

  const today = shopDateKey(new Date());
  const takings = sales.reduce((total, sale) => total + sale.total, 0);
  const weightGrams = sales.reduce((total, sale) => total + sale.totalWeightGrams, 0);
  const awaitingCode = sales.filter((sale) =>
    sale.payments.some((p) => p.method === "MPESA" && p.status === "PENDING"),
  ).length;

  const permissions = {
    void: user ? can(user.role, "sale.void") : false,
    refund: user ? can(user.role, "sale.refund") : false,
    reprint: user ? can(user.role, "sale.reprint") : false,
    reconcile: user ? can(user.role, "sale.mpesa.reconcile") : false,
  };

  return (
    <>
      <PageHeader
        title="Sales"
        description={
          query
            ? `Searching every sale for "${query}"`
            : day
              ? from!.toLocaleDateString("en-KE", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                  timeZone: "Africa/Nairobi",
                })
              : from && to
                ? `${from.toLocaleDateString("en-KE")} to ${to.toLocaleDateString("en-KE")}`
                : "Every sale, newest first"
        }
        action={
          <form className="flex gap-2">
            <input
              name="q"
              defaultValue={query}
              placeholder="Receipt number or customer"
              className="h-9 w-64 sheet border border-char-300 px-3 text-sm"
            />
            <button
              type="submit"
              className="h-9 sheet bg-char-800 px-4 text-sm font-medium text-white hover:bg-char-700"
            >
              Search
            </button>
          </form>
        }
      />

      <div className="space-y-6 p-8">
        {!query && (
          <div className="flex flex-wrap items-center gap-2">
            {/* Arrows only on a single day, and never into tomorrow. */}
            {day && (
              <nav className="flex items-center gap-1">
                <a
                  href={`/admin/sales?day=${shopDateKey(addDays(from!, -1))}`}
                  aria-label="Previous day"
                  className="flex h-9 w-9 items-center justify-center sheet border border-char-300 text-char-700 hover:bg-char-100"
                >
                  &larr;
                </a>
                <a
                  href={
                    day >= today
                      ? "/admin/sales?period=today"
                      : `/admin/sales?day=${shopDateKey(addDays(from!, 1))}`
                  }
                  aria-label="Next day"
                  aria-disabled={day >= today}
                  className={`flex h-9 w-9 items-center justify-center sheet border border-char-300 ${
                    day >= today
                      ? "cursor-not-allowed text-char-300"
                      : "text-char-700 hover:bg-char-100"
                  }`}
                >
                  &rarr;
                </a>
              </nav>
            )}

            <a
              href={`/admin/sales?day=${shopDateKey(addDays(new Date(), -1))}`}
              className={`sheet border px-3 py-1.5 text-sm font-medium ${
                day && day < today
                  ? "border-char-800 bg-char-800 text-white"
                  : "border-char-300 text-char-700 hover:bg-char-100"
              }`}
            >
              Yesterday
            </a>

            <nav className="flex gap-1 sheet bg-char-100 p-1">
              {(Object.keys(PERIODS) as PeriodKey[]).map((key) => (
                <a
                  key={key}
                  href={`/admin/sales?period=${key}`}
                  className={`sheet px-3 py-1.5 text-sm font-medium ${
                    key === periodKey ? "bg-char-50 text-char-900 shadow-sm" : "text-char-600"
                  }`}
                >
                  {PERIODS[key].label}
                </a>
              ))}
            </nav>

            <a
              href={day ? `/admin/reports?day=${day}` : `/admin/reports?range=${periodKey === "all" ? "quarter" : periodKey}`}
              className="ml-auto text-sm font-medium text-char-600 underline hover:text-char-900"
            >
              Analytics for this period &rarr;
            </a>
          </div>
        )}

        {!query && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Takings" value={formatCents(takings, { symbol: true })} />
            <StatCard
              label="Sales"
              value={String(sales.length)}
              hint={sales.length === 100 ? "showing the newest 100" : undefined}
            />
            <StatCard label="Meat sold" value={`${formatKg(weightGrams)} kg`} />
            <StatCard
              label="Waiting for a code"
              value={String(awaitingCode)}
              tone={awaitingCode > 0 ? "warn" : "neutral"}
              hint={awaitingCode > 0 ? "M-Pesa paid, code not yet entered" : "All codes in"}
            />
          </div>
        )}

        <Card>
          <Table
            headers={["Receipt", "When", "Cashier", "Items", "Payment", "eTIMS", "Total", ""]}
            empty={
              query
                ? `No sales match “${query}”.`
                : day
                  ? "No sales on this day."
                  : "No sales in this period."
            }
          >
            {sales.map((sale) => (
              <tr key={sale.id} className={sale.status === "VOIDED" ? "opacity-60" : ""}>
                <td className="px-3 py-2">
                  <span className="tabular font-medium text-char-900">{sale.receiptNumber}</span>
                  {sale.status !== "COMPLETED" && (
                    <span className="ml-2">
                      <Badge tone={sale.status === "VOIDED" ? "bad" : "warn"}>
                        {sale.status.toLowerCase()}
                      </Badge>
                    </span>
                  )}
                  {sale.reversesSaleId && (
                    <span className="ml-2">
                      <Badge tone="warn">reversal</Badge>
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-char-500">
                  {(sale.completedAt ?? sale.createdAt).toLocaleString("en-KE", {
                    day: "2-digit",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </td>
                <td className="px-3 py-2 text-char-600">{sale.user.name}</td>
                <td className="tabular px-3 py-2 text-char-600">
                  {sale.lines.length} {sale.lines.length === 1 ? "line" : "lines"}, {formatKg(sale.totalWeightGrams)} kg
                </td>
                <td className="px-3 py-2 text-xs text-char-600">
                  {sale.payments.length === 0
                    ? "-"
                    : sale.payments.map((payment) =>
                        payment.reference ? (
                          <span key={payment.id} className="tabular block tracking-wider">
                            {payment.reference}
                          </span>
                        ) : (
                          <span key={payment.id} className="block">
                            <Badge tone="warn">no code yet</Badge>
                          </span>
                        ),
                      )}
                </td>
                <td className="px-3 py-2">
                  {sale.invoice ? (
                    <Badge
                      tone={
                        sale.invoice.status === "ACCEPTED"
                          ? "good"
                          : sale.invoice.status === "REJECTED"
                            ? "bad"
                            : "neutral"
                      }
                    >
                      {sale.invoice.status.toLowerCase()}
                    </Badge>
                  ) : (
                    <span className="text-xs text-char-400">-</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <Money cents={sale.total} bold />
                </td>
                <td className="px-3 py-2 text-right">
                  <SaleActions
                    saleId={sale.id}
                    receiptNumber={sale.receiptNumber}
                    status={sale.status}
                    total={sale.total}
                    awaitingCodePaymentId={
                      sale.payments.find(
                        (p) => p.method === "MPESA" && (p.status !== "CONFIRMED" || !p.reference),
                      )?.id ?? null
                    }
                    permissions={permissions}
                  />
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
