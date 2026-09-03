import { db } from "@/lib/db";
import { requirePagePermission } from "@/lib/session";
import { formatCents } from "@/lib/money";
import { formatKg } from "@/lib/weight";
import { Badge, Card, PageHeader, Table } from "@/components/admin/ui";
import { BreakdownForm } from "./BreakdownForm";

export const dynamic = "force-dynamic";

export default async function BreakdownPage() {
  await requirePagePermission("stock.breakdown");

  const [sources, outputs, history] = await Promise.all([
    db.product.findMany({
      where: { active: true, isBreakdownSource: true },
      orderBy: { name: "asc" },
    }),
    db.product.findMany({
      where: { active: true, isBreakdownSource: false },
      orderBy: [{ isByProduct: "asc" }, { name: "asc" }],
      include: { category: true },
    }),
    db.carcassBreakdown.findMany({
      orderBy: { createdAt: "desc" },
      take: 10,
      include: {
        sourceProduct: true,
        actor: true,
        outputs: { include: { product: true } },
      },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Carcass breakdown"
        description="Break a bulk intake down into cuts. Yields never sum to the input weight — the difference is recorded as loss, not discarded."
      />

      <div className="space-y-6 p-8">
        <BreakdownForm
          sources={sources.map((s) => ({
            id: s.id,
            name: s.name,
            sku: s.sku,
            costPerKg: s.costPerKg,
            stockGrams: s.stockGrams,
          }))}
          outputs={outputs.map((o) => ({
            id: o.id,
            name: o.name,
            sku: o.sku,
            category: o.category.name,
            isByProduct: o.isByProduct,
          }))}
        />

        <Card title="Recent breakdowns">
          {history.length === 0 ? (
            <p className="py-8 text-center text-sm text-char-500">
              No breakdowns recorded yet.
            </p>
          ) : (
            <ul className="space-y-4">
              {history.map((breakdown) => (
                <li key={breakdown.id} className="sheet border border-char-200 p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <p className="font-semibold text-char-900">
                        {breakdown.sourceProduct.name}
                      </p>
                      <p className="text-xs text-char-500">
                        {breakdown.createdAt.toLocaleString("en-KE", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}{" "}
                        · {breakdown.actor.name}
                        {breakdown.supplier ? ` · ${breakdown.supplier}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                      <span className="tabular text-char-600">
                        In {formatKg(breakdown.inputWeightGrams)} kg
                      </span>
                      <span className="tabular text-char-600">
                        Out {formatKg(breakdown.outputWeightGrams)} kg
                      </span>
                      <Badge tone={breakdown.lossPercentTenths > 200 ? "bad" : "warn"}>
                        {(breakdown.lossPercentTenths / 10).toFixed(1)}% loss
                      </Badge>
                    </div>
                  </div>

                  <Table headers={["Cut", "Weight", "Yield", "Cost/kg"]}>
                    {breakdown.outputs.map((output) => (
                      <tr key={output.id}>
                        <td className="px-3 py-1.5">
                          {output.product.name}
                          {output.isByProduct && (
                            <span className="ml-2">
                              <Badge>by-product</Badge>
                            </span>
                          )}
                        </td>
                        <td className="tabular px-3 py-1.5 text-char-600">
                          {formatKg(output.weightGrams)} kg
                        </td>
                        <td className="tabular px-3 py-1.5 text-char-600">
                          {(output.yieldTenths / 10).toFixed(1)}%
                        </td>
                        <td className="tabular px-3 py-1.5 text-right text-char-600">
                          {formatCents(output.costPerKg)}
                        </td>
                      </tr>
                    ))}
                  </Table>

                  {breakdown.notes && (
                    <p className="mt-2 text-xs text-char-500">{breakdown.notes}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
