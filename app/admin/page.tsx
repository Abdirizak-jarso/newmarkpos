import Link from "next/link";
import { db } from "@/lib/db";
import { requirePagePermission } from "@/lib/session";
import { getSettings } from "@/lib/settings";
import { salesSummary, startOfDay, endOfDay } from "@/lib/services/reports";
import { formatCents } from "@/lib/money";
import { formatKg } from "@/lib/weight";
import { Badge, Card, Money, PageHeader, StatCard, Table } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default async function AdminOverview() {
  await requirePagePermission("report.sales");
  const settings = await getSettings();

  const today = await salesSummary(startOfDay(), endOfDay());

  const [lowStock, pendingPrints, pendingSync, pendingInvoices, recentSales] = await Promise.all([
    db.product.findMany({
      where: { active: true, stockGrams: { lte: settings.lowStockWarningGrams } },
      orderBy: { stockGrams: "asc" },
      take: 8,
      include: { category: true },
    }),
    db.printJob.count({ where: { status: { in: ["QUEUED", "FAILED"] } } }),
    db.syncQueue.count({ where: { status: "PENDING" } }),
    db.taxInvoice.count({ where: { status: "PENDING" } }),
    db.sale.findMany({
      where: { status: { in: ["COMPLETED", "VOIDED", "REFUNDED"] } },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { user: true },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Today at the counter"
        description={new Date().toLocaleDateString("en-KE", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        })}
      />

      <div className="space-y-6 p-8">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label="Takings"
            value={formatCents(today.net, { symbol: true })}
            hint={`${today.saleCount} sales`}
          />
          <StatCard
            label="Meat sold"
            value={`${formatKg(today.weightGrams)} kg`}
            hint={
              today.saleCount > 0
                ? `${formatCents(today.averageSale)} average sale`
                : "No sales yet"
            }
          />
          <StatCard
            label="Discounts"
            value={formatCents(today.discount)}
            tone={today.discount > 0 ? "warn" : "neutral"}
            hint={today.refundCount > 0 ? `${today.refundCount} refunds` : "No refunds"}
          />
          <StatCard
            label="VAT collected"
            value={formatCents(today.tax)}
            hint={pendingInvoices > 0 ? `${pendingInvoices} invoices pending` : "eTIMS up to date"}
            tone={pendingInvoices > 0 ? "warn" : "neutral"}
          />
        </div>

        {(pendingPrints > 0 || pendingSync > 0) && (
          <div className="sheet border border-brass-200 bg-brass-50 px-4 py-3 text-sm text-amber-900">
            {pendingPrints > 0 && (
              <p>
                {pendingPrints} receipt{pendingPrints === 1 ? "" : "s"} waiting to print — check the
                printer has paper and power.
              </p>
            )}
            {pendingSync > 0 && (
              <p>{pendingSync} record{pendingSync === 1 ? "" : "s"} waiting to sync to the server.</p>
            )}
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Selling today">
            <Table headers={["Product", "Weight", "Takings"]} empty="No sales yet today.">
              {today.topProducts.slice(0, 8).map((product) => (
                <tr key={product.sku}>
                  <td className="px-3 py-2">
                    <span className="font-medium text-char-900">{product.name}</span>
                    <span className="ml-2 text-xs text-char-500">{product.sku}</span>
                  </td>
                  <td className="tabular px-3 py-2 text-char-600">
                    {formatKg(product.weightGrams)} kg
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Money cents={product.net} />
                  </td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title="Running low">
            <Table headers={["Product", "Category", "On hand"]} empty="Everything is well stocked.">
              {lowStock.map((product) => (
                <tr key={product.id}>
                  <td className="px-3 py-2 font-medium text-char-900">{product.name}</td>
                  <td className="px-3 py-2 text-char-600">{product.category.name}</td>
                  <td className="tabular px-3 py-2 text-right">
                    <span
                      className={product.stockGrams <= 0 ? "text-meat-700" : "text-brass-700"}
                    >
                      {formatKg(product.stockGrams)} kg
                    </span>
                  </td>
                </tr>
              ))}
            </Table>
            <Link
              href="/admin/stock"
              className="mt-3 inline-block text-sm font-medium text-meat-700 hover:underline"
            >
              Manage stock →
            </Link>
          </Card>
        </div>

        <Card title="Latest sales">
          <Table headers={["Receipt", "Cashier", "Time", "Status", "Total"]} empty="No sales recorded yet.">
            {recentSales.map((sale) => (
              <tr key={sale.id}>
                <td className="tabular px-3 py-2 font-medium text-char-900">{sale.receiptNumber}</td>
                <td className="px-3 py-2 text-char-600">{sale.user.name}</td>
                <td className="px-3 py-2 text-char-600">
                  {(sale.completedAt ?? sale.createdAt).toLocaleTimeString("en-KE", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </td>
                <td className="px-3 py-2">
                  <Badge
                    tone={
                      sale.status === "VOIDED" ? "bad" : sale.status === "REFUNDED" ? "warn" : "good"
                    }
                  >
                    {sale.status.toLowerCase()}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  <Money cents={sale.total} bold />
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
