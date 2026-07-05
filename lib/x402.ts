import type { CasperPaymentRequest } from "./casper";

export type ComplianceResult = {
  approved: boolean;
  score: number;
  reason: string;
  meteredCost: number;
  trace?: string[];
  sellerStatus?: number;
  settlementTransaction?: string;
  facilitatorNetwork?: string;
};

export type X402PaymentRequirement = {
  scheme: "exact";
  network: string;
  payTo: string;
  amount: string;
  asset: string;
  extra: {
    name: string;
    version: string;
    decimals: string;
    symbol: string;
  };
  maxTimeoutSeconds: number;
};

export type X402PaymentRequiredHeader = {
  x402Version: number;
  scheme: "exact";
  network: string;
  resource: {
    url: string;
    method: string;
    description: string;
  };
  accepts: X402PaymentRequirement[];
};

export type X402PaymentPayload = {
  x402Version: number;
  scheme: "exact";
  network: string;
  resource: {
    url: string;
    method: string;
  };
  accepted: X402PaymentRequirement;
  payload: {
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
    publicKey: string;
    signature: string;
  };
};

type RealX402ComplianceResponse = ComplianceResult;

const watchWords = ["temp", "relay", "unknown", "session"];

export async function runMockX402ComplianceCheck(
  request: CasperPaymentRequest,
): Promise<ComplianceResult> {
  await new Promise((resolve) => setTimeout(resolve, 900 + (request.id.length % 5) * 180));

  const endpoint = request.endpoint.toLowerCase();
  const hasWatchWord = watchWords.some((word) => endpoint.includes(word));
  const amountRisk = request.amount > 2.5 ? 22 : request.amount > 1.5 ? 12 : 4;
  const endpointRisk = hasWatchWord ? 46 : 9;
  const score = Math.min(99, endpointRisk + amountRisk + (request.merchant.length % 13));
  const approved = score < 58;

  return {
    approved,
    score,
    meteredCost: 0.03,
    reason: approved
      ? `Live x402 check cleared endpoint at risk score ${score}.`
      : `Live x402 check blocked endpoint at risk score ${score}.`,
  };
}

export async function runRealX402ComplianceCheck(
  userPublicKey: string,
  request: CasperPaymentRequest,
): Promise<RealX402ComplianceResponse> {
  const response = await fetch("/api/x402/check", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      userPublicKey,
      request,
    }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? "x402 flow failed.");
  }

  return (await response.json()) as RealX402ComplianceResponse;
}
