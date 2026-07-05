import { NextResponse } from "next/server";
import { defaultPolicy, type Policy } from "@/lib/policy";
import { createDeterministicAgentWallet, getPublicKeyBalance } from "@/lib/casper-server";
import { getUserRecord, updateUserPolicy } from "@/lib/user-store";

export const runtime = "nodejs";

function isValidPolicy(policy: Policy) {
  return (
    Number.isFinite(policy.perCallCap) &&
    policy.perCallCap > 0 &&
    Number.isFinite(policy.dailySpendLimit) &&
    policy.dailySpendLimit > 0 &&
    Number.isFinite(policy.dailyCallLimit) &&
    policy.dailyCallLimit >= 1 &&
    Array.isArray(policy.allowlist)
  );
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      userPublicKey?: string;
      policy?: Policy;
    };

    if (!payload.userPublicKey?.trim()) {
      return NextResponse.json({ error: "A connected wallet public key is required." }, { status: 400 });
    }

    const nextPolicy = payload.policy ?? defaultPolicy;
    if (!isValidPolicy(nextPolicy)) {
      return NextResponse.json({ error: "Policy payload is invalid." }, { status: 400 });
    }

    const record = await updateUserPolicy(payload.userPublicKey, {
      ...nextPolicy,
      dailyCallLimit: Math.max(1, Math.round(nextPolicy.dailyCallLimit)),
    }, createDeterministicAgentWallet);
    const agentBalanceCspr = await getPublicKeyBalance(record.agent.publicKey).catch(() => 0);

    return NextResponse.json({
      userPublicKey: record.userPublicKey,
      agentPublicKey: record.agent.publicKey,
      agentAccountHash: record.agent.accountHash,
      agentBalanceCspr,
      policy: record.policy,
      activity: record.activity,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save policy.";
    const status = /not found/i.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
