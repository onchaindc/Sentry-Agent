import { NextResponse } from "next/server";
import { buildFundingTransferDeploy } from "@/lib/casper-server";
import { getUserRecord } from "@/lib/user-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      userPublicKey?: string;
      amountCspr?: string;
    };

    if (!payload.userPublicKey?.trim()) {
      return NextResponse.json({ error: "A connected wallet public key is required." }, { status: 400 });
    }

    if (!payload.amountCspr?.trim()) {
      return NextResponse.json({ error: "Funding amount is required." }, { status: 400 });
    }

    const record = await getUserRecord(payload.userPublicKey);
    if (!record) {
      return NextResponse.json({ error: "User session not found." }, { status: 404 });
    }

    const deployJson = await buildFundingTransferDeploy(
      record.userPublicKey,
      record.agent.publicKey,
      payload.amountCspr,
    );

    return NextResponse.json({
      deployJson,
      agentPublicKey: record.agent.publicKey,
      amountCspr: payload.amountCspr,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to prepare funding deploy.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
