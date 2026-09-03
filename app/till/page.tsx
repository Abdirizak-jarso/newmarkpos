import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getSettings } from "@/lib/settings";
import { terminalId } from "@/lib/receipt-number";
import { countUnconfirmedMpesa } from "@/lib/services/sales";
import { TillApp } from "./TillApp";
import type { TillProduct } from "./types";

export const dynamic = "force-dynamic";

export default async function TillPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!can(user.role, "sale.create")) redirect("/admin");

  const settings = await getSettings();

  const [categories, products, parked, pendingPrints, awaitingCodes] = await Promise.all([
    db.category.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } }),
    db.product.findMany({
      where: { active: true, showOnTill: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    db.sale.findMany({
      where: { status: "PARKED", terminalId: terminalId() },
      include: { lines: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.printJob.count({ where: { status: { in: ["QUEUED", "FAILED"] } } }),
    // M-Pesa payments taken but not yet matched to a confirmation code.
    countUnconfirmedMpesa(),
  ]);

  // The whole catalogue is sent to the client once, at load. That is the point:
  // the till prices a basket with no network, so it cannot be fetching a price
  // per tap. 47 products is a few kilobytes.
  const tillProducts: TillProduct[] = products.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    categoryId: p.categoryId,
    pricingMode: p.pricingMode as TillProduct["pricingMode"],
    price: p.price,
    comparePrice: p.comparePrice,
    unitWeightGrams: p.unitWeightGrams,
    taxClass: p.taxClass as TillProduct["taxClass"],
    stockGrams: p.stockGrams,
    isByProduct: p.isByProduct,
    featured: p.featured,
  }));

  return (
    <TillApp
      user={user}
      terminalId={terminalId()}
      products={tillProducts}
      categories={categories.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        colour: c.colour,
      }))}
      settings={{
        standardVatRatePercent: settings.standardVatRatePercent,
        cashRoundingStep: settings.cashRoundingStep,
        discountApprovalThreshold: settings.discountApprovalThreshold,
        discountApprovalPercent: settings.discountApprovalPercent,
        lowStockWarningGrams: settings.lowStockWarningGrams,
        shopName: settings.shopName,
      }}
      parkedCount={parked.length}
      pendingPrints={pendingPrints}
      awaitingCodes={awaitingCodes}
    />
  );
}
