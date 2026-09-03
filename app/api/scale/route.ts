import { NextResponse } from "next/server";
import { createScaleAdapter } from "@/lib/adapters/scale";
import { requirePermission, AuthorisationError } from "@/lib/session";

/**
 * Read the scale.
 *
 * Never returns an error for "no scale" — a missing scale is a normal state
 * that the till handles by asking the cashier to type the weight. Only a
 * genuine fault is a 500.
 */
export async function GET() {
  try {
    await requirePermission("sale.create");

    const scale = createScaleAdapter();
    const status = await scale.status();
    const reading = await scale.read();

    return NextResponse.json({
      connected: status.connected,
      adapter: status.adapter,
      detail: status.detail,
      grams: reading?.grams,
      stable: reading?.stable ?? false,
    });
  } catch (error) {
    if (error instanceof AuthorisationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error("[api/scale] read failed", error);
    return NextResponse.json(
      { connected: false, adapter: "unknown", detail: "Scale could not be read — type the weight" },
      { status: 200 },
    );
  }
}
