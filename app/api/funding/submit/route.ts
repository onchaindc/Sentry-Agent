import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getPublicKeyBalance, submitSignedTransferDeploy } from "@/lib/casper-server";
import { getUserRecord } from "@/lib/user-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const traceId = randomUUID();

  try {
    const payload = (await request.json()) as {
      userPublicKey?: string;
      signedDeployJson?: string;
      agentPublicKey?: string;
    };

    if (!payload.userPublicKey?.trim()) {
      return NextResponse.json({ error: "A connected wallet public key is required." }, { status: 400 });
    }

    if (!payload.signedDeployJson?.trim()) {
      return NextResponse.json({ error: "Signed deploy payload is required." }, { status: 400 });
    }

    console.info("[funding.submit] start", {
      traceId,
      userPublicKey: payload.userPublicKey,
      hasAgentPublicKeyFromClient: Boolean(payload.agentPublicKey?.trim()),
      signedDeployLength: payload.signedDeployJson.length,
    });

    const record = await getUserRecord(payload.userPublicKey);
    const fallbackAgentPublicKey = payload.agentPublicKey?.trim();

    console.info("[funding.submit] session-lookup", {
      traceId,
      userPublicKey: payload.userPublicKey,
      sessionFound: Boolean(record),
      sessionAgentPublicKey: record?.agent.publicKey ?? null,
      fallbackAgentPublicKey: fallbackAgentPublicKey ?? null,
    });

    const effectiveAgentPublicKey = record?.agent.publicKey ?? fallbackAgentPublicKey;
    if (!effectiveAgentPublicKey) {
      console.warn("[funding.submit] session-missing-no-fallback", {
        traceId,
        userPublicKey: payload.userPublicKey,
      });
      return NextResponse.json({ error: "User session not found." }, { status: 404 });
    }

    console.info("[funding.submit] submitting-signed-deploy", {
      traceId,
      usingFallbackAgentKey: !record,
      agentPublicKey: effectiveAgentPublicKey,
    });

    const result = await submitSignedTransferDeploy(payload.signedDeployJson);
    console.info("[funding.submit] deploy-submitted", {
      traceId,
      deployHash: result.deployHash,
    });
    const agentBalanceCspr = await getPublicKeyBalance(effectiveAgentPublicKey);
    console.info("[funding.submit] balance-refreshed", {
      traceId,
      agentPublicKey: effectiveAgentPublicKey,
      agentBalanceCspr,
    });

    return NextResponse.json({
      deployHash: result.deployHash,
      agentBalanceCspr,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to submit signed funding deploy.";
    console.error("[funding.submit] error", {
      traceId,
      message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
