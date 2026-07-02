"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createMockPaymentRequest, type CasperPaymentRequest } from "@/lib/casper";
import { evaluatePaymentRequest, type Policy, type SpendSnapshot } from "@/lib/policy";
import { runMockX402ComplianceCheck } from "@/lib/x402";

type ActivityStatus = "approved" | "blocked" | "checking";
type ActivityFilter = "all" | "approved" | "blocked";
type ChartRange = "1H" | "24H" | "7D";

type ActivityItem = CasperPaymentRequest & {
  status: ActivityStatus;
  reason: string;
  checkedAt?: number;
  complianceCost?: number;
};

const initialPolicy: Policy = {
  perCallCap: 2,
  dailySpendLimit: 9.5,
  dailyCallLimit: 18,
  allowlist: [
    "https://api.cspr.cloud/v1",
    "https://oracledock.dev",
    "https://marketpulse.exchange/quotes",
  ],
};

const chartRanges: ChartRange[] = ["1H", "24H", "7D"];
const activityFilters: ActivityFilter[] = ["all", "approved", "blocked"];

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
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

function formatWalletAddress() {
  return "0x82..4F1";
}

function ShieldCheckIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
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
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
      <path
        d="M13.25 2.75 6.75 13h4.5L10.75 21.25 17.25 11h-4.5l.5-8.25Z"
        fill="currentColor"
      />
    </svg>
  );
}

function CubeIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
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
    <svg aria-hidden="true" className="h-4 w-4" fill="none" viewBox="0 0 24 24">
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
    <svg aria-hidden="true" className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
      <path d="M8 6.25v11.5L17.25 12 8 6.25Z" />
    </svg>
  );
}

