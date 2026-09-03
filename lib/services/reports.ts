import "server-only";
import { db } from "../db";
import { sumCents, type Cents } from "../money";
import { costOfWeight, margin, type Margin } from "../cost";
import type { Grams } from "../weight";

/**
 * Reports.
 *
 * All figures come out of the stored sale rows, which were written by
 * lib/pricing.ts — so a report and the receipts agree by construction rather
 * than by two implementations happening to match.
 *
 * Voided sales are excluded everywhere. Refunds are included as the negative
 * sales they were recorded as, so takings net out without special-casing.
 */

export interface SalesSummary {
  from: Date;
  to: Date;
  saleCount: number;
  refundCount: number;
  gross: Cents;
  discount: Cents;
  net: Cents;
  tax: Cents;
  weightGrams: Grams;
  averageSale: Cents;
  byMethod: { method: string; count: number; amount: Cents }[];
  byCategory: { category: string; net: Cents; weightGrams: Grams; cost: Cents; margin: Margin }[];
  topProducts: {
    sku: string;
    name: string;
    net: Cents;
    weightGrams: Grams;
    lines: number;
    cost: Cents;
    margin: Margin;
  }[];
  /**
   * What the meat sold in this period cost the shop, and what it made on it.
   *
   * `costed` is the share of revenue whose cost is actually known — a product
   * that has never been through an intake or a breakdown has no cost on file,
   * and counting it as free would flatter the margin. Anything below 100% means
   * the margin is a floor, not a figure.
   */
  margin: Margin;
  costedPercent: number;
  /** Reductions given at the counter, which come straight off the margin. */
  givenAway: Cents;
}

export async function salesSummary(from: Date, to: Date): Promise<SalesSummary> {
  const sales = await db.sale.findMany({
    where: {
      status: { in: ["COMPLETED", "REFUNDED"] },
      completedAt: { gte: from, lte: to },
    },
    include: {
      lines: { include: { product: { include: { category: true } } } },
      payments: true,
    },
  });

  const refunds = sales.filter((s) => s.total < 0);

  const byMethod = new Map<string, { count: number; amount: Cents }>();
  for (const sale of sales) {
    for (const payment of sale.payments) {
      const entry = byMethod.get(payment.method) ?? { count: 0, amount: 0 };
      entry.count += 1;
      entry.amount += payment.amount;
      byMethod.set(payment.method, entry);
    }
  }

  const byCategory = new Map<string, { net: Cents; weightGrams: Grams; cost: Cents }>();
  const byProduct = new Map<
    string,
    { sku: string; name: string; net: Cents; weightGrams: Grams; lines: number; cost: Cents }
  >();

  let totalCost = 0;
  let costedRevenue = 0;
  let givenAway = 0;

  for (const sale of sales) {
    for (const line of sale.lines) {
      totalCost += line.cost;
      // Revenue we can actually put a cost against. The rest is uncosted, and
      // saying so is the difference between a margin and a guess.
      if (line.cost > 0) costedRevenue += line.net;
      givenAway += line.discount;

      const categoryName = line.product.category.name;
      const category = byCategory.get(categoryName) ?? { net: 0, weightGrams: 0, cost: 0 };
      category.net += line.net;
      category.weightGrams += line.stockGrams;
      category.cost += line.cost;
      byCategory.set(categoryName, category);

      const product = byProduct.get(line.sku) ?? {
        sku: line.sku,
        name: line.name,
        net: 0,
        weightGrams: 0,
        lines: 0,
        cost: 0,
      };
      product.net += line.net;
      product.weightGrams += line.stockGrams;
      product.cost += line.cost;
      product.lines += 1;
      byProduct.set(line.sku, product);
    }
  }

  const net = sumCents(sales.map((s) => s.total));
  const positiveSales = sales.filter((s) => s.total >= 0);

  return {
    from,
    to,
    saleCount: positiveSales.length,
    refundCount: refunds.length,
    gross: sumCents(sales.map((s) => s.gross)),
    discount: sumCents(sales.map((s) => s.discount)),
    net,
    tax: sumCents(sales.map((s) => s.tax)),
    weightGrams: sales.reduce((total, s) => total + s.totalWeightGrams, 0),
    averageSale: positiveSales.length === 0 ? 0 : Math.round(net / positiveSales.length),
    byMethod: [...byMethod.entries()]
      .map(([method, v]) => ({ method, ...v }))
      .sort((a, b) => b.amount - a.amount),
    byCategory: [...byCategory.entries()]
      .map(([category, v]) => ({ category, ...v, margin: margin(v.net, v.cost) }))
      .sort((a, b) => b.net - a.net),
    topProducts: [...byProduct.values()]
      .map((product) => ({ ...product, margin: margin(product.net, product.cost) }))
      .sort((a, b) => b.net - a.net)
      .slice(0, 20),
    margin: margin(net, totalCost),
    costedPercent: net === 0 ? 0 : Math.round((costedRevenue / net) * 1000) / 10,
    givenAway,
  };
}

