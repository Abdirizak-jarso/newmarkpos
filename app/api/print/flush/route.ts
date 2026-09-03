import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createPrinter, drainPrintQueue, MAX_PRINT_ATTEMPTS } from "@/lib/adapters/printer";
import { requirePermission, AuthorisationError } from "@/lib/session";

/**
 * Drain the print queue.
 *
 * Called after a sale, from the "retry print" button, and on a timer. Always
 * returns 200 with a report — a printer that is switched off is information
 * for the cashier, not an error condition for the application.
 */
export async function POST() {
  try {
    await requirePermission("sale.reprint");

    const printer = createPrinter();
    const result = await drainPrintQueue(printer, {
      async claimNext() {
        const job = await db.printJob.findFirst({
          where: { status: { in: ["QUEUED", "FAILED"] }, attempts: { lt: MAX_PRINT_ATTEMPTS } },
          orderBy: { createdAt: "asc" },
        });
        if (!job) return null;

        await db.printJob.update({ where: { id: job.id }, data: { status: "PRINTING" } });
        return { id: job.id, kind: job.kind, payload: job.payload, attempts: job.attempts };
      },
      async markDone(id) {
        await db.printJob.update({
          where: { id },
          data: { status: "DONE", completedAt: new Date() },
        });
      },
      async markFailed(id, error, attempts) {
        await db.printJob.update({
          where: { id },
          data: { status: "FAILED", lastError: error, attempts },
        });
      },
    });

    const pending = await db.printJob.count({ where: { status: { in: ["QUEUED", "FAILED"] } } });
    const status = await printer.status();

    // The caller needs to know WHICH kind of "printed" this was. NoopPrinter
    // reports success so the queue drains instead of backing up forever, but
    // telling the cashier "printed" when no printer exists is a lie they will
    // act on — they will hand a customer a receipt that never came out.
    return NextResponse.json({
      ...result,
      pending,
      adapter: status.adapter,
      connected: status.connected,
    });
  } catch (error) {
    if (error instanceof AuthorisationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error("[api/print/flush] failed", error);
    return NextResponse.json({ printed: 0, failed: 0, lastError: "Print queue unavailable" });
  }
}
