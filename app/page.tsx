"use client";

import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  checkAndRecordOnCasper,
  createMockPaymentRequest,
  ensureUserSession,
  persistUserActivity,
  persistUserPolicy,
  prepareAgentFunding,
  submitAgentFunding,
  type ActivityItem,
  type ActivityStatus,
  type CasperPaymentRequest,
  type DecisionReasonCode,
  type UserAgentSession,
} from "@/lib/casper";
import { defaultPolicy, evaluatePaymentRequest, type Policy, type SpendSnapshot } from "@/lib/policy";
import { runMockX402ComplianceCheck, runRealX402ComplianceCheck } from "@/lib/x402";

type ThemeMode = "dark" | "light";
type ActivityFilter = "all" | "approved" | "blocked";
type ChartRange = "1H" | "24H" | "7D";
type PolicyField = "perCallCap" | "dailySpendLimit" | "dailyCallLimit";
type ViewMode = "landing" | "app";
type DashboardTab = "Overview" | "Policy" | "Activity";
type ThemeVars = CSSProperties & Record<`--${string}`, string>;

declare global {
  interface Window {
    CasperWalletProvider?:
      | ((options?: { timeout?: number }) => {
          requestConnection: () => Promise<boolean>;
          isConnected?: () => Promise<boolean>;
          getActivePublicKey: () => Promise<string>;
          disconnectFromSite?: () => Promise<void>;
          send?: (...args: unknown[]) => Promise<string | Record<string, unknown>>;
          sign: (
            deployJson: string,
            signingPublicKeyHex: string,
            targetPublicKeyHex?: string,
          ) => Promise<string | Record<string, unknown>>;
        })
      | {
          requestConnection: () => Promise<boolean>;
          isConnected?: () => Promise<boolean>;
          getActivePublicKey: () => Promise<string>;
          disconnectFromSite?: () => Promise<void>;
          send?: (...args: unknown[]) => Promise<string | Record<string, unknown>>;
          sign: (
            deployJson: string,
            signingPublicKeyHex: string,
            targetPublicKeyHex?: string,
          ) => Promise<string | Record<string, unknown>>;
        };
  }
}

type WalletProvider = {
  requestConnection: () => Promise<boolean>;
  isConnected?: () => Promise<boolean>;
  getActivePublicKey: () => Promise<string>;
  disconnectFromSite?: () => Promise<void>;
  send?: (...args: unknown[]) => Promise<string | Record<string, unknown>>;
  sign: (
    deployJson: string,
    signingPublicKeyHex: string,
    targetPublicKeyHex?: string,
  ) => Promise<
    | string
    | {
        cancelled?: boolean;
        signatureHex?: string | null;
        signature?: unknown;
      }
    | Record<string, unknown>
  >;
};

const WALLET_PROVIDER_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_AGENT_FUND_CSPR = 2.5;

const chartRanges: ChartRange[] = ["1H", "24H", "7D"];
const activityFilters: ActivityFilter[] = ["all", "approved", "blocked"];
const dashboardTabs: DashboardTab[] = ["Overview", "Policy", "Activity"];

const themeVars: Record<ThemeMode, ThemeVars> = {
  dark: {
    "--bg": "#131315",
    "--card": "#1B1B1D",
    "--card-elevated": "#18181A",
    "--panel": "#161618",
    "--hero-grid": "rgba(255,255,255,0.05)",
    "--hero-orb": "rgba(34,197,94,0.12)",
    "--text": "#F5F5F5",
    "--text-soft": "#F2F2F3",
    "--muted": "#8E8E93",
    "--faint": "#5C5C60",
    "--accent": "#22C55E",
    "--accent-strong": "#22C55E",
    "--danger": "#EF4444",
    "--warning": "#F59E0B",
    "--border": "rgba(255,255,255,0.07)",
    "--divider": "rgba(255,255,255,0.06)",
    "--surface-soft": "rgba(255,255,255,0.02)",
    "--surface-muted": "rgba(255,255,255,0.03)",
    "--surface-accent": "rgba(34,197,94,0.14)",
    "--budget-border": "rgba(255,255,255,0.1)",
    "--button-ink": "#08170C",
    "--button-secondary": "rgba(255,255,255,0.03)",
    "--chart-fill": "rgba(34,197,94,0.1)",
    "--gridline": "rgba(255,255,255,0.06)",
    "--row-flash": "rgba(34,197,94,0.12)",
    "--input-bg": "rgba(255,255,255,0.02)",
    "--input-border": "rgba(255,255,255,0.1)",
    "--hero-line": "rgba(255,255,255,0.08)",
  },
  light: {
    "--bg": "#FAFAFA",
    "--card": "#FFFFFF",
    "--card-elevated": "#FFFFFF",
    "--panel": "#FFFFFF",
    "--hero-grid": "rgba(24,24,27,0.06)",
    "--hero-orb": "rgba(34,197,94,0.1)",
    "--text": "#18181B",
    "--text-soft": "#18181B",
    "--muted": "#71717A",
    "--faint": "#A1A1AA",
    "--accent": "#22C55E",
    "--accent-strong": "#16A34A",
    "--danger": "#EF4444",
    "--warning": "#F59E0B",
    "--border": "rgba(0,0,0,0.08)",
    "--divider": "rgba(0,0,0,0.06)",
    "--surface-soft": "rgba(0,0,0,0.02)",
    "--surface-muted": "rgba(0,0,0,0.03)",
    "--surface-accent": "rgba(34,197,94,0.1)",
    "--budget-border": "rgba(0,0,0,0.08)",
    "--button-ink": "#08170C",
    "--button-secondary": "rgba(0,0,0,0.02)",
    "--chart-fill": "rgba(34,197,94,0.14)",
    "--gridline": "rgba(24,24,27,0.1)",
    "--row-flash": "rgba(34,197,94,0.1)",
    "--input-bg": "#FFFFFF",
    "--input-border": "rgba(0,0,0,0.12)",
    "--hero-line": "rgba(24,24,27,0.08)",
  },
};

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatBalance(value: number) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: value < 1 ? 3 : 2,
    maximumFractionDigits: 3,
  }).format(value);
}

