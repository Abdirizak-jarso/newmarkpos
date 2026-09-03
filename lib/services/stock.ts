import "server-only";
import { db } from "../db";
import { record } from "../audit";
import { verifyApprover, type CurrentUser } from "../session";
import { computeBreakdown, breakdownWarnings, assertCostBalances } from "../breakdown";
import { blendCost } from "../cost";
import type { z } from "zod";
import type {
  breakdownSchema,
  stockAdjustmentSchema,
  stockCountSchema,
  stockIntakeSchema,
} from "../validation";

/**
 * Stock movements.
 *
 * Every function here writes a StockMovement with a reason code and an actor.
 * Nothing in this application changes `Product.stockGrams` without one — if
 * you find yourself writing a bare `product.update({ stockGrams })`, you are
 * about to make the stock history unreconstructable.
 */

export async function move(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  args: {
    productId: string;
    deltaGrams: number;
    reason: string;
    actorId: string;
    note?: string;
    costPerKg?: number;
    breakdownId?: string;
    saleId?: string;
  },
): Promise<number> {
  const product = await tx.product.findUnique({ where: { id: args.productId } });
  if (!product) throw new Error("Product not found");

  const balance = product.stockGrams + args.deltaGrams;

  /*
   * Cost blends on the way in, and only on the way in.
   *
   * Meat leaving the shop does not change what the meat still in the case cost,
   * so a sale, a waste write-off or a downward correction carries no cost at
   * all. What arrives does: twenty kilos held at 600/kg and two arriving at
   * 900/kg is a 627/kg product, not a 900/kg one. Overwriting on each delivery
   * — which is what this used to do — made the margin lurch with the last
   * invoice and reported a figure that was never true of the stock on hand.
   */
  const costPerKg =
    args.deltaGrams > 0 && args.costPerKg !== undefined && args.costPerKg > 0
      ? blendCost(product.stockGrams, product.costPerKg, args.deltaGrams, args.costPerKg)
      : product.costPerKg;

  await tx.product.update({
    where: { id: args.productId },
    data: { stockGrams: balance, costPerKg },
  });

  await tx.stockMovement.create({
    data: {
      productId: args.productId,
      deltaGrams: args.deltaGrams,
      balanceGrams: balance,
      reason: args.reason,
      note: args.note,
      // What this delivery cost per kg — not the blended average — so the
      // ledger can be rebuilt from the movements alone.
      costPerKg: args.costPerKg,
      actorId: args.actorId,
      breakdownId: args.breakdownId,
      saleId: args.saleId,
    },
  });

  return balance;
}

export async function receiveStock(
  input: z.infer<typeof stockIntakeSchema>,
  actor: CurrentUser,
): Promise<{ balanceGrams: number }> {
  const balance = await db.$transaction((tx) =>
    move(tx, {
      productId: input.productId,
      deltaGrams: input.weightGrams,
      reason: "INTAKE",
      actorId: actor.id,
      note: [input.supplier, input.note].filter(Boolean).join(" — ") || undefined,
      costPerKg: input.costPerKg,
    }),
  );

  await record({
    action: "STOCK_INTAKE",
    entity: "Product",
    entityId: input.productId,
    after: { weightGrams: input.weightGrams, costPerKg: input.costPerKg, supplier: input.supplier },
    actorId: actor.id,
  });

  return { balanceGrams: balance };
}

/** A manual correction. Always needs a manager PIN and always says why. */
export async function adjustStock(
  input: z.infer<typeof stockAdjustmentSchema>,
  actor: CurrentUser,
): Promise<{ balanceGrams: number }> {
  const approver = await verifyApprover(input.approval.pin, "stock.adjust");

  const before = await db.product.findUnique({
    where: { id: input.productId },
    select: { stockGrams: true, name: true },
  });
  if (!before) throw new Error("Product not found");

  const balance = await db.$transaction((tx) =>
    move(tx, {
      productId: input.productId,
      deltaGrams: input.deltaGrams,
      reason: input.reason,
      actorId: actor.id,
      note: input.note,
    }),
  );

  await record({
    action: input.reason === "WASTE" ? "STOCK_WASTE" : "STOCK_ADJUSTMENT",
    entity: "Product",
    entityId: input.productId,
    before: { stockGrams: before.stockGrams },
    after: { stockGrams: balance, deltaGrams: input.deltaGrams, reason: input.reason },
    actorId: actor.id,
    approverId: approver.id,
    reason: input.note,
  });

  return { balanceGrams: balance };
}

/**
 * A stocktake. The counted figure becomes the truth and the difference is
 * recorded as its own movement — the variance is the number worth looking at,
 * so it must never be quietly overwritten.
 */
