import { NextResponse } from "next/server";
import { createPaymentResponseHeader, verifyAndSettleLocalPayload, type FacilitatorSettleResponse } from "@/lib/x402-server";
import type { X402PaymentPayload, X402PaymentRequirement } from "@/lib/x402";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      paymentPayload?: X402PaymentPayload;
      paymentRequirements?: X402PaymentRequirement;
    };

    if (!payload.paymentPayload || !payload.paymentRequirements) {
      return NextResponse.json({ error: "Payment payload and requirement are required." }, { status: 400 });
    }

    const result = verifyAndSettleLocalPayload(payload.paymentPayload, payload.paymentRequirements);
    const response = NextResponse.json(result satisfies FacilitatorSettleResponse);
    response.headers.set("PAYMENT-RESPONSE", createPaymentResponseHeader(result));
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Local x402 settlement failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
