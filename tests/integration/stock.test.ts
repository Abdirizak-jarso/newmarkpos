import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { adjustStock, countStock, receiveStock, recordBreakdown } from "@/lib/services/stock";
import { yieldReport } from "@/lib/services/reports";
import type { CurrentUser } from "@/lib/session";

/**
 * Stock, and the carcass breakdown that feeds it.
 *
 * The thing being protected here is that nothing moves stock anonymously and
 * that breakdown loss is recorded rather than absorbed — which is where a
 * butchery's margin actually goes.
 */

let admin: CurrentUser;
let carcassId: string;
let minceId: string;
let soupBonesId: string;

beforeAll(async () => {
  const row = await db.user.findUniqueOrThrow({ where: { staffCode: "1000" } });
  admin = { id: row.id, name: row.name, staffCode: "1000", role: "ADMIN" };

  carcassId = (await db.product.findUniqueOrThrow({ where: { sku: "BEEF-WHOLE-CARCASS" } })).id;
  minceId = (await db.product.findUniqueOrThrow({ where: { sku: "BEEF-MINCE-MEAT" } })).id;
  soupBonesId = (await db.product.findUniqueOrThrow({ where: { sku: "BEEF-SOUP-BONES" } })).id;
});

describe("stock movements", () => {
  it("records an intake against the person who received it", async () => {
    const before = await db.product.findUniqueOrThrow({ where: { id: minceId } });

    const result = await receiveStock(
      {
        productId: minceId,
        weightGrams: 25_000,
        costPerKg: 540_00,
        supplier: "Kiamaiko Abattoir",
        note: "Morning delivery",
      },
      admin,
    );

    expect(result.balanceGrams).toBe(before.stockGrams + 25_000);

    const movement = await db.stockMovement.findFirstOrThrow({
      where: { productId: minceId, reason: "INTAKE" },
      orderBy: { createdAt: "desc" },
    });
    expect(movement.actorId).toBe(admin.id);
    expect(movement.note).toContain("Kiamaiko Abattoir");
    expect(movement.costPerKg).toBe(540_00);

    // Intake updates what the cut costs, which is what the margin report reads.
    const after = await db.product.findUniqueOrThrow({ where: { id: minceId } });
    expect(after.costPerKg).toBe(540_00);
  });

  it("writes off waste only with a admin PIN and a note", async () => {
    const before = await db.product.findUniqueOrThrow({ where: { id: minceId } });

    const result = await adjustStock(
      {
        productId: minceId,
        deltaGrams: -1_500,
        reason: "WASTE",
        note: "Left out of the chiller overnight",
        approval: { pin: "907143" },
      },
      admin,
    );

    expect(result.balanceGrams).toBe(before.stockGrams - 1_500);

    const entry = await db.auditEvent.findFirstOrThrow({
      where: { action: "STOCK_WASTE", entityId: minceId },
      orderBy: { createdAt: "desc" },
    });
    expect(entry.approverId).toBe(admin.id);
    expect(entry.before).toContain(String(before.stockGrams));
    expect(entry.reason).toBe("Left out of the chiller overnight");
  });

  it("refuses a write-off on a wrong PIN", async () => {
    await expect(
      adjustStock(
        {
          productId: minceId,
          deltaGrams: -1_000,
          reason: "WASTE",
          note: "Trying it on",
          approval: { pin: "999999" },
        },
        admin,
      ),
    ).rejects.toThrow(/not recognised/);
  });

  it("keeps a stocktake variance visible instead of overwriting it", async () => {
    const before = await db.product.findUniqueOrThrow({ where: { id: minceId } });
    const counted = before.stockGrams - 850;

    const result = await countStock({ productId: minceId, countedGrams: counted }, admin);

    expect(result.varianceGrams).toBe(-850);
    expect(result.balanceGrams).toBe(counted);

    const movement = await db.stockMovement.findFirstOrThrow({
      where: { productId: minceId, reason: "COUNT" },
      orderBy: { createdAt: "desc" },
    });
    expect(movement.deltaGrams).toBe(-850);
  });

  it("does nothing when the count agrees with the system", async () => {
    const before = await db.product.findUniqueOrThrow({ where: { id: minceId } });
    const result = await countStock(
      { productId: minceId, countedGrams: before.stockGrams },
      admin,
    );
    expect(result.varianceGrams).toBe(0);
  });
});