export async function countStock(
  input: z.infer<typeof stockCountSchema>,
  actor: CurrentUser,
): Promise<{ varianceGrams: number; balanceGrams: number }> {
  const product = await db.product.findUnique({
    where: { id: input.productId },
    select: { stockGrams: true },
  });
  if (!product) throw new Error("Product not found");

  const variance = input.countedGrams - product.stockGrams;
  if (variance === 0) return { varianceGrams: 0, balanceGrams: product.stockGrams };

  const balance = await db.$transaction((tx) =>
    move(tx, {
      productId: input.productId,
      deltaGrams: variance,
      reason: "COUNT",
      actorId: actor.id,
      note: input.note ?? `Counted ${(input.countedGrams / 1000).toFixed(3)} kg`,
    }),
  );

  await record({
    action: "STOCK_COUNT",
    entity: "Product",
    entityId: input.productId,
    before: { stockGrams: product.stockGrams },
    after: { stockGrams: balance, varianceGrams: variance },
    actorId: actor.id,
    reason: input.note,
  });

  return { varianceGrams: variance, balanceGrams: balance };
}

/**
 * Carcass breakdown.
 *
 * One bulk intake goes out, several products come in, and the difference is
 * recorded as loss. The carcass cost is spread across the outputs by weight so
 * the shrinkage makes every cut correctly dearer instead of vanishing.
 */
export async function recordBreakdown(
  input: z.infer<typeof breakdownSchema>,
  actor: CurrentUser,
): Promise<{ breakdownId: string; lossGrams: number; lossPercent: number; warnings: string[] }> {
  const source = await db.product.findUnique({ where: { id: input.sourceProductId } });
  if (!source) throw new Error("Source product not found");

  const outputProducts = await db.product.findMany({
    where: { id: { in: input.outputs.map((o) => o.productId) } },
  });
  const byId = new Map(outputProducts.map((p) => [p.id, p]));

  for (const output of input.outputs) {
    if (!byId.has(output.productId)) throw new Error("An output product is not in the catalogue");
  }

  const result = computeBreakdown({
    sourceProductId: source.id,
    sourceSku: source.sku,
    inputWeightGrams: input.inputWeightGrams,
    // Cost the carcass from the intake price when none is given, so the
    // outputs still get a defensible cost per kg.
    inputCost:
      input.inputCost > 0
        ? input.inputCost
        : Math.round((source.costPerKg * input.inputWeightGrams) / 1000),
    outputs: input.outputs.map((output) => {
      const product = byId.get(output.productId)!;
      return {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        weightGrams: output.weightGrams,
        isByProduct: product.isByProduct,
      };
    }),
  });

  assertCostBalances(result);

  const breakdown = await db.$transaction(async (tx) => {
    const created = await tx.carcassBreakdown.create({
      data: {
        sourceProductId: source.id,
        inputWeightGrams: result.inputWeightGrams,
        inputCost: result.inputCost,
        outputWeightGrams: result.outputWeightGrams,
        lossGrams: result.lossGrams,
        // Stored as tenths so the loss percentage stays an integer column.
        lossPercentTenths: Math.round(result.lossPercent * 10),
        supplier: input.supplier,
        notes: input.notes,
        actorId: actor.id,
        outputs: {
          create: result.outputs.map((output) => ({
            productId: output.productId,
            weightGrams: output.weightGrams,
            yieldTenths: Math.round(output.yieldPercent * 10),
            costAllocated: output.costAllocated,
            costPerKg: output.costPerKg,
            isByProduct: output.isByProduct,
          })),
        },
      },
    });

    // The carcass leaves stock...
    await move(tx, {
      productId: source.id,
      deltaGrams: -result.inputWeightGrams,
      reason: "BREAKDOWN_IN",
      actorId: actor.id,
      note: `Broken down into ${result.outputs.length} products`,
      breakdownId: created.id,
    });

    // ...and the cuts arrive, each carrying its share of the cost.
    for (const output of result.outputs) {
      await move(tx, {
        productId: output.productId,
        deltaGrams: output.weightGrams,
        reason: "BREAKDOWN_OUT",
        actorId: actor.id,
        note: `From ${source.sku} — ${output.yieldPercent}% yield`,
        costPerKg: output.costPerKg,
        breakdownId: created.id,
      });
    }

    return created;
  });

  await record({
    action: "BREAKDOWN",
    entity: "CarcassBreakdown",
    entityId: breakdown.id,
    after: {
      source: source.sku,
      inputWeightGrams: result.inputWeightGrams,
      outputWeightGrams: result.outputWeightGrams,
      lossGrams: result.lossGrams,
      lossPercent: result.lossPercent,
      outputs: result.outputs.map((o) => ({ sku: o.sku, grams: o.weightGrams, yield: o.yieldPercent })),
    },
    actorId: actor.id,
    reason: input.notes,
  });

  return {
    breakdownId: breakdown.id,
    lossGrams: result.lossGrams,
    lossPercent: result.lossPercent,
    warnings: breakdownWarnings(result),
  };
}

export async function lowStockProducts(thresholdGrams: number) {
  return db.product.findMany({
    where: {
      active: true,
      OR: [
        { reorderLevelGrams: { not: null } },
        { stockGrams: { lte: thresholdGrams } },
      ],
    },
    orderBy: { stockGrams: "asc" },
    select: {
      id: true,
      sku: true,
      name: true,
      stockGrams: true,
      reorderLevelGrams: true,
      category: { select: { name: true } },
    },
  });
}