function formatPolicyValue(field: PolicyField, value: number) {
  return field === "dailyCallLimit" ? String(Math.round(value)) : formatCurrency(value);
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function formatShortEndpoint(endpoint: string) {
  return endpoint.replace("https://", "").replace("http://", "");
}

function shortPublicKey(value: string) {
  if (!value) {
    return "";
  }

  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function shortDeployHash(hash: string) {
  return `${hash.slice(0, 10)}...${hash.slice(-8)}`;
}

function hashString(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function pickReason(seed: string, options: string[]) {
  return options[hashString(seed) % options.length];
}

function classifyDecision(
  request: CasperPaymentRequest,
  policy: Policy,
  snapshot: SpendSnapshot,
): DecisionReasonCode {
  if (request.amount > policy.perCallCap) {
    return "per_call_cap";
  }

  if (snapshot.approvedSpend + request.amount > policy.dailySpendLimit) {
    return "daily_spend_limit";
  }

  if (snapshot.attemptedCalls + 1 > policy.dailyCallLimit) {
    return "daily_call_limit";
  }

  const normalizedEndpoint = request.endpoint.toLowerCase();
  const isAllowed = policy.allowlist.some((entry) => {
    const normalizedEntry = entry.trim().replace(/\/$/, "").toLowerCase();
    const normalizedValue = normalizedEndpoint.replace(/\/$/, "");
    return normalizedValue === normalizedEntry || normalizedValue.startsWith(`${normalizedEntry}/`);
  });

  return isAllowed ? "allowlisted" : "checking_unknown_endpoint";
}

function createReason(
  code: DecisionReasonCode,
  request: CasperPaymentRequest,
  policy: Policy,
  snapshot: SpendSnapshot,
  complianceScore?: number,
) {
  const amountOverCap = Math.max(request.amount - policy.perCallCap, 0);
  const spendOverLimit = Math.max(snapshot.approvedSpend + request.amount - policy.dailySpendLimit, 0);
  const callsOverLimit = Math.max(snapshot.attemptedCalls + 1 - policy.dailyCallLimit, 0);

  switch (code) {
    case "allowlisted":
      return pickReason(request.id, [
        "Allowlisted endpoint cleared all spend checks.",
        "Known merchant matched policy and passed instantly.",
      ]);
    case "per_call_cap":
      return pickReason(request.id, [
        `Exceeds per-call cap by ${formatCurrency(amountOverCap)}.`,
        `Single request is ${formatCurrency(amountOverCap)} above the approved cap.`,
      ]);
    case "daily_spend_limit":
      return pickReason(request.id, [
        `Would exceed today's spend limit by ${formatCurrency(spendOverLimit)}.`,
        `Daily spend threshold would be breached by ${formatCurrency(spendOverLimit)}.`,
      ]);
    case "daily_call_limit":
      return pickReason(request.id, [
        `Would exceed daily call limit by ${callsOverLimit} request${callsOverLimit === 1 ? "" : "s"}.`,
        `Velocity guardrail blocks request ${snapshot.attemptedCalls + 1} of ${policy.dailyCallLimit}.`,
      ]);
    case "checking_unknown_endpoint":
      return pickReason(request.id, [
        "Running live compliance check on unknown endpoint...",
        "Endpoint is not on allowlist; verifying merchant risk before spend.",
      ]);
    case "compliance_failed":
      return pickReason(`${request.id}:${complianceScore ?? 0}`, [
        "Endpoint not on allowlist and failed compliance check.",
        `Live compliance check flagged merchant risk at score ${complianceScore ?? 0}.`,
      ]);
    case "post_check_daily_limit":
      return pickReason(request.id, [
        "Compliance passed, but final approval would exceed today's spend limit.",
        "Merchant cleared compliance, but budget guardrails still block the spend.",
      ]);
    case "compliance_cleared":
      return pickReason(`${request.id}:${complianceScore ?? 0}`, [
        `Unknown endpoint cleared compliance at score ${complianceScore ?? 0}.`,
        `Live compliance check approved merchant risk at score ${complianceScore ?? 0}.`,
      ]);
    default:
      return "Policy evaluation completed.";
  }
}

function getWalletProvider() {
  if (typeof window === "undefined") {
    return null;
  }

  const injectedProvider = window.CasperWalletProvider;

  if (!injectedProvider) {
    return null;
  }

  if (typeof injectedProvider === "function") {
    return injectedProvider({ timeout: WALLET_PROVIDER_TIMEOUT_MS }) as WalletProvider;
  }

  return injectedProvider as WalletProvider;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getJsonByteSize(value: string) {
  return new TextEncoder().encode(value).length;
}

function summarizeFundingPayloadJson(payloadJson: string) {
  const parsed = parseMaybeJsonString(payloadJson);

  if (!isRecord(parsed)) {
    return {
      kind: "unparseable",
      byteSize: getJsonByteSize(payloadJson),
    };
  }

  return {
    kind: looksLikeDeployJson(parsed) ? "deploy" : looksLikeTransactionJson(parsed) ? "transaction" : "unknown",
    byteSize: getJsonByteSize(payloadJson),
    topLevelKeys: Object.keys(parsed),
    approvalCount: Array.isArray(parsed.approvals) ? parsed.approvals.length : 0,
    approvalSignatureChars:
      Array.isArray(parsed.approvals) &&
      isRecord(parsed.approvals[0]) &&
      typeof parsed.approvals[0].signature === "string"
        ? parsed.approvals[0].signature.length
        : null,
    paymentKeys: isRecord(parsed.payment) ? Object.keys(parsed.payment) : null,
    sessionKeys: isRecord(parsed.session) ? Object.keys(parsed.session) : null,
    hasModuleBytes: JSON.stringify(parsed.session ?? {}).includes("ModuleBytes"),
  };
}

function normalizeWalletSignatureBytes(signature: unknown): Uint8Array | null {
  if (!signature) {
    return null;
  }

  if (typeof signature === "string") {
    return signatureHexToBytes(signature);
  }

  if (signature instanceof Uint8Array) {
    return signature;
  }

  if (Array.isArray(signature) && signature.every((value) => typeof value === "number")) {
    return Uint8Array.from(signature);
  }

  if (isRecord(signature)) {
    const ordered = Object.entries(signature)
      .filter(([key, value]) => /^\d+$/.test(key) && typeof value === "number")
      .sort((left, right) => Number(left[0]) - Number(right[0]))
      .map(([, value]) => value);

    if (ordered.length > 0) {
      return Uint8Array.from(ordered);
    }
  }

  return null;
}

function parseMaybeJsonString(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function looksLikeDeployJson(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  return "hash" in value && "header" in value && "payment" in value && "session" in value;
}

function looksLikeTransactionJson(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  return "hash" in value && ("payload" in value || "Version1" in value || "transaction" in value);
}

function signatureHexToBytes(signatureHex: unknown): Uint8Array | null {
  if (typeof signatureHex !== "string" || !signatureHex.trim()) {
    return null;
  }

  const normalized = signatureHex.trim().replace(/^0x/, "");
  if (
    !/^[a-f0-9]+$/i.test(normalized) ||
    ![128, 130].includes(normalized.length)
  ) {
    return null;
  }

  return Uint8Array.from(
    normalized.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}

function isCasperSignatureLength(signatureBytes: Uint8Array) {
  return signatureBytes.length === 64 || signatureBytes.length === 65;
}

function ensureCasperSignaturePrefix(signatureBytes: Uint8Array, signingPublicKeyHex: string) {
  if (!isCasperSignatureLength(signatureBytes)) {
    throw new Error(
      `Wallet returned a ${signatureBytes.length}-byte signature. Casper deploy approvals require 64 raw bytes or 65 prefixed bytes.`,
    );
  }

  const keyPrefix = Number.parseInt(signingPublicKeyHex.slice(0, 2), 16);
  if (![1, 2].includes(keyPrefix)) {
    return signatureBytes;
  }

  if (signatureBytes.length === 65 && signatureBytes[0] === keyPrefix) {
    return signatureBytes;
  }

  return Uint8Array.from([keyPrefix, ...signatureBytes]);
}

function assertCompactFundingPayload(payload: string) {
  if (payload.length > 200_000) {
    throw new Error(
      `Signed funding payload is unexpectedly large (${payload.length} bytes). A native CSPR transfer should be compact.`,
    );
  }

  return payload;
}

async function buildSignedDeployJson(
  deployJson: unknown,
  signingPublicKeyHex: string,
  signResult: string | Record<string, unknown>,
) {
  const sdk = await import("casper-js-sdk");

  const buildFromSignature = (signatureBytes: Uint8Array) => {
    const deploy = sdk.Deploy.fromJSON(deployJson);
    const prefixedSignature = ensureCasperSignaturePrefix(signatureBytes, signingPublicKeyHex);

    if (prefixedSignature.length !== 65) {
      throw new Error(
        `Wallet returned a ${prefixedSignature.length}-byte signature after Casper prefix normalization.`,
      );
    }

    sdk.Deploy.setSignature(
      deploy,
      prefixedSignature,
      sdk.PublicKey.fromHex(signingPublicKeyHex),
    );

    return assertCompactFundingPayload(JSON.stringify(sdk.Deploy.toJSON(deploy)));
  };

  const canonicalizeWalletPayload = (payload: unknown) => {
    if (looksLikeDeployJson(payload)) {
      const deploy = sdk.Deploy.fromJSON(payload);
      return assertCompactFundingPayload(JSON.stringify(sdk.Deploy.toJSON(deploy)));
    }

    if (looksLikeTransactionJson(payload)) {
      const transaction = sdk.Transaction.fromJSON(payload);
      return assertCompactFundingPayload(JSON.stringify(transaction.toJSON()));
    }

    return null;
  };

  if (typeof signResult === "string") {
    const parsed = parseMaybeJsonString(signResult);
    const canonicalPayload = canonicalizeWalletPayload(parsed);

    if (canonicalPayload) {
      return canonicalPayload;
    }

    throw new Error("Wallet returned a string payload that was not a signed deploy.");
  }

  if (!isRecord(signResult)) {
    throw new Error("Wallet returned an unexpected signing payload.");
  }

  if (signResult.cancelled) {
    throw new Error("Wallet signing was cancelled.");
  }

  const signatureBytes =
    normalizeWalletSignatureBytes(signResult.signature) ?? signatureHexToBytes(signResult.signatureHex);

  if (signatureBytes) {
    return buildFromSignature(signatureBytes);
  }

  const canonicalPayload =
    canonicalizeWalletPayload(signResult.deploy) ??
    canonicalizeWalletPayload(signResult.transaction);

  if (canonicalPayload) {
    return canonicalPayload;
  }

  throw new Error("Wallet signature response did not contain usable signature bytes.");
}

function ShieldCheckIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 flex-none" fill="none" height="16" viewBox="0 0 24 24" width="16">
      <path
        d="M12 3.25 5.75 5.9v5.35c0 4.4 2.65 8.48 6.25 9.5 3.6-1.02 6.25-5.1 6.25-9.5V5.9L12 3.25Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <path
        d="m9.4 12.1 1.8 1.85 3.45-3.75"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 flex-none" fill="none" height="16" viewBox="0 0 24 24" width="16">
      <path
        d="M13.25 2.75 6.75 13h4.5L10.75 21.25 17.25 11h-4.5l.5-8.25Z"
        fill="currentColor"
      />
    </svg>
  );
}

function CubeIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 flex-none" fill="none" height="16" viewBox="0 0 24 24" width="16">
      <path
        d="M12 3.75 5.5 7.25v9.5L12 20.25l6.5-3.5v-9.5L12 3.75Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
      <path d="M5.75 7.5 12 11l6.25-3.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 11v9" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 flex-none" fill="none" height="16" viewBox="0 0 24 24" width="16">
      <path
        d="M8.5 17.25h7m-8-1.25V10a4.5 4.5 0 1 1 9 0v6l1.25 1.25H6.25L7.5 16Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
      <path d="M10.5 17.25a1.5 1.5 0 0 0 3 0" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4 flex-none"
      fill="currentColor"
      height="16"
      viewBox="0 0 24 24"
      width="16"
    >
      <path d="M8 6.25v11.5L17.25 12 8 6.25Z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 flex-none" fill="none" height="16" viewBox="0 0 24 24" width="16">
      <circle cx="12" cy="12" r="3.25" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 3.5v2.25M12 18.25v2.25M20.5 12h-2.25M5.75 12H3.5M18.01 5.99l-1.6 1.6M7.59 16.41l-1.6 1.6M18.01 18.01l-1.6-1.6M7.59 7.59l-1.6-1.6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 flex-none" fill="none" height="16" viewBox="0 0 24 24" width="16">
      <path
        d="M15.5 3.75a7.75 7.75 0 1 0 4.75 14.25 8.5 8.5 0 1 1-4.75-14.25Z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5 flex-none"
      fill="none"
      height="14"
      viewBox="0 0 24 24"
      width="14"
    >
      <path
        d="m5.75 12.5 4.1 4.1 8.4-8.85"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.9"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5 flex-none"
      fill="none"
      height="14"
      viewBox="0 0 24 24"
      width="14"
    >
      <path
        d="M6.75 6.75 17.25 17.25M17.25 6.75 6.75 17.25"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.9"
      />
    </svg>
  );
}

function RobotIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 flex-none" fill="none" height="16" viewBox="0 0 24 24" width="16">
      <path
        d="M9 4.5h6M12 4.5v3M7.75 8.75h8.5A2.75 2.75 0 0 1 19 11.5v4.75A2.75 2.75 0 0 1 16.25 19h-8.5A2.75 2.75 0 0 1 5 16.25V11.5A2.75 2.75 0 0 1 7.75 8.75Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
      <circle cx="9.5" cy="13.5" r="1" fill="currentColor" />
      <circle cx="14.5" cy="13.5" r="1" fill="currentColor" />
      <path d="M9.25 16h5.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
    </svg>
  );
}

