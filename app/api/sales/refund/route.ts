import { NextResponse } from "next/server";
import { refundSale } from "@/lib/services/sales";
import { requirePermission, AuthorisationError } from "@/lib/session";
import { refundSchema } from "@/lib/validation";

export async function POST(request: Request) {
  try {
    const actor = await requirePermission("sale.refund");

    const parsed = refundSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid refund request" },
        { status: 400 },
      );
    }

    const result = await refundSale(parsed.data, actor);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthorisationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Could not refund the sale";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
