export type CasperPaymentRequest = {
  id: string;
  endpoint: string;
  merchant: string;
  amount: number;
  requestedAt: number;
  purpose: string;
};

export type CasperCheckAndRecordResult = {
  status: "approved" | "blocked";
  deployHash: string;
  eventName?: string;
  onchainAmount: string;
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

export async function checkAndRecordOnCasper(request: CasperPaymentRequest) {
  const response = await fetch("/api/casper/check-and-record", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      paymentRequestId: request.id,
      amount: request.amount,
      endpoint: request.endpoint,
      merchant: request.merchant,
    }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? "Failed to call Casper testnet.");
  }

  return (await response.json()) as CasperCheckAndRecordResult;
}
