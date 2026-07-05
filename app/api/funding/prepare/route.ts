import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { buildFundingTransferDeploy, createDeterministicAgentWallet } from "@/lib/casper-server";
import { getUserRecord } from "@/lib/user-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const traceId = randomUUID();

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

    console.info("[funding.prepare] start", {
      traceId,
      userPublicKey: payload.userPublicKey,
      amountCspr: payload.amountCspr,
    });

    const record = await getUserRecord(payload.userPublicKey, createDeterministicAgentWallet);
    if (!record) {
      console.warn("[funding.prepare] session-missing", {
        traceId,
        userPublicKey: payload.userPublicKey,
      });
      return NextResponse.json({ error: "User session not found." }, { status: 404 });
    }

    console.info("[funding.prepare] session-found", {
      traceId,
      userPublicKey: record.userPublicKey,
      agentPublicKey: record.agent.publicKey,
      agentAccountHash: record.agent.accountHash,
    });

    const deployJson = await buildFundingTransferDeploy(
      record.userPublicKey,
      record.agent.publicKey,
      payload.amountCspr,
    );

    console.info("[funding.prepare] deploy-built", {
      traceId,
      agentPublicKey: record.agent.publicKey,
    });

    return NextResponse.json({
      deployJson,
      agentPublicKey: record.agent.publicKey,
      agentAccountHash: record.agent.accountHash,
      amountCspr: payload.amountCspr,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to prepare funding deploy.";
    console.error("[funding.prepare] error", {
      traceId,
      message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
