import { randomBytes, createHash, sign as cryptoSign, verify as cryptoVerify, createPrivateKey, createPublicKey } from "node:crypto";
import { createRequire } from "node:module";
import type * as CasperSdk from "casper-js-sdk";
import type { CasperPaymentRequest } from "./casper";
import type { X402PaymentPayload, X402PaymentRequiredHeader, X402PaymentRequirement } from "./x402";

const require = createRequire(import.meta.url);
const { PublicKey } = require("casper-js-sdk") as typeof CasperSdk;

const X402_VERSION = 2;
const X402_NETWORK = "casper:casper-test";
const RISKLENS_PRICE = "30000000";
const RISKLENS_DECIMALS = "9";
const RISKLENS_SYMBOL = "RISK";
const RISKLENS_ASSET = "7".repeat(64);
const RISKLENS_PAY_TO = `00${"8".repeat(64)}`;
const RISKLENS_SETTLEMENT_PREFIX = "x402-local-";

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

function base64Json(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function parseBase64Json<T>(value: string) {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
}

function accountHashAddressFromPublicKey(publicKeyHex: string) {
  return `00${PublicKey.fromHex(publicKeyHex).accountHash().toHex()}`;
}

function canonicalPaymentMessage(payload: X402PaymentPayload) {
  const authorization = payload.payload.authorization;

  return JSON.stringify({
    version: payload.x402Version,
    scheme: payload.scheme,
    network: payload.network,
    asset: payload.accepted.asset,
    amount: payload.accepted.amount,
    from: authorization.from,
    to: authorization.to,
    value: authorization.value,
    validAfter: authorization.validAfter,
    validBefore: authorization.validBefore,
    nonce: authorization.nonce,
    resourceUrl: payload.resource.url,
    resourceMethod: payload.resource.method,
  });
}

function paymentDigest(payload: X402PaymentPayload) {
  return createHash("sha256").update(canonicalPaymentMessage(payload)).digest();
}

export function buildRiskLensPaymentChallenge(origin: string, request: CasperPaymentRequest): X402PaymentRequiredHeader {
  const accepted: X402PaymentRequirement = {
    scheme: "exact",
    network: X402_NETWORK,
    payTo: RISKLENS_PAY_TO,
    amount: RISKLENS_PRICE,
    asset: RISKLENS_ASSET,
    extra: {
      name: "RiskLens Access Credit",
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
  payload.payload.signature = cryptoSign(null, digest, {
    key: createPrivateKey(agent.privateKeyPem),
    dsaEncoding: "ieee-p1363",
  }).toString("hex");

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

  const verifyKey = createPublicKey(PublicKey.fromHex(payload.payload.publicKey).toPem());
  const isValid = cryptoVerify(null, digest, { key: verifyKey, dsaEncoding: "ieee-p1363" }, signatureBytes);

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
