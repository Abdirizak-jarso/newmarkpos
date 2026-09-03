import { NextResponse } from "next/server";
import { checkout, CheckoutError } from "@/lib/services/checkout";
import { requirePermission, AuthorisationError } from "@/lib/session";
import { checkoutSchema } from "@/lib/validation";

/**
 * Checkout.
 *
 * Also the endpoint the offline outbox replays into, which is why the sale's
 * idempotency key is required: a retried sync must land on the same sale, not
 * a second one.
 */
export async function POST(request: Request) {
  try {
    // Authorisation first, before the body is even read.
    const cashier = await requirePermission("sale.create");

    const body = await request.json();
    const parsed = checkoutSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid sale", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await checkout(parsed.data, cashier);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof AuthorisationError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof CheckoutError) {
      return NextResponse.json({ error: error.message, field: error.field }, { status: 400 });
    }
    console.error("[api/sales] checkout failed", error);
    // A 500 tells the outbox to hold the sale and try again, rather than
    // dropping it the way it drops a 4xx.
    return NextResponse.json({ error: "Could not complete the sale" }, { status: 500 });
  }
}