describe("carcass breakdown", () => {
  it("turns one carcass into cuts and records the loss", async () => {
    await receiveStock(
      { productId: carcassId, weightGrams: 180_000, costPerKg: 750_00, supplier: "Test" },
      admin,
    );

    const carcassBefore = await db.product.findUniqueOrThrow({ where: { id: carcassId } });
    const bonesBefore = await db.product.findUniqueOrThrow({ where: { id: soupBonesId } });

    const result = await recordBreakdown(
      {
        sourceProductId: carcassId,
        inputWeightGrams: 180_000,
        inputCost: 135_000_00,
        outputs: [
          { productId: minceId, weightGrams: 90_000 },
          { productId: soupBonesId, weightGrams: 55_000 },
        ],
        supplier: "Test",
      },
      admin,
    );

    // 180 kg in, 145 kg of cuts out, 35 kg lost to trim and bone dust.
    expect(result.lossGrams).toBe(35_000);
    expect(result.lossPercent).toBe(19.4);

    const carcassAfter = await db.product.findUniqueOrThrow({ where: { id: carcassId } });
    expect(carcassAfter.stockGrams).toBe(carcassBefore.stockGrams - 180_000);

    const bonesAfter = await db.product.findUniqueOrThrow({ where: { id: soupBonesId } });
    expect(bonesAfter.stockGrams).toBe(bonesBefore.stockGrams + 55_000);
  });

  it("brings by-products into stock from the breakdown, not a purchase", async () => {
    const movement = await db.stockMovement.findFirstOrThrow({
      where: { productId: soupBonesId, reason: "BREAKDOWN_OUT" },
      orderBy: { createdAt: "desc" },
    });
    expect(movement.deltaGrams).toBeGreaterThan(0);
    expect(movement.breakdownId).toBeTruthy();
  });

  it("makes every cut dearer than the carcass, because the loss is real", async () => {
    const mince = await db.product.findUniqueOrThrow({ where: { id: minceId } });
    // KSh 750/kg went in; with 19.4% loss the recovered meat has to cost more.
    expect(mince.costPerKg).toBeGreaterThan(750_00);
  });

  it("allocates the whole carcass cost across the outputs", async () => {
    const breakdown = await db.carcassBreakdown.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
      include: { outputs: true },
    });
    const allocated = breakdown.outputs.reduce((total, o) => total + o.costAllocated, 0);
    expect(allocated).toBe(breakdown.inputCost);
  });

  it("audits the breakdown with the yields it produced", async () => {
    const entry = await db.auditEvent.findFirstOrThrow({
      where: { action: "BREAKDOWN" },
      orderBy: { createdAt: "desc" },
    });
    expect(entry.actorId).toBe(admin.id);
    expect(entry.after).toContain("lossGrams");
    expect(entry.after).toContain("BEEF-SOUP-BONES");
  });

  it("refuses outputs heavier than the carcass", async () => {
    await expect(
      recordBreakdown(
        {
          sourceProductId: carcassId,
          inputWeightGrams: 10_000,
          inputCost: 7_500_00,
          outputs: [{ productId: minceId, weightGrams: 50_000 }],
        },
        admin,
      ),
    ).rejects.toThrow(/cannot be created/);
  });

  it("reports the yields back for comparison against the next carcass", async () => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const to = new Date();
    to.setHours(23, 59, 59, 999);

    const report = await yieldReport(from, to);
    expect(report.breakdowns).toBeGreaterThan(0);
    expect(report.averageLossPercent).toBeGreaterThan(0);

    const bones = report.rows.find((row) => row.sku === "BEEF-SOUP-BONES");
    expect(bones?.averageYieldPercent).toBeCloseTo(30.6, 1);
  });
});
