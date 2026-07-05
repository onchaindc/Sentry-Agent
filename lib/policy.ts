import type { CasperPaymentRequest } from "./casper";

export type Policy = {
  perCallCap: number;
  dailySpendLimit: number;
  dailyCallLimit: number;
  allowlist: string[];
};

export const defaultPolicy: Policy = {
  perCallCap: 2,
  dailySpendLimit: 9.5,
  dailyCallLimit: 18,
  allowlist: [
    "https://api.cspr.cloud/v1",
    "https://oracledock.dev",
    "https://marketpulse.exchange/quotes",
  ],
};

export type SpendSnapshot = {
  approvedSpend: number;
  attemptedCalls: number;
  blockedCalls: number;
};

export type PolicyDecision =
  | {
      status: "approved";
      reason: string;
    }
  | {
      status: "blocked";
      reason: string;
    }
  | {
      status: "checking";
      reason: string;
    };

export function normalizeEndpoint(value: string) {
  return value.trim().replace(/\/$/, "").toLowerCase();
}

export function isEndpointAllowed(endpoint: string, allowlist: string[]) {
  const normalized = normalizeEndpoint(endpoint);

  return allowlist.some((entry) => {
    const allowed = normalizeEndpoint(entry);
    return normalized === allowed || normalized.startsWith(`${allowed}/`);
  });
}

export function evaluatePaymentRequest(
  request: CasperPaymentRequest,
  policy: Policy,
  snapshot: SpendSnapshot,
): PolicyDecision {
  if (request.amount > policy.perCallCap) {
    return {
      status: "blocked",
      reason: `$${request.amount.toFixed(2)} exceeds per-call cap of $${policy.perCallCap.toFixed(2)}.`,
    };
  }

  if (snapshot.approvedSpend + request.amount > policy.dailySpendLimit) {
    return {
      status: "blocked",
      reason: `Would push today's spend above $${policy.dailySpendLimit.toFixed(2)}.`,
    };
  }

  if (snapshot.attemptedCalls + 1 > policy.dailyCallLimit) {
    return {
      status: "blocked",
      reason: `Would exceed daily velocity limit of ${policy.dailyCallLimit} calls.`,
    };
  }

  if (isEndpointAllowed(request.endpoint, policy.allowlist)) {
    return {
      status: "approved",
      reason: "Endpoint is on the allowlist and spend limits are clear.",
    };
  }

  return {
    status: "checking",
    reason: "Endpoint is unknown; running metered x402 compliance check.",
  };
}
