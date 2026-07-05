import { randomBytes, createHash } from "node:crypto";
import https from "node:https";
import { createRequire } from "node:module";
import { buildDomain, CASPER_DOMAIN_TYPES, hashTypedData } from "@casper-ecosystem/casper-eip-712";
import type * as CasperSdk from "casper-js-sdk";
import type { CasperPaymentRequest } from "./casper";
import type { X402PaymentPayload, X402PaymentRequiredHeader, X402PaymentRequirement } from "./x402";

const require = createRequire(import.meta.url);
const { PublicKey, PrivateKey, KeyAlgorithm } = require("casper-js-sdk") as typeof CasperSdk;

const X402_VERSION = 2;
const X402_NETWORK = "casper:casper-test";
const RISKLENS_PRICE = "30000000";
const RISKLENS_DECIMALS = "9";
const RISKLENS_SYMBOL = "WCSPR";
const RISKLENS_ASSET = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
const RISKLENS_PAY_TO = "001857b576e2247b68d5bb0dbb6cd70361b056262d0a64d7ded1cdc7326954e344";
const RISKLENS_SETTLEMENT_PREFIX = "x402-local-";
const REAL_FACILITATOR_URL =
  process.env.CSPR_CLOUD_X402_FACILITATOR_URL ?? "https://x402-facilitator.cspr.cloud";

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export type FacilitatorSettleResponse = {
  success: boolean;
  transaction: string;
  network: string;
  payer: string;
  errorReason?: string;
  errorMessage?: string;
};

type AgentIdentity = {
  publicKey: string;
  privateKeyPem: string;
};

function getFacilitatorAccessToken() {
  return (
    process.env.CSPR_CLOUD_X402_ACCESS_TOKEN ??
    process.env.CSPR_CLOUD_ACCESS_TOKEN ??
    process.env.CSPR_CLOUD_API_KEY ??
    ""
  ).trim();
}

export function hasRealFacilitatorAccess() {
  return Boolean(getFacilitatorAccessToken());
}

function facilitatorHeaders() {
  const token = getFacilitatorAccessToken();
  if (!token) {
    throw new Error(
      "Missing CSPR.cloud facilitator access token. Set CSPR_CLOUD_X402_ACCESS_TOKEN, CSPR_CLOUD_ACCESS_TOKEN, or CSPR_CLOUD_API_KEY.",
    );
  }

  return {
    "Content-Type": "application/json",
    authorization: token,
  };
}

function base64Json(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

async function facilitatorRequest(path: string, init?: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string }) {
  const url = new URL(path, REAL_FACILITATOR_URL);

  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? "GET",
        headers: init?.headers,
        family: 4,
        timeout: 15000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.on("timeout", () => {
      request.destroy(new Error(`Connect Timeout Error (attempted address: ${url.hostname}:${url.port || 443}, timeout: 15000ms)`));
    });
    request.on("error", reject);

    if (init?.body) {
      request.write(init.body);
    }

    request.end();
  });
}

function parseBase64Json<T>(value: string) {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
}

function accountHashAddressFromPublicKey(publicKeyHex: string) {
  return `00${PublicKey.fromHex(publicKeyHex).accountHash().toHex()}`;
}

function paymentDigest(payload: X402PaymentPayload) {
  const { accepted } = payload;
  const name = accepted.extra?.name;
  const version = accepted.extra?.version;

  if (typeof name !== "string" || !name) {
    throw new Error("Missing x402 token name for Casper EIP-712 domain.");
  }

  if (typeof version !== "string" || !version) {
    throw new Error("Missing x402 token version for Casper EIP-712 domain.");
  }

  const authorization = payload.payload.authorization;
  const domain = buildDomain(name, version, payload.network, `0x${accepted.asset}`);

  return hashTypedData(
    domain,
    TRANSFER_WITH_AUTHORIZATION_TYPES,
    "TransferWithAuthorization",
    {
      from: `0x${authorization.from}`,
      to: `0x${authorization.to}`,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: `0x${authorization.nonce}`,
    },
    {
      domainTypes: CASPER_DOMAIN_TYPES,
    },
  );
}

export function buildRiskLensPaymentChallenge(origin: string, request: CasperPaymentRequest): X402PaymentRequiredHeader {
  const accepted: X402PaymentRequirement = {
    scheme: "exact",
    network: X402_NETWORK,
    payTo: RISKLENS_PAY_TO,
    amount: RISKLENS_PRICE,
    asset: RISKLENS_ASSET,
    extra: {
      name: "Wrapped CSPR",
      version: "1",
      decimals: RISKLENS_DECIMALS,
      symbol: RISKLENS_SYMBOL,
    },
    maxTimeoutSeconds: 900,
  };

  return {
    x402Version: X402_VERSION,
    scheme: "exact",
    network: X402_NETWORK,
    resource: {
      url: `${origin}/api/x402/risklens?requestId=${encodeURIComponent(request.id)}`,
      method: "GET",
      description: `RiskLens live compliance score for ${request.merchant}`,
    },
    accepts: [accepted],
  };
}

export function encodePaymentRequiredHeader(origin: string, request: CasperPaymentRequest) {
  return base64Json(buildRiskLensPaymentChallenge(origin, request));
}

