import { NextResponse } from "next/server";
import {
  CONTRACT_PAYMENT_CSPR,
  createDeterministicAgentWallet,
  getPublicKeyBalance,
  runRealCasperCheckAndRecordForAgent,
} from "@/lib/casper-server";
import { readAgentBalancesViaCsprTradeMcp } from "@/lib/cspr-trade-mcp";
import { getUserRecord } from "@/lib/user-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      userPublicKey?: string;
      amount?: number;
    };

    if (!payload.userPublicKey?.trim()) {
      return NextResponse.json({ error: "A connected wallet public key is required." }, { status: 400 });
    }

    if (typeof payload.amount !== "number" || Number.isNaN(payload.amount) || payload.amount <= 0) {
      return NextResponse.json({ error: "A positive amount is required." }, { status: 400 });
    }

    const record = await getUserRecord(payload.userPublicKey, createDeterministicAgentWallet);
    if (!record) {
      return NextResponse.json({ error: "User session not found." }, { status: 404 });
    }

    const mcpBalance = await readAgentBalancesViaCsprTradeMcp(
      record.agent.publicKey,
      record.agent.accountHash,
      record.agent.privateKeyPem,
    );
    const fallbackBalance = await getPublicKeyBalance(record.agent.publicKey).catch(() => undefined);
    const effectiveBalance =
      typeof mcpBalance.nativeCspr === "number" ? mcpBalance.nativeCspr : fallbackBalance;
    const requiredOperationalBalance = CONTRACT_PAYMENT_CSPR;

    if (typeof effectiveBalance === "number" && effectiveBalance < requiredOperationalBalance) {
      return NextResponse.json({
        status: "blocked",
        deployHash: "",
        onchainAmount: "0",
        reason: mcpBalance.connected
          ? `CSPR.trade MCP balance check blocked the spend. Agent balance is ${effectiveBalance.toFixed(2)} CSPR, below the ${requiredOperationalBalance.toFixed(2)} CSPR operating threshold.`
          : `MCP balance check was unavailable (${mcpBalance.fallbackReason}); direct RPC balance fallback saw only ${effectiveBalance.toFixed(2)} CSPR, below the ${requiredOperationalBalance.toFixed(2)} CSPR operating threshold.`,
        source: "mcp",
        agentBalanceCspr: effectiveBalance,
        mcpConnected: mcpBalance.connected,
        mcpBalanceCspr: mcpBalance.nativeCspr,
        mcpWcsprRawBalance: mcpBalance.wcsprRawBalance,
        mcpTrace: mcpBalance.trace,
      });
    }

    let result: Awaited<ReturnType<typeof runRealCasperCheckAndRecordForAgent>>;
    try {
      result = await runRealCasperCheckAndRecordForAgent(
        payload.amount,
        record.agent.privateKeyPem,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Casper execution error.";
      return NextResponse.json(
        {
          error: message,
          reason: mcpBalance.connected
            ? `CSPR.trade MCP balance check completed before the Casper call failed: ${message}`
            : `CSPR.trade MCP was unavailable (${mcpBalance.fallbackReason}); Casper call then failed: ${message}`,
          source: "casper",
          agentBalanceCspr: effectiveBalance,
          mcpConnected: mcpBalance.connected,
          mcpBalanceCspr: mcpBalance.nativeCspr,
          mcpWcsprRawBalance: mcpBalance.wcsprRawBalance,
          mcpTrace: mcpBalance.trace,
        },
        { status: 500 },
      );
    }
    const agentBalanceCspr = await getPublicKeyBalance(record.agent.publicKey).catch(() => effectiveBalance);

    return NextResponse.json({
      ...result,
      reason: mcpBalance.connected
        ? `CSPR.trade MCP confirmed ${mcpBalance.nativeCspr?.toFixed(2) ?? "unknown"} CSPR before onchain approval.`
        : `CSPR.trade MCP was unavailable (${mcpBalance.fallbackReason}); proceeded using direct RPC balance fallback.`,
      source: "casper",
      agentBalanceCspr,
      mcpConnected: mcpBalance.connected,
      mcpBalanceCspr: mcpBalance.nativeCspr,
      mcpWcsprRawBalance: mcpBalance.wcsprRawBalance,
      mcpTrace: mcpBalance.trace,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Casper execution error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
