import { NextResponse } from "next/server";
import {
  buildRiskLensData,
  buildRiskLensPaymentChallenge,
  createPaymentResponseHeader,
  hasRealFacilitatorAccess,
  parsePaymentSignatureHeader,
  settleWithRealFacilitator,
} from "@/lib/x402-server";
import type { X402PaymentPayload } from "@/lib/x402";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requestId = url.searchParams.get("requestId");
  const paymentSignature = request.headers.get("PAYMENT-SIGNATURE");

  if (!paymentSignature) {
    const challenge = buildRiskLensPaymentChallenge(url.origin, {
      id: requestId ?? "risklens_live",
      amount: 0.03,
      endpoint: "https://risklens.ai/compliance/score",
      merchant: "RiskLens",
      purpose: "Live compliance risk score",
      requestedAt: Date.now(),
    });

    const response = NextResponse.json(
      {
        error: "Payment required before compliance data can be released.",
        challenge,
      },
      { status: 402 },
    );
    response.headers.set("Payment-Required", Buffer.from(JSON.stringify(challenge), "utf8").toString("base64"));
    return response;
  }

  try {
    const paymentPayload = parsePaymentSignatureHeader(paymentSignature) as X402PaymentPayload;
    const requirement = paymentPayload.accepted;
    const settlementBody = hasRealFacilitatorAccess()
      ? await settleWithRealFacilitator(paymentPayload, requirement)
      : await (async () => {
          const settleResponse = await fetch(new URL("/api/x402/facilitator/settle", url.origin), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              paymentPayload,
              paymentRequirements: requirement,
            }),
            cache: "no-store",
          });

          return (await settleResponse.json()) as {
            success?: boolean;
            transaction?: string;
            network?: string;
            payer?: string;
            errorReason?: string;
            errorMessage?: string;
          };
        })();

    if (!settlementBody.success) {
      const response = NextResponse.json(
        {
          error: settlementBody.errorMessage ?? "Settlement failed.",
          settlement: settlementBody,
        },
        { status: 402 },
      );
      response.headers.set("PAYMENT-RESPONSE", createPaymentResponseHeader({
        success: false,
        transaction: settlementBody.transaction ?? "",
        network: settlementBody.network ?? requirement.network,
        payer: settlementBody.payer ?? paymentPayload.payload.authorization.from,
        errorReason: settlementBody.errorReason,
        errorMessage: settlementBody.errorMessage,
      }));
      return response;
    }

    const data = buildRiskLensData(requestId);
    const response = NextResponse.json(data);
    response.headers.set("PAYMENT-RESPONSE", createPaymentResponseHeader({
      success: true,
      transaction: settlementBody.transaction ?? "",
      network: settlementBody.network ?? requirement.network,
      payer: settlementBody.payer ?? paymentPayload.payload.authorization.from,
    }));
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to parse x402 payment payload.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
