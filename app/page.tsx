"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createMockPaymentRequest, type CasperPaymentRequest } from "@/lib/casper";
import { evaluatePaymentRequest, type Policy, type SpendSnapshot } from "@/lib/policy";
import { runMockX402ComplianceCheck } from "@/lib/x402";

type ActivityStatus = "approved" | "blocked" | "checking";

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

function SummaryMetric({
  label,
  value,
  tone = "default",
  detail,
}: {
  label: string;
  value: string;
  tone?: "default" | "accent" | "danger";
  detail: string;
}) {
  const valueClass =
    tone === "accent"
      ? "terminal-value text-[var(--accent)]"
      : tone === "danger"
        ? "terminal-value-danger text-[var(--danger)]"
        : "terminal-value text-[var(--text)]";

  return (
    <div className="terminal-panel px-4 py-3">
      <p className="terminal-label">{label}</p>
      <p className={`mt-2 text-[1.85rem] font-semibold leading-none ${valueClass}`}>{value}</p>
      <p className="mt-2 text-[11px] text-[var(--muted)]">{detail}</p>
    </div>
  );
}

function RailField({
  label,
  value,
  prefix,
  min,
  step,
  onChange,
}: {
  label: string;
  value: number;
  prefix?: string;
  min: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid gap-2 py-3">
      <span className="terminal-label">{label}</span>
      <div className="terminal-input-shell flex items-center gap-2 px-3 py-2">
        {prefix ? <span className="text-sm text-[var(--accent)]">{prefix}</span> : null}
        <input
          className="w-full bg-transparent text-[1.4rem] font-semibold leading-none text-[var(--text)] outline-none"
          min={min}
          step={step}
          type="number"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </div>
    </label>
  );
}

function ControlButton({
  active = false,
  label,
  onClick,
  priority = "default",
}: {
  active?: boolean;
  label: string;
  onClick: () => void;
  priority?: "default" | "primary";
}) {
  const className =
    priority === "primary" || active
      ? "border-[rgba(0,255,156,0.5)] bg-[rgba(0,255,156,0.08)] text-[var(--accent)] shadow-[inset_0_0_0_1px_rgba(0,255,156,0.12),0_0_24px_rgba(0,255,156,0.08)] hover:border-[rgba(0,255,156,0.9)] hover:bg-[rgba(0,255,156,0.12)]"
      : "border-white/14 bg-[rgba(255,255,255,0.02)] text-[var(--text)] hover:border-white/30 hover:bg-[rgba(255,255,255,0.05)]";

  return (
    <button
      className={`rounded-[5px] border px-3 py-2 text-[11px] uppercase tracking-[0.14em] transition-all duration-150 hover:shadow-[0_0_18px_rgba(0,255,156,0.06)] ${className}`}
      type="button"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function StatusBadge({ status }: { status: ActivityStatus }) {
  const badgeStyles =
    status === "approved"
      ? "border-[rgba(0,255,156,0.32)] text-[var(--accent)]"
      : status === "blocked"
        ? "border-[rgba(255,59,59,0.36)] text-[var(--danger)]"
        : "border-[rgba(255,176,32,0.32)] text-[var(--warning)]";

  return (
    <span
      className={`inline-flex w-fit items-center rounded-[4px] border px-2 py-1 text-[10px] uppercase tracking-[0.12em] ${badgeStyles}`}
    >
      {status}
    </span>
  );
}

function ActivityRow({
  item,
  isNewest,
}: {
  item: ActivityItem;
  isNewest: boolean;
}) {
  const rowTone =
    item.status === "blocked"
      ? {
          left: "border-l-[var(--danger)]",
          amount: "text-[var(--danger)] terminal-value-danger",
          tint: "bg-[rgba(255,59,59,0.05)]",
        }
      : item.status === "approved"
        ? {
            left: "border-l-[var(--accent)]",
            amount: "text-[var(--accent)] terminal-value",
            tint: "bg-[rgba(0,255,156,0.045)]",
          }
        : {
            left: "border-l-[var(--warning)]",
            amount: "text-[var(--warning)]",
            tint: "bg-[rgba(255,176,32,0.045)]",
          };

  return (
    <article
      className={`border-b border-white/6 border-l-2 px-4 py-3 odd:bg-[rgba(255,255,255,0.015)] even:bg-[rgba(255,255,255,0.028)] ${rowTone.left} ${rowTone.tint} ${isNewest ? "stream-row" : ""}`}
    >
      <div className="grid gap-2 lg:grid-cols-[86px_112px_minmax(0,1.3fr)_100px_88px] lg:items-center lg:gap-3">
        <span className="text-[11px] text-[var(--muted)]">{formatTime(item.requestedAt)}</span>
        <span className="truncate text-[11px] uppercase tracking-[0.08em] text-[var(--text)]">
          {item.merchant}
        </span>
        <span className="truncate text-[12px] text-[var(--text)]">
          {formatShortEndpoint(item.endpoint)}
        </span>
        <span className={`text-right text-[13px] font-semibold ${rowTone.amount}`}>
          {formatCurrency(item.amount)}
        </span>
        <div className="flex justify-end">
          <StatusBadge status={item.status} />
        </div>
      </div>
      <div className="mt-2 grid gap-1 lg:grid-cols-[1fr_auto] lg:items-center">
        <span className="text-[11px] leading-5 text-[var(--muted)]">{item.reason}</span>
        <span className="text-[10px] uppercase tracking-[0.11em] text-[var(--muted)]">
          {item.complianceCost ? `x402 ${formatCurrency(item.complianceCost)}` : item.purpose}
        </span>
      </div>
    </article>
  );
}

function MiniSparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 100;
      const y = 100 - (value / max) * 84 - 8;
      return `${x},${y}`;
    })
    .join(" ");

  const area = `0,100 ${points} 100,100`;

  return (
    <div className="terminal-panel h-[116px] px-4 py-3">
      <div className="flex items-center justify-between">
        <p className="terminal-label">Spend trace</p>
        <span className="inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-[var(--muted)]">
          <span className="status-pulse h-2 w-2 rounded-full bg-[var(--accent)]" />
          Live
        </span>
      </div>
      <div className="mt-3 h-[70px] w-full">
        <svg
          aria-hidden="true"
          className="h-full w-full"
          preserveAspectRatio="none"
          viewBox="0 0 100 100"
        >
          <defs>
            <linearGradient id="sparkFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="rgba(0,255,156,0.34)" />
              <stop offset="100%" stopColor="rgba(0,255,156,0.02)" />
            </linearGradient>
          </defs>
          <path
            d={`M ${area}`}
            fill="url(#sparkFill)"
            stroke="none"
          />
          <polyline
            fill="none"
            points={points}
            stroke="var(--accent)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2.4"
          />
        </svg>
      </div>
    </div>
  );
}

