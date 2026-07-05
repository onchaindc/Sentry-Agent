import { NextResponse } from "next/server";
import { createAgentWallet, getPublicKeyBalance } from "@/lib/casper-server";
import { ensureUserRecord } from "@/lib/user-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      userPublicKey?: string;
    };

    if (!payload.userPublicKey?.trim()) {
      return NextResponse.json({ error: "A connected wallet public key is required." }, { status: 400 });
    }

    const record = await ensureUserRecord(payload.userPublicKey, createAgentWallet);
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
    const message = error instanceof Error ? error.message : "Failed to initialize user session.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
