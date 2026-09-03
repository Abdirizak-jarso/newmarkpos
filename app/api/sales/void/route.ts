import { NextResponse } from "next/server";
import { voidSale } from "@/lib/services/sales";
import { requirePermission, AuthorisationError } from "@/lib/session";
import { voidSaleSchema } from "@/lib/validation";

export async function POST(request: Request) {
  try {
    // Two gates: the signed-in user must be allowed to void at all, and a
    // manager must then enter their PIN — checked inside voidSale.
    const actor = await requirePermission("sale.void");

    const parsed = voidSaleSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid void request" },
        { status: 400 },
      );
    }

    const result = await voidSale(parsed.data, actor);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthorisationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Could not void the sale";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
