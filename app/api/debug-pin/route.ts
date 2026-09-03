import { pinLookup } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ lookup: pinLookup("907143") });
}
