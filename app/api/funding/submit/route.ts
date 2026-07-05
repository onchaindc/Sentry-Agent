import { NextResponse } from "next/server";
import { getPublicKeyBalance, submitSignedTransferDeploy } from "@/lib/casper-server";
import { getUserRecord } from "@/lib/user-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      userPublicKey?: string;
      signedDeployJson?: string;
    };

    if (!payload.userPublicKey?.trim()) {
      return NextResponse.json({ error: "A connected wallet public key is required." }, { status: 400 });
    }

    if (!payload.signedDeployJson?.trim()) {
      return NextResponse.json({ error: "Signed deploy payload is required." }, { status: 400 });
    }

    const record = await getUserRecord(payload.userPublicKey);
    if (!record) {
      return NextResponse.json({ error: "User session not found." }, { status: 404 });
    }

    const result = await submitSignedTransferDeploy(payload.signedDeployJson);
    const agentBalanceCspr = await getPublicKeyBalance(record.agent.publicKey);

    return NextResponse.json({
      deployHash: result.deployHash,
      agentBalanceCspr,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to submit signed funding deploy.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
