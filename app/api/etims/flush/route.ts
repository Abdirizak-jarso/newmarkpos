import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createTaxAuthority } from "@/lib/adapters/tax-authority";
import { requirePermission, AuthorisationError } from "@/lib/session";
import { cartLineFromSaleLine, totalsFromSaleLines } from "@/lib/services/sales";

/**
 * Submit pending invoices to KRA eTIMS.
 *
 * Runs after the fact, never inside checkout. A sale is complete the moment
 * the customer has paid; whether KRA has acknowledged it is a separate
 * question that this endpoint answers later, and retries until it can.
 *
 * Called on a timer from the back office, or by hand from the settings page.
 */

const MAX_ATTEMPTS = 10;

export async function POST() {
  try {
    await requirePermission("report.sales");

    const authority = createTaxAuthority();
    if (!authority.enabled) {
      return NextResponse.json({
        submitted: 0,
        pending: await db.taxInvoice.count({ where: { status: "PENDING" } }),
        detail: "eTIMS is not configured — invoices are held locally and the shop trades normally.",
      });
    }

    const queued = await db.taxInvoice.findMany({
      where: { status: "PENDING", attempts: { lt: MAX_ATTEMPTS } },
      orderBy: { createdAt: "asc" },
      take: 25,
      include: {
        sale: { include: { lines: { orderBy: { sortOrder: "asc" } } } },
      },
    });

    let submitted = 0;
    let rejected = 0;
    let lastError: string | undefined;

    for (const invoice of queued) {
      const sale = invoice.sale;

      // A sale voided after the fact must never reach the tax authority.
      if (sale.status === "VOIDED") {
        await db.taxInvoice.update({
          where: { id: invoice.id },
          data: { status: "NOT_APPLICABLE" },
        });
        continue;
      }

      const totals = totalsFromSaleLines(sale.lines.map(cartLineFromSaleLine));
      totals.total = sale.total;
      totals.tax = sale.tax;

      const result = await authority.submit({
        saleId: sale.id,
        receiptNumber: sale.receiptNumber,
        at: sale.completedAt ?? sale.createdAt,
        totals,
        customerName: sale.customerName ?? undefined,
        customerPin: sale.customerPin ?? undefined,
        isCreditNote: sale.total < 0,
      });

      await db.taxInvoice.update({
        where: { id: invoice.id },
        data: {
          status: result.status === "NOT_APPLICABLE" ? "NOT_APPLICABLE" : result.status,
          invoiceNumber: result.invoiceNumber,
          signature: result.signature,
          qrUrl: result.qrUrl,
          submittedAt: result.status === "ACCEPTED" ? new Date() : null,
          attempts: invoice.attempts + 1,
          lastError: result.error,
        },
      });

      if (result.status === "ACCEPTED") submitted += 1;
      if (result.status === "REJECTED") rejected += 1;
      if (result.error) lastError = result.error;

      // A PENDING result means KRA is unreachable, not that this one invoice
      // is bad. Stop rather than burning the whole queue's retry budget.
      if (result.status === "PENDING") break;
    }

    return NextResponse.json({
      submitted,
      rejected,
      pending: await db.taxInvoice.count({ where: { status: "PENDING" } }),
      lastError,
    });
  } catch (error) {
    if (error instanceof AuthorisationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error("[api/etims/flush] failed", error);
    return NextResponse.json({ submitted: 0, error: "Could not reach the invoice queue" });
  }
}