export interface MarginRow {
  sku: string;
  name: string;
  weightGrams: Grams;
  revenue: Cents;
  cost: Cents;
  /** Reductions given at the counter on this cut — margin handed over by hand. */
  givenAway: Cents;
  margin: Cents;
  marginPercent: number;
}

/**
 * Margin by product. Cost comes from the product's cost per kg, which intake
 * and carcass breakdown keep current — so a cut whose real cost rose because
 * the last carcass shrank more than usual shows up here.
 */
export async function marginReport(from: Date, to: Date): Promise<MarginRow[]> {
  const lines = await db.saleLine.findMany({
    where: {
      sale: { status: { in: ["COMPLETED", "REFUNDED"] }, completedAt: { gte: from, lte: to } },
    },
    include: { product: { select: { costPerKg: true } } },
  });

  const rows = new Map<string, MarginRow>();
  for (const line of lines) {
    const row = rows.get(line.sku) ?? {
      sku: line.sku,
      name: line.name,
      weightGrams: 0,
      revenue: 0,
      cost: 0,
      givenAway: 0,
      margin: 0,
      marginPercent: 0,
    };
    row.weightGrams += line.stockGrams;
    row.revenue += line.net;
    row.givenAway += line.discount;
    /*
     * The cost stamped on the line when it was sold.
     *
     * This used to read the product's cost as it stands TODAY, which meant
     * every delivery quietly reprised last month's margins — a figure that
     * moved after the fact. Lines written before the column existed have no
     * stamp, so they still fall back to today's cost; that is the old, wrong
     * behaviour, kept only so historic rows show something rather than a
     * hundred percent margin.
     */
    row.cost +=
      line.cost > 0 ? line.cost : costOfWeight(line.product.costPerKg, line.stockGrams);
    rows.set(line.sku, row);
  }

  return [...rows.values()]
    .map((row) => {
      const m = margin(row.revenue, row.cost);
      return { ...row, margin: m.profit, marginPercent: m.percent };
    })
    .sort((a, b) => b.margin - a.margin);
}

export interface BreakdownYieldRow {
  sku: string;
  name: string;
  breakdowns: number;
  averageYieldPercent: number;
  totalWeightGrams: Grams;
}

/** How much each cut typically yields, so an off day is visible against it. */
export async function yieldReport(from: Date, to: Date): Promise<{
  breakdowns: number;
  averageLossPercent: number;
  rows: BreakdownYieldRow[];
}> {
  const breakdowns = await db.carcassBreakdown.findMany({
    where: { createdAt: { gte: from, lte: to } },
    include: { outputs: { include: { product: true } } },
  });

  const rows = new Map<string, { sku: string; name: string; yields: number[]; grams: number }>();
  for (const breakdown of breakdowns) {
    for (const output of breakdown.outputs) {
      const row = rows.get(output.product.sku) ?? {
        sku: output.product.sku,
        name: output.product.name,
        yields: [],
        grams: 0,
      };
      row.yields.push(output.yieldTenths / 10);
      row.grams += output.weightGrams;
      rows.set(output.product.sku, row);
    }
  }

  const averageLossPercent =
    breakdowns.length === 0
      ? 0
      : Math.round(
          (breakdowns.reduce((t, b) => t + b.lossPercentTenths / 10, 0) / breakdowns.length) * 10,
        ) / 10;

  return {
    breakdowns: breakdowns.length,
    averageLossPercent,
    rows: [...rows.values()]
      .map((row) => ({
        sku: row.sku,
        name: row.name,
        breakdowns: row.yields.length,
        averageYieldPercent:
          Math.round((row.yields.reduce((a, b) => a + b, 0) / row.yields.length) * 10) / 10,
        totalWeightGrams: row.grams,
      }))
      .sort((a, b) => b.averageYieldPercent - a.averageYieldPercent),
  };
}