function PolicyCard({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="glider-card flex items-center gap-3 rounded-[14px] px-4 py-4">
      <div className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full bg-[rgba(34,197,94,0.14)] text-[var(--accent)]">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-[var(--text)]">{title}</p>
        <p className="mt-1 text-[11px] text-[var(--muted)]">{detail}</p>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  suffix,
}: {
  label: string;
  value: string;
  suffix?: string;
}) {
  return (
    <div className="glider-card rounded-[14px] px-4 py-4">
      <p className="text-[10px] uppercase tracking-[0.04em] text-[var(--faint)]">{label}</p>
      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-[24px] font-semibold leading-none text-[var(--text)]">{value}</span>
        {suffix ? <span className="text-[14px] text-[var(--muted)]">{suffix}</span> : null}
      </div>
    </div>
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
    <div className="inline-flex items-center rounded-[999px] bg-[rgba(255,255,255,0.02)] p-1">
      {options.map((option) => {
        const isActive = option === active;

        return (
          <button
            key={option}
            className={`rounded-[999px] px-3 py-1.5 text-[11px] font-medium transition-colors ${
              isActive
                ? "bg-[rgba(34,197,94,0.14)] text-[var(--accent)]"
                : "text-[var(--muted)] hover:text-[var(--text)]"
            }`}
            type="button"
            onClick={() => onChange(option)}
          >
            {option === "all" ? "All" : option === "approved" ? "Approved" : option === "blocked" ? "Blocked" : option}
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
    <div className="mt-5">
      <div className="relative h-[120px] w-full">
        <svg aria-hidden="true" className="h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
          <line x1="0" x2="100" y1="24" y2="24" className="chart-grid" />
          <line x1="0" x2="100" y1="50" y2="50" className="chart-grid" />
          <line x1="0" x2="100" y1="76" y2="76" className="chart-grid" />
          <path d={`M ${area}`} fill="rgba(34,197,94,0.1)" stroke="none" />
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
      <div className="mt-3 grid grid-cols-5 text-[10px] text-[var(--faint)]">
        {labels.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </div>
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
      ? "text-[var(--accent)]"
      : item.status === "blocked"
        ? "text-[var(--danger)]"
        : "text-[var(--warning)]";

  return (
    <div className={`grid grid-cols-[80px_minmax(0,1fr)_88px_76px] gap-3 px-4 py-4 ${isNewest ? "feed-row-flash" : ""}`}>
      <span className="text-[12px] text-[var(--muted)]">{formatTime(item.requestedAt)}</span>
      <div className="min-w-0">
        <p className="truncate text-[13px] font-medium text-[var(--text)]">
          {item.merchant}
          <span className="ml-2 text-[12px] font-normal text-[var(--muted)]">
            {formatShortEndpoint(item.endpoint)}
          </span>
        </p>
      </div>
      <span className="text-right text-[13px] font-medium text-[var(--text)]">
        {formatCurrency(item.amount)}
      </span>
      <span className={`text-right text-[13px] font-medium ${statusClass}`}>
        {item.status === "approved" ? "Approved" : item.status === "blocked" ? "Blocked" : "Checking"}
      </span>
    </div>
  );
}

export default function Home() {
  const [policy, setPolicy] = useState<Policy>(initialPolicy);
  const [activityLog, setActivityLog] = useState<ActivityItem[]>([]);
  const [chartRange, setChartRange] = useState<ChartRange>("24H");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const requestIndex = useRef(0);

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

  const settleComplianceCheck = useCallback(
    async (request: CasperPaymentRequest) => {
      const result = await runMockX402ComplianceCheck(request);

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

          return {
            ...item,
            status: result.approved && !wouldExceedDailyLimit ? "approved" : "blocked",
            reason: wouldExceedDailyLimit
              ? `Compliance cleared, but final approval would exceed today's $${policy.dailySpendLimit.toFixed(2)} limit.`
              : result.reason,
            checkedAt: Date.now(),
            complianceCost: result.meteredCost,
          };
        }),
      );
    },
    [policy.dailySpendLimit],
  );

  const firePayment = useCallback(() => {
    const request = createMockPaymentRequest(requestIndex.current);
    requestIndex.current += 1;

    setActivityLog((current) => {
      const liveSnapshot: SpendSnapshot = {
        approvedSpend: current
          .filter((item) => item.status === "approved")
          .reduce((sum, item) => sum + item.amount, 0),
        attemptedCalls: current.length,
        blockedCalls: current.filter((item) => item.status === "blocked").length,
      };

      const decision = evaluatePaymentRequest(request, policy, liveSnapshot);
      const nextItem: ActivityItem = {
        ...request,
        status: decision.status,
        reason: decision.reason,
      };

      if (decision.status === "checking") {
        void settleComplianceCheck(request);
      }

      return [nextItem, ...current];
    });
  }, [policy, settleComplianceCheck]);

  const visibleActivity = useMemo(() => activityLog.slice(0, 4), [activityLog]);
  const checkingCount = activityLog.filter((item) => item.status === "checking").length;
  const approvedCount = activityLog.filter((item) => item.status === "approved").length;
  const remainingBudget = Math.max(policy.dailySpendLimit - snapshot.approvedSpend, 0);

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

  const nextCheckLabel = checkingCount ? "Running" : "Idle";

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <div className="mx-auto max-w-[1180px] px-5 py-7 sm:px-6 lg:px-8">
        <header className="pb-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-[26px] w-[26px] items-center justify-center rounded-[8px] bg-[rgba(34,197,94,0.14)] text-[var(--accent)]">
                <ShieldCheckIcon />
              </div>
              <span className="text-[14px] font-semibold text-[var(--text)]">SentryAgent</span>
            </div>

            <div className="flex flex-wrap items-center gap-[14px]">
              <div className="flex items-center gap-2 rounded-[20px] border border-white/10 px-3 py-2 text-[12px] text-[var(--text)]">
                <span className="text-[var(--accent)]">
                  <BoltIcon />
                </span>
                <span>{formatCurrency(remainingBudget)} remaining</span>
              </div>
              <button
                aria-label="Notifications"
                className="flex h-9 w-9 items-center justify-center rounded-full border border-transparent text-[var(--muted)] transition-colors hover:text-[var(--text)]"
                type="button"
              >
                <BellIcon />
              </button>
              <div className="flex items-center gap-3">
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent)] text-[11px] font-semibold text-[#08170C]">
                  SA
                </div>
                <span className="font-mono text-[12px] text-[var(--muted)]">{formatWalletAddress()}</span>
              </div>
            </div>
          </div>
        </header>

        <section className="mb-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-[var(--text)]">
                Spend policy monitor
              </h1>
              <p className="mt-2 max-w-[420px] text-[13px] leading-[1.5] text-[var(--muted)]">
                Review simulated x402 payment requests against policy guardrails before any Casper wallet spend would be allowed through.
              </p>
              <div className="mt-4 flex items-center gap-2">
                <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] text-[var(--muted)]">
                  <CubeIcon />
                </span>
                <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-[rgba(34,197,94,0.14)] text-[var(--accent)]">
                  <BoltIcon />
                </span>
                <span className="ml-1 text-[10px] uppercase tracking-[0.04em] text-[var(--muted)]">
                  CASPER · X402
                </span>
              </div>
            </div>

            <button
              className="inline-flex h-11 items-center gap-2 rounded-[12px] bg-[var(--accent)] px-4 text-[13px] font-medium text-[#08170C] transition-opacity hover:opacity-90"
              type="button"
              onClick={firePayment}
            >
              <PlayIcon />
              Fire request
            </button>
          </div>
        </section>

        <section className="grid gap-[14px] lg:grid-cols-[minmax(0,1fr)_180px]">
          <div className="glider-card rounded-[16px] px-5 py-[18px]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[12px] text-[var(--muted)]">Today&apos;s spend</p>
                <p className="mt-2 text-[28px] font-semibold leading-none text-[var(--text)]">
                  {formatCurrency(snapshot.approvedSpend)}
                </p>
                <p className="mt-2 text-[12px] text-[var(--accent)]">
                  +{formatCurrency(snapshot.approvedSpend || 0.72)} today
                </p>
              </div>
              <SegmentTabs active={chartRange} options={chartRanges} onChange={setChartRange} />
            </div>

            <SpendChart labels={chartLabels} values={chartSeries} />
          </div>

          <div className="grid gap-[10px]">
            <StatCard label="CALLS MADE" suffix={`/${policy.dailyCallLimit}`} value={String(snapshot.attemptedCalls).padStart(2, "0")} />
            <StatCard label="BLOCKED" value={String(snapshot.blockedCalls).padStart(2, "0")} />
            <StatCard label="NEXT CHECK" value={nextCheckLabel} />
          </div>
        </section>

        <section className="mt-5 grid gap-3 lg:grid-cols-3">
          <PolicyCard
            detail="Max per single payment."
            icon={<BoltIcon />}
            title={`Per-call cap: ${formatCurrency(policy.perCallCap)}`}
          />
          <PolicyCard
            detail="Total approved spend allowed today."
            icon={<ShieldCheckIcon />}
            title={`Daily limit: ${formatCurrency(policy.dailySpendLimit)}`}
          />
          <PolicyCard
            detail="Maximum number of calls per day."
            icon={<CubeIcon />}
            title={`Daily call count: ${policy.dailyCallLimit}`}
          />
        </section>

        <section className="mt-6">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-[15px] font-semibold text-[var(--text)]">Live activity</h2>
            <SegmentTabs active={activityFilter} options={activityFilters} onChange={setActivityFilter} />
          </div>

          <div className="overflow-hidden rounded-[14px] border border-[rgba(255,255,255,0.07)] bg-[var(--card)]">
            <div className="grid grid-cols-[80px_minmax(0,1fr)_88px_76px] gap-3 border-b border-[rgba(255,255,255,0.06)] px-4 py-3 text-[10px] uppercase tracking-[0.04em] text-[var(--muted)]">
              <span>Time</span>
              <span>Merchant</span>
              <span className="text-right">Amount</span>
              <span className="text-right">Status</span>
            </div>

            {filteredActivity.length ? (
              filteredActivity.map((item, index) => (
                <div
                  className={index < filteredActivity.length - 1 ? "border-b border-[rgba(255,255,255,0.06)]" : ""}
                  key={item.id}
                >
                  <ActivityRow isNewest={index === 0} item={item} />
                </div>
              ))
            ) : (
              <div className="px-4 py-10 text-center">
                <p className="text-[13px] font-medium text-[var(--text)]">No activity yet</p>
                <p className="mt-2 text-[13px] text-[var(--muted)]">
                  Fire a request to stream simulated wallet spend decisions into the feed.
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
