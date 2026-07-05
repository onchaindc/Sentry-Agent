import { NextResponse } from "next/server";
import { getUserRecord } from "@/lib/user-store";
import { signRiskLensPayload } from "@/lib/x402-server";
import type { CasperPaymentRequest } from "@/lib/casper";
import type { X402PaymentRequiredHeader } from "@/lib/x402";

export const runtime = "nodejs";

function parseBase64Json<T>(value: string) {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      userPublicKey?: string;
      request?: CasperPaymentRequest;
    };

    if (!payload.userPublicKey?.trim()) {
      return NextResponse.json({ error: "Connected user public key is required." }, { status: 400 });
    }

    if (!payload.request) {
      return NextResponse.json({ error: "Payment request payload is required." }, { status: 400 });
    }

    const user = await getUserRecord(payload.userPublicKey);
    if (!user) {
      return NextResponse.json({ error: "User session not found." }, { status: 404 });
    }

    const baseUrl = new URL(request.url).origin;
    const resourceUrl = `${baseUrl}/api/x402/risklens?requestId=${encodeURIComponent(payload.request.id)}`;
    const trace: string[] = [];

    const challengeResponse = await fetch(resourceUrl, { cache: "no-store" });
    trace.push(`1. Agent requested RiskLens seller endpoint: GET ${resourceUrl}`);
    trace.push(`2. Seller returned HTTP ${challengeResponse.status} Payment Required challenge.`);

    const paymentRequired = challengeResponse.headers.get("Payment-Required");
    if (challengeResponse.status !== 402 || !paymentRequired) {
      const body = await challengeResponse.text();
      return NextResponse.json(
        {
          error: "Expected an x402 payment challenge from the seller endpoint.",
          status: challengeResponse.status,
          body,
        },
        { status: 500 },
      );
    }

    const header = parseBase64Json<X402PaymentRequiredHeader>(paymentRequired);
    trace.push(
      `3. Parsed Payment-Required header for ${header.accepts[0]?.amount} base units on ${header.network}.`,
    );

    const signedPayload = signRiskLensPayload(
      {
        publicKey: user.agent.publicKey,
        privateKeyPem: user.agent.privateKeyPem,
      },
      header,
    );
    trace.push(
      `4. Signed x402 authorization with per-user agent key ${user.agent.publicKey.slice(0, 10)}...${user.agent.publicKey.slice(-8)}.`,
    );

    const paidResponse = await fetch(resourceUrl, {
      method: header.resource.method,
      headers: {
        "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(signedPayload), "utf8").toString("base64"),
      },
      cache: "no-store",
    });
    trace.push(`5. Retried seller request with PAYMENT-SIGNATURE header; seller responded HTTP ${paidResponse.status}.`);

    const paymentResponseHeader = paidResponse.headers.get("PAYMENT-RESPONSE");
    const settlement = paymentResponseHeader
      ? JSON.parse(Buffer.from(paymentResponseHeader, "base64").toString("utf8")) as {
          success?: boolean;
          transaction?: string;
          network?: string;
        }
      : null;

    if (settlement?.success) {
      trace.push(
        `6. Facilitator confirmed settlement on ${settlement.network} with transaction ${settlement.transaction}.`,
      );
    } else {
      trace.push("6. Facilitator did not confirm settlement.");
    }

    const body = (await paidResponse.json().catch(async () => ({ raw: await paidResponse.text() }))) as {
      approved?: boolean;
      score?: number;
      reason?: string;
    };

    if (!paidResponse.ok) {
      return NextResponse.json(
        {
          error: body,
          trace,
        },
        { status: 500 },
      );
    }

    trace.push(`7. Seller released paid data with HTTP 200 and score ${body.score ?? "n/a"}.`);

    return NextResponse.json({
      approved: Boolean(body.approved),
      score: typeof body.score === "number" ? body.score : 0,
      meteredCost: 0.03,
      reason:
        typeof body.reason === "string"
          ? `x402 seller returned compliance score ${body.score}: ${body.reason}`
          : "x402 seller returned compliance data.",
      trace,
      sellerStatus: paidResponse.status,
      settlementTransaction: settlement?.transaction ?? "",
      facilitatorNetwork: settlement?.network ?? header.network,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "x402 payment flow failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
