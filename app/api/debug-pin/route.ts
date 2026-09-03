import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    hasPinPepper: !!process.env.PIN_PEPPER,
    pinPepperLength: process.env.PIN_PEPPER?.length ?? 0,
    hasSessionSecret: !!process.env.SESSION_SECRET,
    sessionSecretLength: process.env.SESSION_SECRET?.length ?? 0,
  });
}
