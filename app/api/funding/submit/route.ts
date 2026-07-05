import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createDeterministicAgentWallet, getPublicKeyBalance, submitSignedTransferDeploy } from "@/lib/casper-server";
import { getUserRecord } from "@/lib/user-store";

export const runtime = "nodejs";

const require = createRequire(import.meta.url);
const { Deploy, PublicKey } = require("casper-js-sdk") as typeof import("casper-js-sdk");

type WalletSignaturePayload = {
  signature?: string;
  publicKey?: string;
  deploy?: unknown;
  approval?: {
    signer?: string;
    signature?: string;
  };
};

function tryParseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function hexToBytes(value: string) {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

function hydrateSignedDeploy(originalDeployJson: string, signedPayloadJson: string) {
  const originalParsed = tryParseJson(originalDeployJson);
  if (!originalParsed) {
    throw new Error("Original deploy payload could not be parsed.");
  }

  const signedParsed = tryParseJson(signedPayloadJson);

  // Some wallets return the whole signed deploy JSON back. Use it directly.
  if (signedParsed && typeof signedParsed === "object" && "hash" in signedParsed && "header" in signedParsed) {
    return signedPayloadJson;
  }

  if (!signedParsed || typeof signedParsed !== "object") {
    throw new Error("Signed deploy payload was not valid JSON.");
  }

  const walletPayload = signedParsed as WalletSignaturePayload;
  const approvalSigner =
    walletPayload.approval?.signer ??
    walletPayload.publicKey;
  const approvalSignature =
    walletPayload.approval?.signature ??
    walletPayload.signature;

  if (!approvalSigner || !approvalSignature) {
    throw new Error("Wallet signature response did not include an approval signer and signature.");
  }

  const deploy = Deploy.fromJSON(originalParsed);
  Deploy.setSignature(deploy, hexToBytes(approvalSignature), PublicKey.fromHex(approvalSigner));
  return JSON.stringify(Deploy.toJSON(deploy));
}

export async function POST(request: Request) {
  const traceId = randomUUID();

  try {
    const payload = (await request.json()) as {
      userPublicKey?: string;
      signedDeployJson?: string;
      originalDeployJson?: string;
      agentPublicKey?: string;
    };

    if (!payload.userPublicKey?.trim()) {
      return NextResponse.json({ error: "A connected wallet public key is required." }, { status: 400 });
    }

    if (!payload.signedDeployJson?.trim()) {
      return NextResponse.json({ error: "Signed deploy payload is required." }, { status: 400 });
    }

    if (!payload.originalDeployJson?.trim()) {
      return NextResponse.json({ error: "Original deploy payload is required." }, { status: 400 });
    }

    console.info("[funding.submit] start", {
      traceId,
      userPublicKey: payload.userPublicKey,
      hasAgentPublicKeyFromClient: Boolean(payload.agentPublicKey?.trim()),
      signedDeployLength: payload.signedDeployJson.length,
    });

    const record = await getUserRecord(payload.userPublicKey, createDeterministicAgentWallet);
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

    const hydratedSignedDeployJson = hydrateSignedDeploy(payload.originalDeployJson, payload.signedDeployJson);
    console.info("[funding.submit] deploy-hydrated", {
      traceId,
      signedPayloadKind: payload.signedDeployJson.trim().startsWith("{") ? "json" : "raw",
    });

    const result = await submitSignedTransferDeploy(hydratedSignedDeployJson);
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