export default function Home() {
  const [policy, setPolicy] = useState<Policy>(initialPolicy);
  const [allowlistDraft, setAllowlistDraft] = useState(initialPolicy.allowlist.join("\n"));
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [isAutoRunning, setIsAutoRunning] = useState(false);
  const requestIndex = useRef(0);

  const snapshot: SpendSnapshot = useMemo(
    () => ({
      approvedSpend: activity
        .filter((item) => item.status === "approved")
        .reduce((sum, item) => sum + item.amount, 0),
      attemptedCalls: activity.length,
      blockedCalls: activity.filter((item) => item.status === "blocked").length,
    }),
    [activity],
  );

  const updatePolicyNumber = (
    key: keyof Pick<Policy, "perCallCap" | "dailySpendLimit" | "dailyCallLimit">,
  ) => {
    return (value: number) => {
      setPolicy((current) => ({
        ...current,
        [key]: Number.isFinite(value) ? Math.max(0, value) : 0,
      }));
    };
  };

  const syncAllowlist = (value: string) => {
    setAllowlistDraft(value);
    setPolicy((current) => ({
      ...current,
      allowlist: value
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean),
    }));
  };

  const settleComplianceCheck = useCallback(
    async (request: CasperPaymentRequest) => {
      const result = await runMockX402ComplianceCheck(request);

      setActivity((current) =>
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

    setActivity((current) => {
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

      return [nextItem, ...current].slice(0, 28);
    });
  }, [policy, settleComplianceCheck]);

  useEffect(() => {
    if (!isAutoRunning) {
      return;
    }

    const timer = window.setInterval(firePayment, 1650);
    return () => window.clearInterval(timer);
  }, [firePayment, isAutoRunning]);

  const checkingCount = activity.filter((item) => item.status === "checking").length;
  const approvedCount = activity.filter((item) => item.status === "approved").length;
  const latest = activity[0];
  const sparkValues = useMemo(() => {
    const recentApproved = activity
      .filter((item) => item.status === "approved")
      .slice(0, 8)
      .reverse()
      .map((item) => Math.max(item.amount, 0.15));

    return recentApproved.length
      ? [...Array(Math.max(0, 8 - recentApproved.length)).fill(0.15), ...recentApproved]
      : [0.2, 0.42, 0.26, 0.64, 0.36, 0.82, 0.48, 0.74];
  }, [activity]);

  return (
    <main className="terminal-shell min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <div className="terminal-grid-overlay pointer-events-none fixed inset-0 opacity-100" />

      <header className="relative z-10 border-b border-white/8 bg-[rgba(3,3,4,0.9)]">
        <div className="mx-auto max-w-[1680px] px-4 py-3 lg:px-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <span className="status-pulse h-2.5 w-2.5 rounded-full bg-[var(--accent)]" />
                <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--accent)]">
                  SentryAgent // Casper wallet guardrail layer
                </p>
              </div>
              <p className="mt-2 max-w-3xl text-[11px] uppercase tracking-[0.08em] text-[var(--muted)]">
                LIVE POLICY ENGINE MONITORING X402 PAYMENT ATTEMPTS, DAILY VELOCITY, AND UNKNOWN
                ENDPOINT COMPLIANCE BEFORE SPEND CLEARS.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[repeat(4,minmax(180px,1fr))]">
              <SummaryMetric
                detail="Approved outflow today"
                label="Today's spend"
                tone="accent"
                value={formatCurrency(snapshot.approvedSpend)}
              />
              <SummaryMetric
                detail={`Approved ${approvedCount} / attempted ${snapshot.attemptedCalls}`}
                label="Calls made"
                value={String(snapshot.attemptedCalls).padStart(2, "0")}
              />
              <SummaryMetric
                detail={`${checkingCount} pending compliance checks`}
                label="Calls blocked"
                tone={snapshot.blockedCalls > 0 ? "danger" : "default"}
                value={String(snapshot.blockedCalls).padStart(2, "0")}
              />
              <MiniSparkline values={sparkValues} />
            </div>
          </div>
        </div>
      </header>

      <div className="relative z-10 mx-auto flex max-w-[1680px] flex-col lg:min-h-[calc(100vh-120px)] lg:flex-row">
        <aside className="w-full border-b border-white/8 bg-[rgba(6,6,7,0.92)] lg:w-[318px] lg:flex-none lg:border-b-0 lg:border-r">
          <div className="lg:sticky lg:top-0 lg:h-[calc(100vh-120px)] lg:overflow-y-auto">
            <section className="px-4 py-4 lg:px-5">
              <div className="terminal-panel px-4 py-4">
                <div className="flex items-center justify-between">
                  <p className="terminal-label">Policy rail</p>
                  <span className="rounded-[4px] border border-[rgba(0,255,156,0.3)] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--accent)]">
                    armed
                  </span>
                </div>
                <h1 className="mt-3 text-[18px] font-semibold uppercase tracking-[0.03em] text-[var(--text)]">
                  Runtime config
                </h1>
                <p className="mt-2 text-[11px] leading-5 text-[var(--muted)]">
                  Spend thresholds, call ceilings, and trusted merchants routed through the same
                  policy engine used by the simulator stream.
                </p>
              </div>

              <div className="terminal-panel mt-3 divide-y divide-white/8 px-4 py-1">
                <RailField
                  label="Per-call cap"
                  min={0}
                  prefix="$"
                  step={0.05}
                  value={policy.perCallCap}
                  onChange={updatePolicyNumber("perCallCap")}
                />
                <RailField
                  label="Daily spend limit"
                  min={0}
                  prefix="$"
                  step={0.5}
                  value={policy.dailySpendLimit}
                  onChange={updatePolicyNumber("dailySpendLimit")}
                />
                <RailField
                  label="Daily call limit"
                  min={0}
                  step={1}
                  value={policy.dailyCallLimit}
                  onChange={updatePolicyNumber("dailyCallLimit")}
                />
              </div>

              <div className="terminal-panel mt-3 px-4 py-4">
                <div className="flex items-center justify-between">
                  <span className="terminal-label">Endpoint allowlist</span>
                  <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--muted)]">
                    {policy.allowlist.length} active
                  </span>
                </div>
                <textarea
                  className="terminal-textarea mt-3 min-h-56 w-full resize-none px-3 py-3 text-[11px] leading-6 text-[var(--text)] outline-none"
                  value={allowlistDraft}
                  onChange={(event) => syncAllowlist(event.target.value)}
                />
              </div>

              <div className="terminal-panel mt-3 px-4 py-4">
                <p className="terminal-label">Policy telemetry</p>
                <div className="mt-3 grid gap-3">
                  <div className="flex items-baseline justify-between border-b border-white/8 pb-2">
                    <span className="text-[11px] uppercase tracking-[0.1em] text-[var(--muted)]">
                      Pending checks
                    </span>
                    <span className="terminal-value text-[18px] text-[var(--warning)]">
                      {String(checkingCount).padStart(2, "0")}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between border-b border-white/8 pb-2">
                    <span className="text-[11px] uppercase tracking-[0.1em] text-[var(--muted)]">
                      Remaining budget
                    </span>
                    <span className="terminal-value text-[18px] text-[var(--accent)]">
                      {formatCurrency(Math.max(policy.dailySpendLimit - snapshot.approvedSpend, 0))}
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-[11px] uppercase tracking-[0.1em] text-[var(--muted)]">
                      Latest merchant
                    </span>
                    <span className="max-w-[150px] truncate text-[12px] text-[var(--text)]">
                      {latest ? latest.merchant : "none"}
                    </span>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </aside>

        <section className="min-w-0 flex-1 bg-[rgba(1,1,2,0.88)]">
          <div className="border-b border-white/8 px-4 py-4 lg:px-6">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
              <div className="terminal-panel px-4 py-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="terminal-label">Mock agent controls</span>
                  <span className="inline-flex items-center gap-2 rounded-[4px] border border-[rgba(0,255,156,0.24)] px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-[var(--accent)]">
                    <span className="status-pulse h-2 w-2 rounded-full bg-[var(--accent)]" />
                    {isAutoRunning ? "Looping" : "Standby"}
                  </span>
                </div>
                <p className="mt-3 text-[11px] leading-5 text-[var(--muted)]">
                  {latest
                    ? `Last request: ${latest.merchant} attempted ${formatCurrency(latest.amount)} toward ${formatShortEndpoint(latest.endpoint)}.`
                    : "Simulator idle. Trigger a payment attempt to bring the terminal online."}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <ControlButton label="Fire request" onClick={firePayment} priority="primary" />
                <ControlButton
                  active={isAutoRunning}
                  label={isAutoRunning ? "Pause loop" : "Auto loop"}
                  onClick={() => setIsAutoRunning((value) => !value)}
                />
                <ControlButton label="Clear feed" onClick={() => setActivity([])} />
              </div>
            </div>
          </div>

          <div className="px-4 py-4 lg:px-6">
            <section className="terminal-panel overflow-hidden">
              <div className="border-b border-white/8 px-4 py-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-3">
                      <p className="terminal-label">Live activity stream</p>
                      <span className="inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-[var(--accent)]">
                        <span className="status-pulse h-2.5 w-2.5 rounded-full bg-[var(--accent)]" />
                        LIVE
                        <span className="terminal-cursor text-[var(--accent)]">_</span>
                      </span>
                    </div>
                    <h2 className="mt-3 text-[18px] font-semibold uppercase tracking-[0.03em] text-[var(--text)]">
                      Transaction monitor
                    </h2>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="rounded-[4px] border border-[rgba(0,255,156,0.18)] bg-[rgba(0,255,156,0.05)] px-3 py-2 text-[10px] uppercase tracking-[0.1em] text-[var(--accent)]">
                      approved path
                    </div>
                    <div className="rounded-[4px] border border-[rgba(255,59,59,0.18)] bg-[rgba(255,59,59,0.05)] px-3 py-2 text-[10px] uppercase tracking-[0.1em] text-[var(--danger)]">
                      blocked path
                    </div>
                    <div className="rounded-[4px] border border-[rgba(255,176,32,0.18)] bg-[rgba(255,176,32,0.05)] px-3 py-2 text-[10px] uppercase tracking-[0.1em] text-[var(--warning)]">
                      compliance check
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-[86px_112px_minmax(0,1.3fr)_100px_88px] gap-3 border-b border-white/8 bg-[rgba(255,255,255,0.02)] px-4 py-3 text-[10px] uppercase tracking-[0.12em] text-[var(--muted)] max-lg:hidden">
                <span>Time</span>
                <span>Merchant</span>
                <span>Endpoint</span>
                <span className="text-right">Amount</span>
                <span className="text-right">Status</span>
              </div>

              <div className="max-h-[calc(100vh-305px)] overflow-y-auto">
                {activity.length ? (
                  activity.map((item, index) => (
                    <ActivityRow item={item} isNewest={index === 0} key={item.id} />
                  ))
                ) : (
                  <div className="flex min-h-[430px] items-center justify-center px-6 py-16">
                    <div className="max-w-xl text-center">
                      <p className="text-[12px] uppercase tracking-[0.16em] text-[var(--accent)]">
                        Awaiting traffic
                        <span className="terminal-cursor ml-2">_</span>
                      </p>
                      <p className="mt-3 text-[11px] leading-6 text-[var(--muted)]">
                        Live x402 payment attempts, policy decisions, and compliance lookups will
                        stream here as soon as the mock agent begins emitting traffic.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}
