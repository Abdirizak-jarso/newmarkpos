import { NextResponse } from "next/server";
import { z } from "zod";
import { reprintReceipt } from "@/lib/services/sales";
import { requirePermission, AuthorisationError } from "@/lib/session";
import { recordSafely } from "@/lib/audit";

const schema = z.object({ saleId: z.string().min(1) });

export async function POST(request: Request) {
  try {
    const actor = await requirePermission("sale.reprint");

    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Which sale?" }, { status: 400 });
    }

    const printJobId = await reprintReceipt(parsed.data.saleId, actor);

    // Duplicate receipts are a known way to walk goods out of a shop, so every
    // reprint is recorded against the person who asked for it.
    await recordSafely({
      action: "RECEIPT_REPRINT",
      entity: "Sale",
      entityId: parsed.data.saleId,
      after: { reprint: true, printJobId },
      actorId: actor.id,
      reason: "Duplicate receipt printed",
    });

    return NextResponse.json({ printJobId });
  } catch (error) {
    if (error instanceof AuthorisationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Could not reprint";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
