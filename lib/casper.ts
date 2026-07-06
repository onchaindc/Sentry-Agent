import type { Policy } from "./policy";

export type CasperPaymentRequest = {
  id: string;
  endpoint: string;
  merchant: string;
  amount: number;
  requestedAt: number;
  purpose: string;
};

export type ActivityStatus = "approved" | "blocked" | "checking";
export type DecisionReasonCode =
  | "allowlisted"
  | "per_call_cap"
  | "daily_spend_limit"
  | "daily_call_limit"
  | "checking_unknown_endpoint"
  | "compliance_failed"
  | "post_check_daily_limit"
  | "compliance_cleared";

export type ActivityItem = CasperPaymentRequest & {
  status: ActivityStatus;
  reason: string;
  reasonCode: DecisionReasonCode;
  checkedAt?: number;
  complianceCost?: number;
  source?: "mock" | "casper" | "x402";
  deployHash?: string;
};

export type CasperCheckAndRecordResult = {
  status: "approved" | "blocked";
  deployHash: string;
  eventName?: string;
  onchainAmount: string;
  agentBalanceCspr?: number;
  reason?: string;
  source?: "mcp" | "casper";
  mcpConnected?: boolean;
  mcpBalanceCspr?: number | null;
  mcpWcsprRawBalance?: string | null;
  mcpTrace?: string[];
};

export type UserAgentSession = {
  userPublicKey: string;
  agentPublicKey: string;
  agentAccountHash: string;
  agentBalanceCspr: number;
  policy: Policy;
  activity: ActivityItem[];
};

export type FundingPrepareResponse = {
  deployJson: unknown;
  agentPublicKey: string;
  agentAccountHash: string;
  amountCspr: string;
};

export type FundingSubmitResponse = {
  deployHash: string;
  agentBalanceCspr: number;
};

export type FundingSubmitPayload = {
  agentPublicKey: string;
  deployHash?: string;
  signedDeployJson?: string;
};

const merchants = [
  {
    merchant: "CasperIndex",
    endpoint: "https://api.cspr.cloud/v1/account-info",
    purpose: "Refresh on-chain account context",
  },
  {
    merchant: "RiskLens",
    endpoint: "https://risklens.ai/compliance/score",
    purpose: "Screen counterparty before purchase",
  },
  {
    merchant: "VectorMint",
    endpoint: "https://vectormint.xyz/agent/render",
    purpose: "Buy generated media for client workflow",
  },
  {
    merchant: "OracleDock",
    endpoint: "https://oracledock.dev/price/cspr-usd",
    purpose: "Pull CSPR/USD pricing data",
  },
  {
    merchant: "UnknownRelay",
    endpoint: "https://relay-7.temp/paywall/session",
    purpose: "Unlock transient hosted compute",
  },
  {
    merchant: "MarketPulse",
    endpoint: "https://marketpulse.exchange/quotes/depth",
    purpose: "Read DeFi order book depth",
  },
];

export function createMockPaymentRequest(index: number): CasperPaymentRequest {
  const merchant = merchants[index % merchants.length];
  const base = [0.12, 0.42, 0.8, 1.35, 2.1, 3.4, 4.75][index % 7];
  const jitter = ((index * 37) % 19) / 100;

  return {
    id: `pay_${Date.now().toString(36)}_${index.toString(36)}`,
    endpoint: merchant.endpoint,
    merchant: merchant.merchant,
    amount: Number((base + jitter).toFixed(2)),
    requestedAt: Date.now(),
    purpose: merchant.purpose,
  };
}

export async function getMockWalletBalance() {
  return {
    address: "casper-testnet-agent-02",
    availableCspr: 1824.42,
  };
}

async function postJson<T>(url: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? "Request failed.");
  }

  return (await response.json()) as T;
}

export async function ensureUserSession(userPublicKey: string) {
  return postJson<UserAgentSession>("/api/user/session", { userPublicKey });
}

export async function persistUserPolicy(userPublicKey: string, policy: Policy) {
  return postJson<UserAgentSession>("/api/policy", { userPublicKey, policy });
}

export async function persistUserActivity(userPublicKey: string, activity: ActivityItem[]) {
  return postJson<UserAgentSession>("/api/activity", { userPublicKey, activity });
}

export async function prepareAgentFunding(userPublicKey: string, amountCspr: string) {
  return postJson<FundingPrepareResponse>("/api/funding/prepare", { userPublicKey, amountCspr });
}

export async function submitAgentFunding(
  userPublicKey: string,
  payload: FundingSubmitPayload,
) {
  return postJson<FundingSubmitResponse>("/api/funding/submit", {
    userPublicKey,
    ...payload,
  });
}

export async function checkAndRecordOnCasper(userPublicKey: string, request: CasperPaymentRequest) {
  return postJson<CasperCheckAndRecordResult>("/api/casper/check-and-record", {
    userPublicKey,
    paymentRequestId: request.id,
    amount: request.amount,
    endpoint: request.endpoint,
    merchant: request.merchant,
  });
}
