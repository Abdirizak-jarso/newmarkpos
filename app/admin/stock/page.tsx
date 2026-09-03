import { db } from "@/lib/db";
import { requirePagePermission, getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getSettings } from "@/lib/settings";
import { formatCents } from "@/lib/money";
import { formatKg } from "@/lib/weight";
import { Badge, Card, PageHeader, Table } from "@/components/admin/ui";
import { StockForms } from "./StockForms";

export const dynamic = "force-dynamic";

const REASON_LABELS: Record<string, string> = {
  INTAKE: "Intake",
  SALE: "Sale",
  REFUND: "Return",
  BREAKDOWN_IN: "Broken down",
  BREAKDOWN_OUT: "From breakdown",
  WASTE: "Waste",
  ADJUSTMENT: "Adjustment",
  TRANSFER: "Transfer",
  STAFF_MEAT: "Staff meat",
  COUNT: "Stocktake",
};

export default async function StockPage() {
  await requirePagePermission("stock.view");
  const user = await getCurrentUser();
  const settings = await getSettings();

  const [products, movements] = await Promise.all([
    db.product.findMany({
      where: { active: true },
      orderBy: [{ stockGrams: "asc" }],
      include: { category: true },
    }),
    db.stockMovement.findMany({
      orderBy: { createdAt: "desc" },
      take: 40,
      include: { product: true, actor: true },
    }),
  ]);

  const permissions = {
    intake: user ? can(user.role, "stock.intake") : false,
    adjust: user ? can(user.role, "stock.adjust") : false,
    count: user ? can(user.role, "stock.count") : false,
  };

  return (
    <>
      <PageHeader
        title="Stock"
        description="Everything is tracked in kilograms. Every movement carries a reason and the person who made it."
      />

      <div className="space-y-6 p-8">
        {(permissions.intake || permissions.adjust || permissions.count) && (
          <StockForms
            products={products.map((p) => ({
              id: p.id,
              name: p.name,
              sku: p.sku,
              stockGrams: p.stockGrams,
            }))}
            permissions={permissions}
          />
        )}

        <Card title="On hand">
          <Table headers={["Product", "Category", "Cost/kg", "Value", "On hand"]}>
            {products.map((product) => {
              const low = product.stockGrams <= settings.lowStockWarningGrams;
              return (
                <tr key={product.id}>
                  <td className="px-3 py-2">
                    <span className="font-medium text-char-900">{product.name}</span>
                    {product.isByProduct && (
                      <span className="ml-2">
                        <Badge>by-product</Badge>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-char-600">{product.category.name}</td>
                  <td className="tabular px-3 py-2 text-char-600">
                    {formatCents(product.costPerKg)}
                  </td>
                  <td className="tabular px-3 py-2 text-char-600">
                    {formatCents(Math.round((product.costPerKg * product.stockGrams) / 1000))}
                  </td>
                  <td className="tabular px-3 py-2 text-right">
                    <span
                      className={
                        product.stockGrams <= 0
                          ? "font-semibold text-meat-700"
                          : low
                            ? "font-semibold text-brass-700"
                            : "text-char-900"
                      }
                    >
                      {formatKg(product.stockGrams)} kg
                    </span>
                  </td>
                </tr>
              );
            })}
          </Table>
        </Card>

        <Card title="Recent movements">
          <Table
            headers={["When", "Product", "Reason", "By", "Change", "Balance"]}
            empty="No stock has moved yet."
          >
            {movements.map((movement) => (
              <tr key={movement.id}>
                <td className="px-3 py-2 text-xs text-char-500">
                  {movement.createdAt.toLocaleString("en-KE", {
                    day: "2-digit",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </td>
                <td className="px-3 py-2 font-medium text-char-900">{movement.product.name}</td>
                <td className="px-3 py-2">
                  <Badge
                    tone={
                      movement.reason === "WASTE"
                        ? "bad"
                        : movement.reason === "INTAKE" || movement.reason === "BREAKDOWN_OUT"
                          ? "good"
                          : "neutral"
                    }
                  >
                    {REASON_LABELS[movement.reason] ?? movement.reason}
                  </Badge>
                  {movement.note && (
                    <span className="ml-2 text-xs text-char-500">{movement.note}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-char-600">{movement.actor.name}</td>
                <td className="tabular px-3 py-2">
                  <span
                    className={movement.deltaGrams < 0 ? "text-meat-700" : "text-emerald-700"}
                  >
                    {movement.deltaGrams > 0 ? "+" : ""}
                    {formatKg(movement.deltaGrams)} kg
                  </span>
                </td>
                <td className="tabular px-3 py-2 text-right text-char-600">
                  {formatKg(movement.balanceGrams)} kg
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