function SentryAgentMark() {
  return <img alt="" className="h-5 w-5 flex-none object-contain" src="/sentryagent-logo.png" />;
}

function AppChrome({
  theme,
  remainingBudget,
  walletLabel,
  isConnectingWallet,
  isWalletConnected,
  notifications,
  onToggleTheme,
  onConnectWallet,
  onDisconnectWallet,
}: {
  theme: ThemeMode;
  remainingBudget: number;
  walletLabel: string;
  isConnectingWallet: boolean;
  isWalletConnected: boolean;
  notifications: { id: string; title: string; detail: string }[];
  onToggleTheme: () => void;
  onConnectWallet: () => void;
  onDisconnectWallet: () => void;
}) {
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);

  return (
    <header className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-4">
        <div className="flex h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-[var(--surface-accent)] text-[var(--accent-strong)]">
          <SentryAgentMark />
        </div>
        <div>
          <p className="text-[20px] font-semibold tracking-[-0.02em] text-[var(--text)]">SentryAgent</p>
          <p className="text-[12px] uppercase tracking-[0.2em] text-[var(--muted)]">
            Casper autonomous wallet defense
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex h-12 items-center gap-2 rounded-full border border-[var(--budget-border)] bg-[var(--panel)] px-5 text-[15px] text-[var(--text)]">
          <span className="text-[var(--accent-strong)]">
            <BoltIcon />
          </span>
          <span>{formatCurrency(remainingBudget)} remaining</span>
        </div>
        <div className="relative">
          <button
            aria-expanded={isNotificationsOpen}
            aria-label="Notifications"
            className="flex h-11 w-11 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] transition-colors hover:text-[var(--text)]"
            type="button"
            onClick={() => setIsNotificationsOpen((current) => !current)}
          >
            <BellIcon />
          </button>
          {isNotificationsOpen ? (
            <div className="absolute right-0 top-[calc(100%+10px)] z-20 w-[280px] rounded-[18px] border border-[var(--border)] bg-[var(--card)] p-4 shadow-[0_12px_32px_rgba(0,0,0,0.12)]">
              <p className="text-[12px] uppercase tracking-[0.16em] text-[var(--faint)]">Notifications</p>
              <div className="mt-4">
                {notifications.length ? (
                  <div className="space-y-3">
                    {notifications.map((notification) => (
                      <div
                        className="rounded-[14px] border border-[var(--divider)] bg-[var(--surface-soft)] px-4 py-3"
                        key={notification.id}
                      >
                        <p className="text-[14px] font-semibold text-[var(--text)]">{notification.title}</p>
                        <p className="mt-1 text-[13px] text-[var(--muted)]">{notification.detail}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex h-[120px] items-center justify-center text-center text-[14px] text-[var(--muted)]">
                    No notifications yet
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
        <button
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="flex h-11 w-11 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] transition-colors hover:text-[var(--text)]"
          type="button"
          onClick={onToggleTheme}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
        {isWalletConnected ? (
          <button
            className="flex h-12 items-center gap-3 rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 transition-colors hover:border-[var(--budget-border)]"
            type="button"
            onClick={onDisconnectWallet}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--accent)] text-[12px] font-semibold text-[var(--button-ink)]">
              SA
            </div>
            <span className="pr-2 font-mono text-[13px] text-[var(--muted)]">{walletLabel}</span>
          </button>
        ) : (
          <button
            className="inline-flex h-12 items-center justify-center rounded-full bg-[var(--text)] px-6 text-[14px] font-medium text-[var(--bg)] transition-opacity hover:opacity-90"
            type="button"
            onClick={onConnectWallet}
          >
            {isConnectingWallet ? "Connecting..." : "Connect Wallet"}
          </button>
        )}
      </div>
    </header>
  );
}

function SegmentTabs<T extends string>({
  options,
  active,
  onChange,
}: {
  options: readonly T[];
  active: T;
  onChange: (option: T) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-soft)] p-1.5">
      {options.map((option) => {
        const isActive = option === active;

        return (
          <button
            key={option}
            className={`rounded-full px-4 py-2 text-[12px] font-medium transition-colors ${
              isActive
                ? "bg-[var(--surface-accent)] text-[var(--accent-strong)]"
                : "text-[var(--muted)] hover:text-[var(--text)]"
            }`}
            type="button"
            onClick={() => onChange(option)}
          >
            {option === "all"
              ? "All"
              : option === "approved"
                ? "Approved"
                : option === "blocked"
                  ? "Blocked"
                  : option}
          </button>
        );
      })}
    </div>
  );
}

function SpendChart({
  values,
  labels,
}: {
  values: number[];
  labels: string[];
}) {
  const max = Math.max(...values, 1);
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      const y = 100 - (value / max) * 68 - 14;
      return `${x},${y}`;
    })
    .join(" ");
  const area = `0,100 ${points} 100,100`;

  return (
    <div className="mt-8">
      <div className="relative h-[220px] w-full sm:h-[260px]">
        <svg aria-hidden="true" className="h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
          <line x1="0" x2="100" y1="24" y2="24" className="chart-grid" />
          <line x1="0" x2="100" y1="50" y2="50" className="chart-grid" />
          <line x1="0" x2="100" y1="76" y2="76" className="chart-grid" />
          <path d={`M ${area}`} fill="var(--chart-fill)" stroke="none" />
          <polyline
            fill="none"
            points={points}
            stroke="var(--accent)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          />
        </svg>
      </div>
      <div className="mt-4 grid grid-cols-5 text-[10px] text-[var(--faint)]">
        {labels.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
  );
}

function EditablePolicyCard({
  field,
  label,
  detail,
  icon,
  policy,
  editingField,
  draftValue,
  onStartEdit,
  onChangeDraft,
  onConfirm,
  onCancel,
}: {
  field: PolicyField;
  label: string;
  detail: string;
  icon: ReactNode;
  policy: Policy;
  editingField: PolicyField | null;
  draftValue: string;
  onStartEdit: (field: PolicyField) => void;
  onChangeDraft: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const isEditing = editingField === field;
  const numericValue = policy[field];

  return (
    <button
      className="glider-card flex w-full items-center gap-4 rounded-[20px] px-6 py-6 text-left transition-colors hover:border-[var(--budget-border)]"
      type="button"
      onClick={() => {
        if (!isEditing) {
          onStartEdit(field);
        }
      }}
    >
      <div className="flex h-[42px] w-[42px] flex-none items-center justify-center rounded-full bg-[var(--surface-accent)] text-[var(--accent-strong)]">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium uppercase tracking-[0.16em] text-[var(--faint)]">{label}</p>
        <div className="mt-2 flex items-center gap-2">
          {isEditing ? (
            <>
              <input
                autoFocus
                className="w-full rounded-[12px] border border-[var(--input-border)] bg-[var(--input-bg)] px-3 py-2.5 text-[22px] font-semibold text-[var(--text)] outline-none"
                step={field === "dailyCallLimit" ? "1" : "0.01"}
                type="number"
                value={draftValue}
                onChange={(event) => onChangeDraft(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onConfirm();
                  }

                  if (event.key === "Escape") {
                    event.preventDefault();
                    onCancel();
                  }
                }}
              />
              <button
                aria-label={`Confirm ${label}`}
                className="flex h-9 w-9 items-center justify-center rounded-[10px] text-[var(--accent-strong)] transition-colors hover:bg-[var(--surface-soft)]"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onConfirm();
                }}
              >
                <CheckIcon />
              </button>
              <button
                aria-label={`Cancel ${label}`}
                className="flex h-9 w-9 items-center justify-center rounded-[10px] text-[var(--muted)] transition-colors hover:bg-[var(--surface-soft)] hover:text-[var(--text)]"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onCancel();
                }}
              >
                <XIcon />
              </button>
            </>
          ) : (
            <div>
              <p className="text-[28px] font-semibold leading-none text-[var(--text)]">
                {formatPolicyValue(field, numericValue)}
              </p>
              <p className="mt-2 text-[14px] leading-[1.6] text-[var(--muted)]">{detail}</p>
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

function ActivityRow({
  item,
  isNewest,
}: {
  item: ActivityItem;
  isNewest: boolean;
}) {
  const statusClass =
    item.status === "approved"
      ? "text-[var(--accent-strong)]"
      : item.status === "blocked"
        ? "text-[var(--danger)]"
        : "text-[var(--warning)]";

  return (
    <div
      className={`grid grid-cols-[110px_minmax(0,1fr)_120px_110px] gap-4 px-6 py-5 sm:grid-cols-[140px_minmax(0,1fr)_140px_130px] sm:px-7 ${
        isNewest ? "feed-row-flash" : ""
      }`}
    >
      <span className="text-[13px] text-[var(--muted)]">{formatTime(item.requestedAt)}</span>
      <div className="min-w-0">
        <p className="truncate text-[16px] font-medium text-[var(--text)]">
          {item.merchant}
          <span className="ml-2 text-[13px] font-normal text-[var(--muted)]">
            {formatShortEndpoint(item.endpoint)}
          </span>
        </p>
        {item.reason ? (
          <p className="mt-1 truncate text-[12px] text-[var(--muted)]">{item.reason}</p>
        ) : null}
      </div>
      <span className="text-right text-[16px] font-medium text-[var(--text)]">
        {formatCurrency(item.amount)}
      </span>
      <span className={`text-right text-[16px] font-medium ${statusClass}`}>
        {item.status === "approved" ? "Approved" : item.status === "blocked" ? "Blocked" : "Checking"}
      </span>
    </div>
  );
}

function MetricTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="glider-card rounded-[20px] px-6 py-6">
      <p className="text-[12px] uppercase tracking-[0.16em] text-[var(--faint)]">{label}</p>
      <p className="mt-4 text-[40px] font-bold leading-none text-[var(--text)]">{value}</p>
      <p className="mt-3 text-[15px] leading-[1.6] text-[var(--muted)]">{detail}</p>
    </div>
  );
}