export function startOfDay(at = new Date()): Date {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfDay(at = new Date()): Date {
  const d = new Date(at);
  d.setHours(23, 59, 59, 999);
  return d;
}

export interface CarcassLedgerEntry {
  breakdownId: string;
  sourceName: string;
  supplier: string | null;
  brokenDownAt: Date;
  actor: string;

  inputWeightGrams: Grams;
  outputWeightGrams: Grams;
  lossGrams: Grams;
  lossPercent: number;

  /** What the carcass cost to buy. */
  costIn: Cents;
  /** Every cut it produced, valued at today's board price. The best case. */
  boardValue: Cents;

  /** What those cuts actually sold for, in the window this carcass supplied. */
  sold: Cents;
  soldGrams: Grams;
  /** Reductions given at the counter on those sales. */
  givenAway: Cents;
  /** Board value of the cuts still unsold, at the end of the window. */
  onHandValue: Cents;

  /** sold - costIn, once everything is sold. Until then, read it with recovered. */
  realised: Cents;
  /** Share of the carcass's own cost that has been sold through. */
  recoveredPercent: number;

  outputs: {
    sku: string;
    name: string;
    weightGrams: Grams;
    yieldPercent: number;
    costPerKg: Cents;
    boardPricePerKg: Cents;
    isByProduct: boolean;
  }[];
}

/**
 * The carcass ledger.
 *
 * A butchery's real question is not what it sold today, it is whether the animal
 * it bought on Tuesday was worth buying. Everything needed to answer that is
 * already recorded — the carcass cost, the yields, the trim loss, the board
 * prices, the sales — and until now nothing put the two halves together.
 *
 * ONE HONEST LIMITATION, and it is worth stating rather than hiding behind a
 * confident-looking number: cuts are not lot-traced. Once a leg goes into the
 * case it is indistinguishable from last week's leg. So sales are attributed to
 * a carcass by TIME — the window from this breakdown until the next breakdown
 * of the same source animal. That is right when the shop breaks down one animal
 * at a time and sells it through, which is how this counter works, and it drifts
 * when two carcasses of the same source overlap in the case. The window is shown
 * so the figure can be read for what it is.
 */
export async function carcassLedger(from: Date, to: Date): Promise<CarcassLedgerEntry[]> {
  const breakdowns = await db.carcassBreakdown.findMany({
    where: { createdAt: { gte: from, lte: to } },
    include: {
      sourceProduct: true,
      actor: { select: { name: true } },
      outputs: { include: { product: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const entries: CarcassLedgerEntry[] = [];

  for (const breakdown of breakdowns) {
    // The window this carcass supplied: from when it was broken down until the
    // next one off the same animal, or now if it is the most recent.
    const next = await db.carcassBreakdown.findFirst({
      where: {
        sourceProductId: breakdown.sourceProductId,
        createdAt: { gt: breakdown.createdAt },
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    const windowEnd = next?.createdAt ?? new Date();

    const productIds = breakdown.outputs.map((output) => output.productId);

    const lines = await db.saleLine.findMany({
      where: {
        productId: { in: productIds },
        sale: {
          status: { not: "VOIDED" },
          createdAt: { gte: breakdown.createdAt, lt: windowEnd },
        },
      },
      select: { net: true, discount: true, stockGrams: true },
    });

    const sold = sumCents(lines.map((line) => line.net));
    const soldGrams = lines.reduce((total, line) => total + line.stockGrams, 0);
    const givenAway = sumCents(lines.map((line) => line.discount));

    const boardValue = breakdown.outputs.reduce(
      (total, output) => total + Math.round((output.product.price * output.weightGrams) / 1000),
      0,
    );

    // What is left of this carcass, valued at the board price. Capped at what
    // the carcass produced, since the case may also hold older stock.
    const unsoldGrams = Math.max(0, breakdown.outputWeightGrams - soldGrams);
    const onHandValue =
      breakdown.outputWeightGrams === 0
        ? 0
        : Math.round((boardValue * unsoldGrams) / breakdown.outputWeightGrams);

    entries.push({
      breakdownId: breakdown.id,
      sourceName: breakdown.sourceProduct.name,
      supplier: breakdown.supplier,
      brokenDownAt: breakdown.createdAt,
      actor: breakdown.actor.name,

      inputWeightGrams: breakdown.inputWeightGrams,
      outputWeightGrams: breakdown.outputWeightGrams,
      lossGrams: breakdown.lossGrams,
      lossPercent: breakdown.lossPercentTenths / 10,

      costIn: breakdown.inputCost,
      boardValue,
      sold,
      soldGrams,
      givenAway,
      onHandValue,

      realised: sold - breakdown.inputCost,
      recoveredPercent:
        breakdown.inputCost === 0 ? 0 : Math.round((sold / breakdown.inputCost) * 1000) / 10,

      outputs: breakdown.outputs
        .map((output) => ({
          sku: output.product.sku,
          name: output.product.name,
          weightGrams: output.weightGrams,
          yieldPercent: output.yieldTenths / 10,
          costPerKg: output.costPerKg,
          boardPricePerKg: output.product.price,
          isByProduct: output.isByProduct,
        }))
        .sort((a, b) => b.weightGrams - a.weightGrams),
    });
  }

  return entries;
}
