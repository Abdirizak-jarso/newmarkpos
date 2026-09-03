import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requirePermission, AuthorisationError } from "@/lib/session";
import { terminalId } from "@/lib/receipt-number";

/**
 * Push this terminal's records to the central server.
 *
 * The till is local-first: everything is already committed to the terminal's
 * own database before it gets here, so this endpoint moves copies, never the
 * originals. A failure leaves the queue exactly as it was and the shop
 * unaffected.
 *
 * With no SYNC_ENDPOINT configured — a single-till shop, which is where
 * Newmark starts — this reports the queue depth and does nothing else.
 */

const MAX_ATTEMPTS = 20;
const BATCH = 50;

export async function POST() {
  try {
    await requirePermission("report.sales");

    const endpoint = process.env.SYNC_ENDPOINT ?? "";
    const pending = await db.syncQueue.count({ where: { status: "PENDING" } });

    if (endpoint === "") {
      return NextResponse.json({
        sent: 0,
        pending,
        detail: "No central server configured — this till keeps its own records.",
      });
    }

    const queued = await db.syncQueue.findMany({
      where: { status: "PENDING", attempts: { lt: MAX_ATTEMPTS } },
      orderBy: { createdAt: "asc" },
      take: BATCH,
    });

    let sent = 0;
    let lastError: string | undefined;

    for (const item of queued) {
      try {
        const body = await payloadFor(item.entity, item.entityId);
        if (!body) {
          // The row it referred to is gone. Nothing to send and nothing to fix.
          await db.syncQueue.update({
            where: { id: item.id },
            data: { status: "SENT", sentAt: new Date(), lastError: "Source record no longer exists" },
          });
          continue;
        }

        const response = await fetch(endpoint.replace(/\/$/, "") + "/ingest", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-terminal-id": terminalId(),
            ...(process.env.SYNC_API_KEY ? { authorization: `Bearer ${process.env.SYNC_API_KEY}` } : {}),
          },
          body: JSON.stringify({ entity: item.entity, entityId: item.entityId, data: body }),
        });

        if (!response.ok) {
          lastError = `Server returned ${response.status}`;
          await db.syncQueue.update({
            where: { id: item.id },
            data: { attempts: item.attempts + 1, lastError },
          });
          // A server that is unwell will be unwell for the next row too.
          break;
        }

        await db.syncQueue.update({
          where: { id: item.id },
          data: { status: "SENT", sentAt: new Date(), lastError: null },
        });
        sent += 1;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await db.syncQueue.update({
          where: { id: item.id },
          data: { attempts: item.attempts + 1, lastError },
        });
        break;
      }
    }

    return NextResponse.json({
      sent,
      pending: await db.syncQueue.count({ where: { status: "PENDING" } }),
      lastError,
    });
  } catch (error) {
    if (error instanceof AuthorisationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error("[api/sync] failed", error);
    return NextResponse.json({ sent: 0, error: "Could not drain the sync queue" });
  }
}

/** Fetch the full record the queue entry points at. */
async function payloadFor(entity: string, entityId: string): Promise<unknown> {
  switch (entity) {
    case "SALE":
      return db.sale.findUnique({
        where: { id: entityId },
        include: { lines: true, payments: true },
      });
    case "STOCK_MOVEMENT":
      return db.stockMovement.findUnique({ where: { id: entityId } });
    case "BREAKDOWN":
      return db.carcassBreakdown.findUnique({
        where: { id: entityId },
        include: { outputs: true },
      });
    default:
      return null;
  }
}

/** Queue depth, for the back office to display without draining anything. */
export async function GET() {
  try {
    await requirePermission("report.sales");
    return NextResponse.json({
      pending: await db.syncQueue.count({ where: { status: "PENDING" } }),
      failed: await db.syncQueue.count({ where: { status: "FAILED" } }),
      configured: (process.env.SYNC_ENDPOINT ?? "") !== "",
    });
  } catch (error) {
    if (error instanceof AuthorisationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    return NextResponse.json({ pending: 0, failed: 0, configured: false });
  }
}
