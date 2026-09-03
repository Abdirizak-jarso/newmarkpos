import { db } from "@/lib/db";
import { requirePagePermission } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getCurrentUser } from "@/lib/session";
import { formatCents } from "@/lib/money";
import { formatKg } from "@/lib/weight";
import { Badge, Card, PageHeader, Table } from "@/components/admin/ui";
import { PriceEditor } from "./PriceEditor";

export const dynamic = "force-dynamic";

const TAX_LABELS: Record<string, string> = {
  EXEMPT: "Exempt",
  ZERO_RATED: "Zero rated",
  STANDARD: "Standard",
};

const MODE_LABELS: Record<string, string> = {
  PER_KG: "per kg",
  PER_PIECE: "each",
  FIXED_PACK: "pack",
};

export default async function ProductsPage() {
  await requirePagePermission("product.view");
  const user = await getCurrentUser();
  const mayPrice = user ? can(user.role, "product.price") : false;

  const categories = await db.category.findMany({
    where: { active: true },
    orderBy: { sortOrder: "asc" },
    include: {
      products: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }] },
    },
  });

  return (
    <>
      <PageHeader
        title="Catalogue"
        description="Prices mirror the live shop. A price change needs a manager PIN and is written to the audit log."
      />

      <div className="space-y-6 p-8">
        {categories.map((category) => (
          <Card key={category.id} title={`${category.name} · ${category.products.length} products`}>
            <Table
              headers={["Product", "SKU", "Mode", "VAT", "Stock", "Price"]}
              empty="No products in this category."
            >
              {category.products.map((product) => (
                <tr key={product.id} className={product.active ? "" : "opacity-50"}>
                  <td className="px-3 py-2">
                    <span className="font-medium text-char-900">{product.name}</span>
                    <span className="ml-2 inline-flex gap-1">
                      {product.isByProduct && <Badge>by-product</Badge>}
                      {product.isBreakdownSource && <Badge tone="warn">breaks down</Badge>}
                      {!product.active && <Badge tone="bad">inactive</Badge>}
                    </span>
                  </td>
                  <td className="tabular px-3 py-2 text-xs text-char-500">{product.sku}</td>
                  <td className="px-3 py-2 text-char-600">
                    {MODE_LABELS[product.pricingMode] ?? product.pricingMode}
                    {product.unitWeightGrams
                      ? ` · ${formatKg(product.unitWeightGrams)} kg`
                      : ""}
                  </td>
                  <td className="px-3 py-2 text-char-600">
                    {TAX_LABELS[product.taxClass] ?? product.taxClass}
                  </td>
                  <td className="tabular px-3 py-2 text-char-600">
                    {formatKg(product.stockGrams)} kg
                  </td>
                  <td className="px-3 py-2 text-right">
                    {mayPrice ? (
                      <PriceEditor
                        productId={product.id}
                        name={product.name}
                        price={product.price}
                      />
                    ) : (
                      <span className="tabular font-semibold">{formatCents(product.price)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        ))}
      </div>
    </>
  );
}