export function signRiskLensPayload(agent: AgentIdentity, header: X402PaymentRequiredHeader) {
  const accepted = header.accepts[0];
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: accountHashAddressFromPublicKey(agent.publicKey),
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: String(now - 30),
    validBefore: String(now + Math.min(accepted.maxTimeoutSeconds, 300)),
    nonce: randomBytes(32).toString("hex"),
  };

  const payload: X402PaymentPayload = {
    x402Version: header.x402Version,
    scheme: header.scheme,
    network: header.network,
    resource: {
      url: header.resource.url,
      method: header.resource.method,
    },
    accepted,
    payload: {
      authorization,
      publicKey: agent.publicKey,
      signature: "",
    },
  };

  const digest = paymentDigest(payload);
  const signer = PrivateKey.fromPem(agent.privateKeyPem, KeyAlgorithm.SECP256K1);
  payload.payload.signature = Buffer.from(signer.signAndAddAlgorithmBytes(digest)).toString("hex");

  return payload;
}

export function parsePaymentSignatureHeader(value: string) {
  return parseBase64Json<X402PaymentPayload>(value);
}

export function createPaymentResponseHeader(value: FacilitatorSettleResponse) {
  return base64Json(value);
}

export function verifyAndSettleLocalPayload(payload: X402PaymentPayload, requirement: X402PaymentRequirement): FacilitatorSettleResponse {
  const digest = paymentDigest(payload);
  const signatureBytes = Buffer.from(payload.payload.signature, "hex");
  const authorization = payload.payload.authorization;

  if (payload.scheme !== "exact") {
    return {
      success: false,
      transaction: "",
      network: requirement.network,
      payer: authorization.from,
      errorReason: "unsupported_scheme",
      errorMessage: "Only the exact x402 scheme is supported.",
    };
  }

  if (payload.network !== requirement.network) {
    return {
      success: false,
      transaction: "",
      network: requirement.network,
      payer: authorization.from,
      errorReason: "network_mismatch",
      errorMessage: "Payment payload network did not match the requirement.",
    };
  }

  if (authorization.to !== requirement.payTo || authorization.value !== requirement.amount) {
    return {
      success: false,
      transaction: "",
      network: requirement.network,
      payer: authorization.from,
      errorReason: "amount_mismatch",
      errorMessage: "Payment authorization did not match the challenged payee or amount.",
    };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Number(authorization.validBefore) < now) {
    return {
      success: false,
      transaction: "",
      network: requirement.network,
      payer: authorization.from,
      errorReason: "payload_expired",
      errorMessage: "The x402 authorization expired before settlement.",
    };
  }

  const isValid = PublicKey.fromHex(payload.payload.publicKey).verifySignature(digest, signatureBytes);

  if (!isValid) {
    return {
      success: false,
      transaction: "",
      network: requirement.network,
      payer: authorization.from,
      errorReason: "invalid_signature",
      errorMessage: "Signature verification failed for the supplied payment authorization.",
    };
  }

  return {
    success: true,
    transaction: `${RISKLENS_SETTLEMENT_PREFIX}${createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex")
      .slice(0, 40)}`,
    network: requirement.network,
    payer: authorization.from,
  };
}

export function buildRiskLensData(requestId: string | null) {
  const scoreSeed = requestId ? requestId.length * 7 : 31;
  const score = 18 + (scoreSeed % 41);

  return {
    vendor: "RiskLens",
    requestId,
    approved: score < 58,
    score,
    reason: score < 58 ? "Counterparty cleared compliance checks." : "Counterparty flagged for elevated risk.",
    checkedAt: new Date().toISOString(),
  };
}

export async function settleWithRealFacilitator(
  payload: X402PaymentPayload,
  requirement: X402PaymentRequirement,
) {
  let supportedResponse: { status: number; body: string };
  try {
    supportedResponse = await facilitatorRequest("/supported", {
      headers: {
        authorization: getFacilitatorAccessToken(),
      },
    });
  } catch (error) {
    const detail =
      error instanceof Error
        ? `${error.message}${"cause" in error && error.cause ? ` (${String(error.cause)})` : ""}`
        : String(error);
    throw new Error(`Real facilitator /supported transport failed: ${detail}`);
  }

  if (supportedResponse.status < 200 || supportedResponse.status >= 300) {
    throw new Error(`Real facilitator /supported failed with HTTP ${supportedResponse.status}.`);
  }

  let settleResponse: { status: number; body: string };
  try {
    settleResponse = await facilitatorRequest("/settle", {
      method: "POST",
      headers: facilitatorHeaders(),
      body: JSON.stringify({
        paymentPayload: payload,
        paymentRequirements: requirement,
      }),
    });
  } catch (error) {
    const detail =
      error instanceof Error
        ? `${error.message}${"cause" in error && error.cause ? ` (${String(error.cause)})` : ""}`
        : String(error);
    throw new Error(`Real facilitator /settle transport failed: ${detail}`);
  }

  const settleBody = (JSON.parse(settleResponse.body || "null")) as FacilitatorSettleResponse | { error?: string } | null;
  if (settleResponse.status < 200 || settleResponse.status >= 300) {
    const message =
      settleBody && "error" in settleBody && settleBody.error
        ? settleBody.error
        : `Real facilitator /settle failed with HTTP ${settleResponse.status}.`;
    throw new Error(message);
  }

  return settleBody as FacilitatorSettleResponse;
}
