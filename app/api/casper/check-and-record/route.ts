import { NextResponse } from "next/server";
import { runRealCasperCheckAndRecord } from "@/lib/casper-server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      amount?: number;
    };

    if (typeof payload.amount !== "number" || Number.isNaN(payload.amount) || payload.amount <= 0) {
      return NextResponse.json({ error: "A positive amount is required." }, { status: 400 });
    }

    const result = await runRealCasperCheckAndRecord(payload.amount);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Casper execution error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
