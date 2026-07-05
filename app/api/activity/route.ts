import { NextResponse } from "next/server";
import type { ActivityItem } from "@/lib/casper";
import { getPublicKeyBalance } from "@/lib/casper-server";
import { updateUserActivity } from "@/lib/user-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      userPublicKey?: string;
      activity?: ActivityItem[];
    };

    if (!payload.userPublicKey?.trim()) {
      return NextResponse.json({ error: "A connected wallet public key is required." }, { status: 400 });
    }

    if (!Array.isArray(payload.activity)) {
      return NextResponse.json({ error: "Activity payload must be an array." }, { status: 400 });
    }

    const record = await updateUserActivity(payload.userPublicKey, payload.activity);
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
    const message = error instanceof Error ? error.message : "Failed to save activity.";
    const status = /not found/i.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
