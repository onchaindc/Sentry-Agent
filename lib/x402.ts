import type { CasperPaymentRequest } from "./casper";

export type ComplianceResult = {
  approved: boolean;
  score: number;
  reason: string;
  meteredCost: number;
};

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
