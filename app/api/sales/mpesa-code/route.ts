import { NextResponse } from "next/server";
import { listUnconfirmedMpesa, recordMpesaCode } from "@/lib/services/sales";
import { recordMpesaCodeSchema } from "@/lib/validation";
import { requirePermission, AuthorisationError } from "@/lib/session";

/**
 * The M-Pesa codes still owed, and recording one.
 *
 * Both halves sit behind the same permission, checked here on the server. The
 * till hides the queue from anyone who cannot clear it, but that is tidiness —
 * this is the gate.
 */

export async function GET() {
  try {
    await requirePermission("sale.mpesa.reconcile");
    return NextResponse.json({ waiting: await listUnconfirmedMpesa() });
  } catch (error) {
    if (error instanceof AuthorisationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    return NextResponse.json({ error: "Could not read the list" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requirePermission("sale.mpesa.reconcile");

    const parsed = recordMpesaCodeSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Check the code and the time" },
        { status: 400 },
      );
    }

    return NextResponse.json(await recordMpesaCode(parsed.data, actor));
  } catch (error) {
    if (error instanceof AuthorisationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    // These are the cashier-facing messages from the service — a duplicate
    // code, a sale already reconciled — so they are worth passing through.
    const message = error instanceof Error ? error.message : "Could not record the code";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
