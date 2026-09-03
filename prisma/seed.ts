import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../lib/generated/prisma/client";
import { hashPin } from "../lib/auth";

/**
 * Seed.
 *
 * The catalogue mirrors the live shop at newmarkprimemeat.com — the prices in
 * products.json are the real ones. Do not change a price here without saying
 * so: the seed is what a fresh till is checked against.
 */

const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL ?? "file:./newmark.db" });
const db = new PrismaClient({ adapter });

interface LiveProduct {
  name: string;
  description?: string;
  category: string;
  pricePerKg: number;
  comparePrice?: number;
  sku: string;
  stockkg: number;
  visibility: string;
  featured?: boolean;
  slug: string;
}

const CATEGORIES: { name: string; slug: string; colour: string; sortOrder: number }[] = [
  { name: "Beef", slug: "beef", colour: "#8c2f2f", sortOrder: 1 },
  { name: "Goat", slug: "goat", colour: "#7a5230", sortOrder: 2 },
  { name: "Lamb", slug: "lamb", colour: "#9c5a3c", sortOrder: 3 },
  { name: "Chicken", slug: "chicken", colour: "#b5893b", sortOrder: 4 },
];

/**
 * Products that are not sold by weight off the scale.
 *
 * The Prime Combo is a made-up pack at a fixed price; a whole chicken is sold
 * as a bird. Everything not listed here is PER_KG, which is the default at the
 * counter.
 */
const NON_KG: Record<string, { mode: "PER_PIECE" | "FIXED_PACK"; unitWeightGrams: number; price?: number }> = {
  "BF-003": { mode: "FIXED_PACK", unitWeightGrams: 1500, price: 975_00 }, // 1kg bones + 0.5kg cubes
  "CH-001": { mode: "PER_PIECE", unitWeightGrams: 1400 },
};

/** Comes out of a carcass breakdown, never a purchase order. */
const BY_PRODUCTS = new Set(["BEEF-SOUP-BONES", "BF-001", "BF-002"]); // Soup Bones, Meaty Bones, Cat Food

/** Bulk intakes that get broken down into cuts. */
const BREAKDOWN_SOURCES = new Set([
  "BEEF-WHOLE-CARCASS",
  "BEEF-FRONT-QUARTER",
  "BEEF-HIND-QUARTER",
  "GOAT-WHOLE",
  "LAMB-WHOLE",
]);

/**
 * VAT treatment.
 *
 * Unprocessed meat is treated as exempt here as a starting position. This is
 * NOT a settled answer — per-category treatment is the owner's accountant's
 * call and is listed as an open decision in CLAUDE.md. Change it in the admin
 * catalogue, per product, not by editing a constant.
 */
function taxClassFor(_sku: string): "EXEMPT" | "ZERO_RATED" | "STANDARD" {
  return "EXEMPT";
}

