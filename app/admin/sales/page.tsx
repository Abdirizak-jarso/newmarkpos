import { db } from "@/lib/db";
import { requirePagePermission, getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { formatKg } from "@/lib/weight";
import { Badge, Card, Money, PageHeader, Table } from "@/components/admin/ui";
import { SaleActions } from "./SaleActions";

export const dynamic = "force-dynamic";

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requirePagePermission("report.sales");
  const user = await getCurrentUser();
  const params = await searchParams;
  const query = params.q?.trim() ?? "";

  const sales = await db.sale.findMany({
    where: {
      status: { in: ["COMPLETED", "VOIDED", "REFUNDED"] },
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
        description="A void or a refund never edits the original sale — it records a reversal that points back at it."
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

      <div className="p-8">
        <Card>
          <Table
            headers={["Receipt", "When", "Cashier", "Items", "Payment", "eTIMS", "Total", ""]}
            empty={query ? `No sales match “${query}”.` : "No sales recorded yet."}
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
                    ? "—"
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
                    <span className="text-xs text-char-400">—</span>
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