function applySessionState(
  session: UserAgentSession,
  setConnectedUserPublicKey: (value: string) => void,
  setAgentPublicKey: (value: string) => void,
  setAgentAccountHash: (value: string) => void,
  setAgentBalanceCspr: (value: number) => void,
  setPolicy: (value: Policy) => void,
  setActivityLog: (value: ActivityItem[]) => void,
) {
  setConnectedUserPublicKey(session.userPublicKey);
  setAgentPublicKey(session.agentPublicKey);
  setAgentAccountHash(session.agentAccountHash);
  setAgentBalanceCspr(session.agentBalanceCspr);
  setPolicy(session.policy);
  setActivityLog(session.activity ?? []);
}

export default function Home() {
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [viewMode, setViewMode] = useState<ViewMode>("landing");
  const [dashboardTab, setDashboardTab] = useState<DashboardTab>("Overview");
  const [policy, setPolicy] = useState<Policy>(defaultPolicy);
  const [activityLog, setActivityLog] = useState<ActivityItem[]>([]);
  const [casperLiveEnabled, setCasperLiveEnabled] = useState(false);
  const [isSubmittingLiveCasper, setIsSubmittingLiveCasper] = useState(false);
  const [chartRange, setChartRange] = useState<ChartRange>("24H");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [editingField, setEditingField] = useState<PolicyField | null>(null);
  const [draftPolicyValue, setDraftPolicyValue] = useState("");
  const [connectedUserPublicKey, setConnectedUserPublicKey] = useState("");
  const [agentPublicKey, setAgentPublicKey] = useState("");
  const [agentAccountHash, setAgentAccountHash] = useState("");
  const [agentBalanceCspr, setAgentBalanceCspr] = useState(0);
  const [fundAmount, setFundAmount] = useState("2.5");
  const [isFundingAgent, setIsFundingAgent] = useState(false);
  const [isConnectingWallet, setIsConnectingWallet] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [statusTone, setStatusTone] = useState<"neutral" | "success" | "danger">("neutral");
  const [hasLoadedSession, setHasLoadedSession] = useState(false);
  const [latestX402Trace, setLatestX402Trace] = useState<string[]>([]);
  const requestIndex = useRef(0);

  const isWalletConnected = Boolean(connectedUserPublicKey);
  const parsedFundAmount = Number(fundAmount);
  const hasValidFundAmount = Number.isFinite(parsedFundAmount) && parsedFundAmount >= MIN_AGENT_FUND_CSPR;
  const fundAmountHint = fundAmount.trim()
    ? hasValidFundAmount
      ? ""
      : `Minimum ${MIN_AGENT_FUND_CSPR} CSPR`
    : "Enter an amount";

  const snapshot: SpendSnapshot = useMemo(
    () => ({
      approvedSpend: activityLog
        .filter((item) => item.status === "approved")
        .reduce((sum, item) => sum + item.amount, 0),
      attemptedCalls: activityLog.length,
      blockedCalls: activityLog.filter((item) => item.status === "blocked").length,
    }),
    [activityLog],
  );

  const notifications = useMemo(() => [] as { id: string; title: string; detail: string }[], []);

  const syncSessionToState = useCallback((session: UserAgentSession) => {
    applySessionState(
      session,
      setConnectedUserPublicKey,
      setAgentPublicKey,
      setAgentAccountHash,
      setAgentBalanceCspr,
      setPolicy,
      setActivityLog,
    );
    setHasLoadedSession(true);
  }, []);

  const connectWallet = useCallback(async () => {
    const provider = getWalletProvider();
    if (!provider) {
      setStatusTone("danger");
      setStatusMessage("Casper Wallet extension was not detected in this browser.");
      setViewMode("app");
      return;
    }

    setIsConnectingWallet(true);
    setStatusTone("neutral");
    setStatusMessage("");

    try {
      const connected = await provider.requestConnection();
      if (!connected) {
        throw new Error("Wallet connection was declined.");
      }

      const userPublicKey = await provider.getActivePublicKey();
      const session = await ensureUserSession(userPublicKey);
      syncSessionToState(session);
      setViewMode("app");
      setStatusTone("success");
      setStatusMessage(`Wallet connected. Agent ready at ${shortPublicKey(session.agentPublicKey)}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to connect Casper Wallet.";
      setStatusTone("danger");
      setStatusMessage(message);
    } finally {
      setIsConnectingWallet(false);
    }
  }, [syncSessionToState]);

  const disconnectWallet = useCallback(async () => {
    try {
      await getWalletProvider()?.disconnectFromSite?.();
    } catch {
      // ignore provider disconnect failures for demo flow
    }

    setConnectedUserPublicKey("");
    setAgentPublicKey("");
    setAgentAccountHash("");
    setAgentBalanceCspr(0);
    setPolicy(defaultPolicy);
    setActivityLog([]);
    setCasperLiveEnabled(false);
    setHasLoadedSession(false);
    setDashboardTab("Overview");
    setStatusTone("neutral");
    setStatusMessage("Wallet disconnected.");
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function hydrateExistingWallet() {
      const provider = getWalletProvider();
      if (!provider?.isConnected) {
        return;
      }

      try {
        const alreadyConnected = await provider.isConnected();
        if (!alreadyConnected) {
          return;
        }

        const userPublicKey = await provider.getActivePublicKey();
        const session = await ensureUserSession(userPublicKey);

        if (!cancelled) {
          syncSessionToState(session);
        }
      } catch {
        // ignore silent hydration errors
      }
    }

    void hydrateExistingWallet();

    return () => {
      cancelled = true;
    };
  }, [syncSessionToState]);

  useEffect(() => {
    if (!connectedUserPublicKey || !hasLoadedSession) {
      return;
    }

    const timer = window.setTimeout(() => {
      void persistUserActivity(connectedUserPublicKey, activityLog).catch(() => {
        // keep the UI responsive even if the demo store write fails
      });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [activityLog, connectedUserPublicKey, hasLoadedSession]);

  const confirmPolicyEdit = useCallback(async () => {
    if (!editingField) {
      return;
    }

    const parsedValue = Number(draftPolicyValue);
    if (Number.isNaN(parsedValue) || parsedValue <= 0) {
      setEditingField(null);
      setDraftPolicyValue("");
      return;
    }

    const nextPolicy: Policy = {
      ...policy,
      [editingField]: editingField === "dailyCallLimit" ? Math.max(1, Math.round(parsedValue)) : parsedValue,
    };

    setPolicy(nextPolicy);
    setEditingField(null);
    setDraftPolicyValue("");

    if (!connectedUserPublicKey) {
      return;
    }

    try {
      const session = await persistUserPolicy(connectedUserPublicKey, nextPolicy);
      setPolicy(session.policy);
      setStatusTone("success");
      setStatusMessage("Policy updated for the connected user wallet.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to persist policy.";
      setStatusTone("danger");
      setStatusMessage(message);
    }
  }, [connectedUserPublicKey, draftPolicyValue, editingField, policy]);

  const cancelPolicyEdit = useCallback(() => {
    setEditingField(null);
    setDraftPolicyValue("");
  }, []);

  const settleComplianceCheck = useCallback(
    async (request: CasperPaymentRequest) => {
      const result =
        request.merchant === "RiskLens" && connectedUserPublicKey
          ? await runRealX402ComplianceCheck(connectedUserPublicKey, request)
          : await runMockX402ComplianceCheck(request);

      if (result.trace?.length) {
        setLatestX402Trace(result.trace);
        console.info("[SentryAgent x402]", result.trace.join("\n"));
      }

      setActivityLog((current) =>
        current.map((item) => {
          if (item.id !== request.id) {
            return item;
          }

          const approvedSpendWithoutCurrent = current
            .filter((entry) => entry.status === "approved" && entry.id !== request.id)
            .reduce((sum, entry) => sum + entry.amount, 0);
          const wouldExceedDailyLimit =
            result.approved && approvedSpendWithoutCurrent + item.amount > policy.dailySpendLimit;
          const nextReasonCode: DecisionReasonCode = result.approved
            ? wouldExceedDailyLimit
              ? "post_check_daily_limit"
              : "compliance_cleared"
            : "compliance_failed";

          return {
            ...item,
            status: result.approved && !wouldExceedDailyLimit ? "approved" : "blocked",
            reasonCode: nextReasonCode,
            reason: createReason(
              nextReasonCode,
              item,
              policy,
              {
                approvedSpend: approvedSpendWithoutCurrent,
                attemptedCalls: current.length,
                blockedCalls: current.filter((entry) => entry.status === "blocked").length,
              },
              result.score,
            ),
            checkedAt: Date.now(),
            complianceCost: result.meteredCost,
            source: result.trace?.length ? "x402" : item.source,
          };
        }),
      );
    },
    [connectedUserPublicKey, policy],
  );

  const fundAgent = useCallback(async () => {
    if (!connectedUserPublicKey) {
      setStatusTone("danger");
      setStatusMessage("Connect a wallet before funding the agent.");
      return;
    }

    if (!hasValidFundAmount) {
      setStatusTone("danger");
      setStatusMessage(`Minimum funding amount is ${MIN_AGENT_FUND_CSPR} CSPR.`);
      return;
    }

    const provider = getWalletProvider();
    if (!provider) {
      setStatusTone("danger");
      setStatusMessage("Casper Wallet extension is not available.");
      return;
    }

    setIsFundingAgent(true);
    setStatusTone("neutral");
    setStatusMessage("Preparing a real Casper testnet transfer for your wallet to sign...");

    try {
      console.info("[fundAgent] prepare:start", {
        userPublicKey: connectedUserPublicKey,
        amountCspr: fundAmount,
      });
      const prepared = await prepareAgentFunding(connectedUserPublicKey, fundAmount);
      console.info("[fundAgent] prepare:success", {
        userPublicKey: connectedUserPublicKey,
        agentPublicKey: prepared.agentPublicKey,
        agentAccountHash: prepared.agentAccountHash,
        preparedPayload: summarizeFundingPayloadJson(JSON.stringify(prepared.deployJson)),
      });
      setAgentPublicKey(prepared.agentPublicKey);
      setAgentAccountHash(prepared.agentAccountHash);
      const signed = await provider.sign(
        JSON.stringify(prepared.deployJson),
        connectedUserPublicKey,
        connectedUserPublicKey,
      );
      const signedDeployJson = await buildSignedDeployJson(
        prepared.deployJson,
        connectedUserPublicKey,
        signed,
      );
      console.info("[fundAgent] signed payload before submit", {
        userPublicKey: connectedUserPublicKey,
        agentPublicKey: prepared.agentPublicKey,
        summary: summarizeFundingPayloadJson(signedDeployJson),
        signedDeployJson,
      });
      const result = await submitAgentFunding(connectedUserPublicKey, {
        signedDeployJson,
        agentPublicKey: prepared.agentPublicKey,
      });

      console.info("[fundAgent] submit:success", {
        userPublicKey: connectedUserPublicKey,
        agentPublicKey: prepared.agentPublicKey,
        deployHash: result.deployHash,
        agentBalanceCspr: result.agentBalanceCspr,
      });

      setAgentBalanceCspr(result.agentBalanceCspr);
      setStatusTone("success");
      setStatusMessage(
        `Agent funded successfully. Transfer deploy ${shortDeployHash(result.deployHash)} is on testnet.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Funding transfer failed.";
      console.error("[fundAgent] error", {
        userPublicKey: connectedUserPublicKey,
        message,
      });
      setStatusTone("danger");
      setStatusMessage(message);
    } finally {
      setIsFundingAgent(false);
    }
  }, [connectedUserPublicKey, fundAmount, hasValidFundAmount]);

  const firePayment = useCallback(async () => {
    if (!connectedUserPublicKey) {
      setStatusTone("danger");
      setStatusMessage("Connect a wallet first so SentryAgent can bind a dedicated agent wallet.");
      return;
    }

    const request = createMockPaymentRequest(requestIndex.current);
    requestIndex.current += 1;

    if (casperLiveEnabled) {
      if (agentBalanceCspr <= 0) {
        setStatusTone("danger");
        setStatusMessage("Fund the agent wallet before sending real Casper contract calls.");
        return;
      }

      setIsSubmittingLiveCasper(true);

      try {
        const result = await checkAndRecordOnCasper(connectedUserPublicKey, request);
        if (result.mcpTrace?.length) {
          console.info("[SentryAgent MCP]", result.mcpTrace.join("\n"));
        }

        const fallbackReason =
          result.reason ??
          (result.status === "approved"
            ? `Casper testnet approved ${result.onchainAmount} cents via ${shortDeployHash(result.deployHash)}.`
            : `Casper testnet blocked ${result.onchainAmount} cents at the onchain cap via ${shortDeployHash(result.deployHash)}.`);
        const nextItem: ActivityItem = {
          ...request,
          status: result.status,
          reasonCode: result.status === "approved" ? "allowlisted" : "per_call_cap",
          reason: fallbackReason,
          checkedAt: Date.now(),
          source: result.source === "mcp" ? "mock" : "casper",
          deployHash: result.deployHash || undefined,
        };

        setActivityLog((current) => [nextItem, ...current]);
        if (typeof result.agentBalanceCspr === "number") {
          setAgentBalanceCspr(result.agentBalanceCspr);
        }
        setStatusTone(result.status === "approved" ? "success" : "danger");
        setStatusMessage(
          result.status === "approved" && result.deployHash
            ? `Live contract call submitted as deploy ${shortDeployHash(result.deployHash)}.`
            : fallbackReason,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Casper testnet request failed.";
        setActivityLog((current) => [
          {
            ...request,
            status: "blocked",
            reasonCode: "per_call_cap",
            reason: `Casper testnet call failed: ${message}`,
            checkedAt: Date.now(),
            source: "casper",
          },
          ...current,
        ]);
        setStatusTone("danger");
        setStatusMessage(message);
      } finally {
        setIsSubmittingLiveCasper(false);
      }

      return;
    }

    setActivityLog((current) => {
      const liveSnapshot: SpendSnapshot = {
        approvedSpend: current
          .filter((item) => item.status === "approved")
          .reduce((sum, item) => sum + item.amount, 0),
        attemptedCalls: current.length,
        blockedCalls: current.filter((item) => item.status === "blocked").length,
      };

      const decision = evaluatePaymentRequest(request, policy, liveSnapshot);
      const reasonCode = classifyDecision(request, policy, liveSnapshot);
      const nextItem: ActivityItem = {
        ...request,
        status: decision.status,
        reasonCode,
        reason: createReason(reasonCode, request, policy, liveSnapshot),
      };

      if (decision.status === "checking") {
        void settleComplianceCheck(request);
      }

      return [nextItem, ...current];
    });
  }, [agentBalanceCspr, casperLiveEnabled, connectedUserPublicKey, policy, settleComplianceCheck]);

  const visibleActivity = useMemo(() => activityLog.slice(0, 8), [activityLog]);
  const checkingCount = activityLog.filter((item) => item.status === "checking").length;
  const remainingBudget = Math.max(policy.dailySpendLimit - snapshot.approvedSpend, 0);
  const recentActivity = activityLog.slice(0, 3);

  const filteredActivity = visibleActivity.filter((item) => {
    if (activityFilter === "all") {
      return true;
    }

    return item.status === activityFilter;
  });

  const chartSeries = useMemo(() => {
    const base =
      chartRange === "1H"
        ? [0.12, 0.22, 0.18, 0.36, 0.29]
        : chartRange === "24H"
          ? [0.12, 0.22, 0.18, 0.36, 0.29]
          : [0.08, 0.16, 0.28, 0.2, 0.38];

    const liveSpend = activityLog
      .filter((item) => item.status === "approved")
      .slice(0, 5)
      .reverse()
      .map((item) => Math.max(item.amount / 3, 0.08));

    return liveSpend.length
      ? [...base.slice(0, Math.max(0, 5 - liveSpend.length)), ...liveSpend].slice(-5)
      : base;
  }, [activityLog, chartRange]);

  const chartLabels =
    chartRange === "1H"
      ? ["09:00", "09:15", "09:30", "09:45", "10:00"]
      : chartRange === "24H"
        ? ["00:00", "06:00", "12:00", "18:00", "Now"]
        : ["Mon", "Tue", "Wed", "Thu", "Fri"];

  const walletLabel = isWalletConnected ? shortPublicKey(connectedUserPublicKey) : "Connect Wallet";
  const statusClass =
    statusTone === "success"
      ? "border-[var(--accent)] bg-[var(--surface-accent)] text-[var(--accent-strong)]"
      : statusTone === "danger"
        ? "border-[var(--danger)]/25 bg-[color:rgba(239,68,68,0.08)] text-[var(--danger)]"
        : "border-[var(--border)] bg-[var(--surface-soft)] text-[var(--muted)]";

  return (
    <main
      className="min-h-screen w-full bg-[var(--bg)] text-[var(--text)] transition-colors"
      data-theme={theme}
      style={themeVars[theme]}
    >
      {viewMode === "landing" ? (
        <div className="hero-shell relative min-h-screen overflow-hidden">
          <div className="hero-orb pointer-events-none absolute right-[-120px] top-[80px] h-[320px] w-[320px] rounded-full blur-3xl" />
          <div className="relative mx-auto flex min-h-screen w-full max-w-[1600px] flex-col px-5 py-7 sm:px-8 lg:px-10 xl:px-12">
            <header className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="flex h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-[var(--surface-accent)] text-[var(--accent-strong)]">
                  <SentryAgentMark />
                </div>
                <div>
                  <p className="text-[20px] font-semibold tracking-[-0.02em] text-[var(--text)]">SentryAgent</p>
                  <p className="text-[12px] uppercase tracking-[0.2em] text-[var(--muted)]">
                    Casper autonomous wallet defense
                  </p>
                </div>
              </div>

              <button
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                className="flex h-12 w-12 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] transition-colors hover:text-[var(--text)]"
                type="button"
                onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
              >
                {theme === "dark" ? <SunIcon /> : <MoonIcon />}
              </button>
            </header>

            <section className="relative flex flex-1 flex-col items-center justify-center py-16 text-center">
              <div className="mb-8 inline-flex items-center gap-3 text-[12px] uppercase tracking-[0.18em] text-[var(--muted)]">
                <span className="h-px w-10 bg-[var(--hero-line)]" />
                Spend-policy guardrail layer for AI wallets on Casper
                <span className="h-px w-10 bg-[var(--hero-line)]" />
              </div>
              <h1 className="mx-auto max-w-[1040px] text-[58px] font-semibold leading-[0.95] tracking-[-0.055em] text-[var(--text)] sm:text-[78px] lg:text-[112px] xl:text-[132px]">
                Guardrails for wallets that don&apos;t sleep.
              </h1>
              <p className="mt-8 max-w-[860px] text-[20px] leading-[1.7] text-[var(--muted)] sm:text-[22px]">
                Give your agent a wallet. Give yourself the final say.
              </p>
            </section>

            <div className="flex justify-center pb-10">
              <button
                className="inline-flex h-16 items-center justify-center gap-3 rounded-full bg-[var(--text)] px-9 text-[17px] font-medium text-[var(--bg)] transition-opacity hover:opacity-90"
                type="button"
                onClick={() => setViewMode("app")}
              >
                <PlayIcon />
                Launch app
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div>
          <div className="hero-shell relative overflow-hidden border-b border-[var(--divider)]">
            <div className="hero-orb pointer-events-none absolute right-[-120px] top-[80px] h-[320px] w-[320px] rounded-full blur-3xl" />
            <div className="relative mx-auto w-full max-w-[1600px] px-5 py-7 sm:px-8 lg:px-10 xl:px-12">
              <AppChrome
                isConnectingWallet={isConnectingWallet}
                isWalletConnected={isWalletConnected}
                notifications={notifications}
                remainingBudget={remainingBudget}
                theme={theme}
                walletLabel={walletLabel}
                onConnectWallet={() => void connectWallet()}
                onDisconnectWallet={() => void disconnectWallet()}
                onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
              />
            </div>
          </div>

          <div id="monitor" className="mx-auto w-full max-w-[1600px] px-5 py-8 sm:px-8 lg:px-10 xl:px-12">
            {statusMessage ? (
              <div className={`mb-6 rounded-[18px] border px-5 py-4 text-[14px] ${statusClass}`}>{statusMessage}</div>
            ) : null}

            <div className="mb-6 flex items-center justify-between gap-4">
              <SegmentTabs active={dashboardTab} options={dashboardTabs} onChange={setDashboardTab} />
            </div>

            {dashboardTab === "Overview" ? (
              <div className="space-y-6">
                <section className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
                  <div className="glider-card rounded-[24px] px-7 py-7 sm:px-8 sm:py-8">
                    <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                      <div className="max-w-[720px]">
                        <p className="text-[12px] uppercase tracking-[0.16em] text-[var(--faint)]">Live monitor</p>
                        <h2 className="mt-4 text-[36px] font-semibold tracking-[-0.03em] text-[var(--text)] sm:text-[48px]">
                          Watch every spend request before funds move.
                        </h2>
                        <p className="mt-5 text-[17px] leading-[1.8] text-[var(--muted)] sm:text-[18px]">
                          Review approvals, compliance checks, and blocked requests in one place.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-3">
                        <button
                          className="inline-flex h-14 items-center gap-2 rounded-full bg-[var(--accent)] px-6 text-[16px] font-medium text-[var(--button-ink)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                          type="button"
                          disabled={!isWalletConnected || isSubmittingLiveCasper}
                          onClick={() => void firePayment()}
                        >
                          <PlayIcon />
                          {isSubmittingLiveCasper ? "Sending to Casper..." : "Fire request"}
                        </button>
                        <button
                          className={`inline-flex h-14 items-center gap-2 rounded-full border px-6 text-[15px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            casperLiveEnabled
                              ? "border-[var(--accent)] bg-[var(--surface-accent)] text-[var(--accent-strong)]"
                              : "border-[var(--border)] bg-[var(--button-secondary)] text-[var(--muted)]"
                          }`}
                          type="button"
                          disabled={!isWalletConnected}
                          onClick={() => setCasperLiveEnabled((current) => !current)}
                        >
                          <span
                            className={`h-2.5 w-2.5 rounded-full ${
                              casperLiveEnabled ? "bg-[var(--accent)]" : "bg-[var(--muted)]"
                            }`}
                          />
                          {casperLiveEnabled ? "Live Casper checks" : "Demo mode"}
                        </button>
                      </div>
                    </div>

                    <SpendChart labels={chartLabels} values={chartSeries} />

                    <div className="mt-5 flex items-center justify-between">
                      <p className="text-[13px] text-[var(--muted)]">
                        {isWalletConnected
                          ? `Connected wallet ${shortPublicKey(connectedUserPublicKey)}`
                          : "Connect your wallet to get started"}
                      </p>
                      <SegmentTabs active={chartRange} options={chartRanges} onChange={setChartRange} />
                    </div>
                  </div>

                  <div className="glider-card rounded-[24px] px-7 py-7 sm:px-8 sm:py-8">
                    <p className="text-[12px] uppercase tracking-[0.16em] text-[var(--faint)]">Guarded agent</p>
                    <div className="mt-6 flex items-start gap-5">
                      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--surface-accent)] text-[var(--accent-strong)]">
                        <RobotIcon />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[20px] font-semibold text-[var(--text)]">Arbitrage Scanner Bot</p>
                        <p className="mt-3 text-[15px] leading-[1.7] text-[var(--muted)]">
                          Buying live market data across 5 endpoints to identify cross-DEX arbitrage opportunities.
                        </p>
                        <div className="mt-5 grid gap-3">
                          <div className="flex flex-wrap items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent)] text-[13px] font-semibold text-[var(--button-ink)]">
                              AR
                            </div>
                            <span className="font-mono text-[14px] text-[var(--muted)]">
                              {agentPublicKey ? shortPublicKey(agentPublicKey) : "Connect wallet to see your agent"}
                            </span>
                          </div>
                          <p className="font-mono text-[13px] text-[var(--faint)]">
                            {agentAccountHash || "Connect wallet to see your agent's address"}
                          </p>
                          <p className="text-[15px] text-[var(--muted)]">
                            Balance:{" "}
                            <span className="text-[18px] font-semibold text-[var(--text)]">
                              {formatBalance(agentBalanceCspr)} CSPR
                            </span>
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="grid gap-4 lg:grid-cols-3">
                  <MetricTile
                    detail="Remaining approved budget for today."
                    label="Available today"
                    value={formatCurrency(remainingBudget)}
                  />
                  <MetricTile
                    detail="Requests inspected for this wallet."
                    label="Requests inspected"
                    value={String(snapshot.attemptedCalls).padStart(2, "0")}
                  />
                  <MetricTile
                    detail={checkingCount ? "Requests waiting on compliance review." : "No requests waiting right now."}
                    label="Compliance queue"
                    value={checkingCount ? String(checkingCount).padStart(2, "0") : "Idle"}
                  />
                </section>

                <section className="rounded-[24px] border border-[var(--border)] bg-[var(--card)]">
                  <div className="flex flex-col gap-4 border-b border-[var(--divider)] px-6 py-6 sm:px-7 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <p className="text-[12px] uppercase tracking-[0.16em] text-[var(--faint)]">Recent activity</p>
                      <h3 className="mt-3 text-[28px] font-semibold tracking-[-0.03em] text-[var(--text)]">
                        Latest decisions
                      </h3>
                    </div>
                    <button
                      className="text-[14px] font-medium text-[var(--accent-strong)] transition-opacity hover:opacity-80"
                      type="button"
                      onClick={() => setDashboardTab("Activity")}
                    >
                      View all
                    </button>
                  </div>

                  {recentActivity.length ? (
                    recentActivity.map((item, index) => (
                      <div className={index < recentActivity.length - 1 ? "border-b border-[var(--divider)]" : ""} key={item.id}>
                        <ActivityRow isNewest={index === 0} item={item} />
                      </div>
                    ))
                  ) : (
                    <div className="px-6 py-14 text-center text-[16px] font-medium text-[var(--text)]">
                      {isWalletConnected ? "No activity yet" : "Connect wallet to begin"}
                    </div>
                  )}
                </section>
              </div>
            ) : null}

            {dashboardTab === "Policy" ? (
              <div className="space-y-6">
                <section className="glider-card rounded-[24px] px-7 py-7 sm:px-8 sm:py-8">
                  <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
                    <div className="max-w-[720px]">
                      <p className="text-[12px] uppercase tracking-[0.16em] text-[var(--faint)]">Guarded agent</p>
                      <div className="mt-6 flex items-start gap-5">
                        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--surface-accent)] text-[var(--accent-strong)]">
                          <RobotIcon />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-[20px] font-semibold text-[var(--text)]">Arbitrage Scanner Bot</p>
                          <p className="mt-3 text-[15px] leading-[1.7] text-[var(--muted)]">
                            Buying live market data across 5 endpoints to identify cross-DEX arbitrage opportunities.
                          </p>
                          <div className="mt-5 grid gap-3">
                            <div className="flex flex-wrap items-center gap-3">
                              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent)] text-[13px] font-semibold text-[var(--button-ink)]">
                                AR
                              </div>
                              <span className="font-mono text-[14px] text-[var(--muted)]">
                                {agentPublicKey ? shortPublicKey(agentPublicKey) : "Connect wallet to see your agent"}
                              </span>
                            </div>
                            <p className="font-mono text-[13px] text-[var(--faint)]">
                              {agentAccountHash || "Connect wallet to see your agent's address"}
                            </p>
                            <p className="text-[15px] text-[var(--muted)]">
                              Balance:{" "}
                              <span className="text-[18px] font-semibold text-[var(--text)]">
                                {formatBalance(agentBalanceCspr)} CSPR
                              </span>
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="w-full max-w-[420px] border-t border-[var(--divider)] pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
                      <p className="text-[12px] uppercase tracking-[0.16em] text-[var(--faint)]">Fund agent</p>
                      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                        <input
                          className="h-12 flex-1 rounded-[14px] border border-[var(--input-border)] bg-[var(--input-bg)] px-4 text-[15px] text-[var(--text)] outline-none"
                          inputMode="decimal"
                          min={MIN_AGENT_FUND_CSPR}
                          placeholder="2.5"
                          step="0.1"
                          type="number"
                          value={fundAmount}
                          onChange={(event) => setFundAmount(event.target.value)}
                        />
                        <button
                          className="inline-flex h-12 items-center justify-center rounded-full bg-[var(--text)] px-6 text-[14px] font-medium text-[var(--bg)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                          type="button"
                          disabled={!isWalletConnected || isFundingAgent || !hasValidFundAmount}
                          onClick={() => void fundAgent()}
                        >
                          {isFundingAgent ? "Waiting for signature..." : "Fund agent"}
                        </button>
                      </div>
                      {fundAmountHint ? (
                        <p className="mt-2 text-[12px] font-medium text-[var(--danger)]">
                          {fundAmountHint}
                        </p>
                      ) : null}
                      <p className="mt-3 text-[13px] leading-[1.7] text-[var(--muted)]">
                        Move testnet CSPR into your agent wallet before running live requests.
                      </p>
                    </div>
                  </div>
                </section>

                <section className="grid gap-4 lg:grid-cols-3">
                  <EditablePolicyCard
                    detail="Maximum approved amount for any single payment."
                    draftValue={draftPolicyValue}
                    editingField={editingField}
                    field="perCallCap"
                    icon={<BoltIcon />}
                    label="Per-call cap"
                    policy={policy}
                    onCancel={cancelPolicyEdit}
                    onChangeDraft={setDraftPolicyValue}
                    onConfirm={() => void confirmPolicyEdit()}
                    onStartEdit={(field) => {
                      setEditingField(field);
                      setDraftPolicyValue(String(policy[field]));
                    }}
                  />
                  <EditablePolicyCard
                    detail="Total amount this agent can approve in a day."
                    draftValue={draftPolicyValue}
                    editingField={editingField}
                    field="dailySpendLimit"
                    icon={<ShieldCheckIcon />}
                    label="Daily limit"
                    policy={policy}
                    onCancel={cancelPolicyEdit}
                    onChangeDraft={setDraftPolicyValue}
                    onConfirm={() => void confirmPolicyEdit()}
                    onStartEdit={(field) => {
                      setEditingField(field);
                      setDraftPolicyValue(String(policy[field]));
                    }}
                  />
                  <EditablePolicyCard
                    detail="Maximum number of requests allowed per day."
                    draftValue={draftPolicyValue}
                    editingField={editingField}
                    field="dailyCallLimit"
                    icon={<CubeIcon />}
                    label="Daily call count"
                    policy={policy}
                    onCancel={cancelPolicyEdit}
                    onChangeDraft={setDraftPolicyValue}
                    onConfirm={() => void confirmPolicyEdit()}
                    onStartEdit={(field) => {
                      setEditingField(field);
                      setDraftPolicyValue(String(policy[field]));
                    }}
                  />
                </section>
              </div>
            ) : null}

            {dashboardTab === "Activity" ? (
              <div className="space-y-6">
                {latestX402Trace.length ? (
                  <section className="rounded-[24px] border border-[var(--border)] bg-[var(--card)] px-6 py-6 sm:px-7">
                    <div className="flex flex-col gap-3">
                      <div>
                        <p className="text-[12px] uppercase tracking-[0.16em] text-[var(--faint)]">Compliance trace</p>
                        <h3 className="mt-3 text-[24px] font-semibold tracking-[-0.03em] text-[var(--text)]">
                          Latest RiskLens check
                        </h3>
                      </div>
                      <div className="space-y-2 font-mono text-[13px] leading-[1.7] text-[var(--muted)]">
                        {latestX402Trace.map((entry) => (
                          <p key={entry}>{entry}</p>
                        ))}
                      </div>
                    </div>
                  </section>
                ) : null}

                <section className="rounded-[24px] border border-[var(--border)] bg-[var(--card)]">
                  <div className="flex flex-col gap-4 border-b border-[var(--divider)] px-6 py-6 sm:px-7 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <p className="text-[12px] uppercase tracking-[0.16em] text-[var(--faint)]">Activity feed</p>
                      <h3 className="mt-3 text-[30px] font-semibold tracking-[-0.03em] text-[var(--text)]">
                        Live activity stream
                      </h3>
                    </div>
                    <SegmentTabs active={activityFilter} options={activityFilters} onChange={setActivityFilter} />
                  </div>

                  <div className="grid grid-cols-[110px_minmax(0,1fr)_120px_110px] gap-4 border-b border-[var(--divider)] px-6 py-4 text-[11px] uppercase tracking-[0.14em] text-[var(--muted)] sm:grid-cols-[140px_minmax(0,1fr)_140px_130px] sm:px-7">
                    <span>Time</span>
                    <span>Merchant</span>
                    <span className="text-right">Amount</span>
                    <span className="text-right">Status</span>
                  </div>

                  {filteredActivity.length ? (
                    filteredActivity.map((item, index) => (
                      <div
                        className={index < filteredActivity.length - 1 ? "border-b border-[var(--divider)]" : ""}
                        key={item.id}
                      >
                        <ActivityRow isNewest={index === 0} item={item} />
                      </div>
                    ))
                  ) : (
                    <div className="px-6 py-14 text-center text-[16px] font-medium text-[var(--text)]">
                      {isWalletConnected ? "No activity yet" : "Connect wallet to begin"}
                    </div>
                  )}
                </section>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </main>
  );
}