async function main() {
  console.log("Seeding Newmark POS…");

  // --- Categories ----------------------------------------------------------
  const categoryIds = new Map<string, string>();
  for (const category of CATEGORIES) {
    const row = await db.category.upsert({
      where: { slug: category.slug },
      create: category,
      update: { name: category.name, colour: category.colour, sortOrder: category.sortOrder },
    });
    categoryIds.set(category.slug, row.id);
  }
  console.log(`  ${CATEGORIES.length} categories`);

  // --- Catalogue -----------------------------------------------------------
  const raw = readFileSync(path.join(process.cwd(), "products.json"), "utf8");
  const live = (JSON.parse(raw) as { docs: LiveProduct[] }).docs;

  let count = 0;
  for (const [index, product] of live.entries()) {
    const categoryId = categoryIds.get(product.category);
    if (!categoryId) {
      console.warn(`  ! skipping ${product.sku}: unknown category "${product.category}"`);
      continue;
    }

    const override = NON_KG[product.sku];
    const pricingMode = override?.mode ?? "PER_KG";
    // Shilling prices from the website become integer cents here, once.
    const price = override?.price ?? product.pricePerKg * 100;

    await db.product.upsert({
      where: { sku: product.sku },
      create: {
        sku: product.sku,
        name: product.name,
        slug: product.slug,
        description: product.description?.replace(/\r\n/g, "\n").trim() || null,
        categoryId,
        pricingMode,
        price,
        comparePrice: product.comparePrice ? product.comparePrice * 100 : null,
        unitWeightGrams: override?.unitWeightGrams ?? null,
        taxClass: taxClassFor(product.sku),
        stockGrams: Math.round(product.stockkg * 1000),
        // A rough starting cost so margin reports are not divide-by-zero from
        // day one. Intake and breakdown correct it with real figures.
        costPerKg: Math.round(price * 0.72),
        isByProduct: BY_PRODUCTS.has(product.sku),
        isBreakdownSource: BREAKDOWN_SOURCES.has(product.sku),
        active: product.visibility === "visible",
        showOnTill: product.visibility === "visible",
        featured: product.featured ?? false,
        sortOrder: index,
      },
      // Re-seeding must not undo a price the shop has since changed at the
      // till, so only the descriptive fields are refreshed.
      update: {
        name: product.name,
        description: product.description?.replace(/\r\n/g, "\n").trim() || null,
        categoryId,
        isByProduct: BY_PRODUCTS.has(product.sku),
        isBreakdownSource: BREAKDOWN_SOURCES.has(product.sku),
      },
    });
    count += 1;
  }
  console.log(`  ${count} products`);

  // --- Staff ---------------------------------------------------------------
  // Demo PINs. Each one is unique, because the PIN is the only thing typed at
  // the till — it identifies the person as well as authorising them.
  // Change them before the till goes on the counter; Admin → Staff is the
  // place to do it.
  const staff: { name: string; staffCode: string; role: string; pin: string }[] = [
    { name: "Shop Admin", staffCode: "1000", role: "ADMIN", pin: "907143" },
    { name: "Cashier One", staffCode: "4001", role: "CASHIER", pin: "270496" },
    { name: "Cashier Two", staffCode: "4002", role: "CASHIER", pin: "583017" },
  ];

  for (const member of staff) {
    const credentials = await hashPin(member.pin);
    await db.user.upsert({
      where: { staffCode: member.staffCode },
      create: {
        name: member.name,
        staffCode: member.staffCode,
        role: member.role,
        ...credentials,
      },
      // Never reset a live PIN by re-running the seed.
      update: { name: member.name, role: member.role },
    });
  }
  console.log(`  ${staff.length} staff accounts`);

  // --- Settings ------------------------------------------------------------
  const settings: Record<string, unknown> = {
    shopName: "Newmark Butchery",
    tagline: "Premium Halal Meat",
    addressLines: ["Bishan Plaza, Westlands", "Nairobi, Kenya"],
    receiptFooter: ["Thank you for shopping with us", "newmarkprimemeat.com"],
    standardVatRatePercent: 16,
    cashRoundingStep: 0,
    discountApprovalThreshold: 50_000,
    discountApprovalPercent: 10,
    paperWidthMm: 80,
    lowStockWarningGrams: 2000,
  };
  for (const [key, value] of Object.entries(settings)) {
    await db.setting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(value) },
      update: {},
    });
  }
  console.log(`  ${Object.keys(settings).length} settings`);

  // --- Receipt counter -----------------------------------------------------
  const terminal = process.env.TERMINAL_ID ?? "T1";
  await db.receiptCounter.upsert({
    where: { terminalId: terminal },
    create: { terminalId: terminal, prefix: terminal, nextNumber: 1 },
    update: {},
  });
  console.log(`  receipt counter for terminal ${terminal}`);

  console.log("\nDone. Sign in at /login with a PIN alone:");
  for (const member of staff) {
    console.log(`  ${member.pin}  ${member.name} (${member.role})`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
