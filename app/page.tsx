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

function SummaryStat({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="border-l border-white/10 pl-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--muted)]">
        {label}
      </p>
      <p className="mt-1 font-mono text-lg font-semibold text-[var(--text)]">{value}</p>
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
    <label className="grid gap-2 py-4">
      <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--muted)]">
        {label}
      </span>
      <div className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.02] px-3 py-2">
        {prefix ? (
          <span className="font-mono text-sm font-semibold text-[var(--muted)]">{prefix}</span>
        ) : null}
        <input
          className="w-full bg-transparent font-mono text-2xl font-semibold text-[var(--text)] outline-none"
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
}: {
  active?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`rounded-md border px-3 py-2 font-mono text-xs uppercase tracking-[0.18em] transition-colors ${
        active
          ? "border-[var(--accent)] bg-[rgba(0,255,156,0.08)] text-[var(--accent)]"
          : "border-white/14 bg-transparent text-[var(--text)] hover:border-white/28 hover:bg-white/[0.03]"
      }`}
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
      ? "border-[rgba(0,255,156,0.3)] text-[var(--accent)]"
      : status === "blocked"
        ? "border-[rgba(255,77,77,0.35)] text-[var(--danger)]"
        : "border-white/12 text-[var(--muted)]";

  return (
    <span
      className={`inline-flex w-fit items-center rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] ${badgeStyles}`}
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
      ? "border-l-[var(--danger)]"
      : item.status === "approved"
        ? "border-l-[var(--accent)]"
        : "border-l-transparent";

  return (
    <article
      className={`border-b border-white/6 border-l-2 px-4 py-3 ${rowTone} ${isNewest ? "stream-row" : ""}`}
    >
      <div className="grid gap-2 lg:grid-cols-[88px_120px_minmax(0,1fr)_110px_auto] lg:items-center lg:gap-4">
        <span className="font-mono text-xs text-[var(--muted)]">{formatTime(item.requestedAt)}</span>
        <span className="truncate font-mono text-xs uppercase tracking-[0.12em] text-[var(--text)]">
          {item.merchant}
        </span>
        <span className="truncate font-mono text-sm text-[var(--text)]">{item.endpoint}</span>
        <span className="font-mono text-sm font-semibold text-[var(--text)]">
          {formatCurrency(item.amount)}
        </span>
        <StatusBadge status={item.status} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="font-sans text-[var(--muted)]">{item.reason}</span>
        <span className="font-mono uppercase tracking-[0.16em] text-[var(--muted)]">
          {item.complianceCost ? `x402 ${formatCurrency(item.complianceCost)}` : item.purpose}
        </span>
      </div>
    </article>
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
  const latest = activity[0];

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <header className="border-b border-white/8 bg-[rgba(10,10,12,0.88)] backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-5 px-4 py-4 lg:flex-row lg:items-center lg:justify-between lg:px-6">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="status-pulse h-2.5 w-2.5 rounded-full bg-[var(--accent)]" />
              <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-[var(--text)]">
                SentryAgent / Spend Policy Monitor
              </p>
            </div>
            <p className="mt-2 max-w-2xl font-mono text-xs text-[var(--muted)]">
              Guardrail layer evaluating autonomous x402 wallet requests before Casper spend clears.
            </p>
          </div>

          <div className="flex flex-wrap gap-5 lg:justify-end">
            <SummaryStat label="Today's spend" value={formatCurrency(snapshot.approvedSpend)} />
            <SummaryStat label="Calls made" value={String(snapshot.attemptedCalls)} />
            <SummaryStat label="Calls blocked" value={String(snapshot.blockedCalls)} />
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1600px] flex-col lg:min-h-[calc(100vh-89px)] lg:flex-row">
        <aside className="w-full border-b border-white/8 lg:w-[312px] lg:flex-none lg:border-b-0 lg:border-r lg:border-white/8">
          <div className="lg:sticky lg:top-0 lg:h-[calc(100vh-89px)] lg:overflow-y-auto">
            <section className="px-4 py-5 lg:px-5">
              <div className="border-b border-white/8 pb-4">
                <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--muted)]">
                  Policy rail
                </p>
                <h1 className="mt-2 font-mono text-lg font-semibold text-[var(--text)]">
                  Runtime config
                </h1>
                <p className="mt-2 font-sans text-sm text-[var(--muted)]">
                  Adjust spend thresholds and endpoint trust rules without touching the simulator.
                </p>
              </div>

              <div className="divide-y divide-white/8">
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

              <div className="mt-2 border-t border-white/8 pt-5">
                <label className="block">
                  <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--muted)]">
                    Endpoint allowlist
                  </span>
                  <textarea
                    className="mt-3 min-h-56 w-full resize-none rounded-md border border-white/10 bg-white/[0.02] px-3 py-3 font-mono text-xs leading-6 text-[var(--text)] outline-none transition-colors focus:border-[var(--accent)]"
                    value={allowlistDraft}
                    onChange={(event) => syncAllowlist(event.target.value)}
                  />
                </label>
              </div>

              <div className="mt-5 border-t border-white/8 pt-5">
                <div className="grid gap-3">
                  <div className="flex items-center justify-between font-mono text-xs uppercase tracking-[0.18em]">
                    <span className="text-[var(--muted)]">Pending checks</span>
                    <span className="text-[var(--text)]">{checkingCount}</span>
                  </div>
                  <div className="flex items-center justify-between font-mono text-xs uppercase tracking-[0.18em]">
                    <span className="text-[var(--muted)]">Remaining budget</span>
                    <span className="text-[var(--text)]">
                      {formatCurrency(Math.max(policy.dailySpendLimit - snapshot.approvedSpend, 0))}
                    </span>
                  </div>
                  <div className="flex items-center justify-between font-mono text-xs uppercase tracking-[0.18em]">
                    <span className="text-[var(--muted)]">Latest merchant</span>
                    <span className="max-w-[150px] truncate text-[var(--text)]">
                      {latest ? latest.merchant : "none"}
                    </span>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          <div className="border-b border-white/8 px-4 py-4 lg:px-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--muted)]">
                  Mock agent controls
                </p>
                <p className="mt-2 font-sans text-sm text-[var(--muted)]">
                  {latest
                    ? `Last request: ${latest.merchant} attempted ${formatCurrency(latest.amount)}.`
                    : "Simulator idle. Trigger a payment attempt to start the live stream."}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <ControlButton label="Fire request" onClick={firePayment} />
                <ControlButton
                  active={isAutoRunning}
                  label={isAutoRunning ? "Pause loop" : "Auto loop"}
                  onClick={() => setIsAutoRunning((value) => !value)}
                />
                <ControlButton label="Clear feed" onClick={() => setActivity([])} />
              </div>
            </div>
          </div>

          <div className="px-4 py-5 lg:px-6">
            <section className="overflow-hidden rounded-lg border border-white/8 bg-[var(--surface)]">
              <div className="flex flex-col gap-3 border-b border-white/8 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[var(--muted)]">
                    Live activity stream
                  </p>
                  <h2 className="mt-2 font-mono text-lg font-semibold text-[var(--text)]">
                    Transaction monitor
                  </h2>
                </div>
                <div className="flex flex-wrap gap-3 text-xs">
                  <span className="inline-flex items-center gap-2 rounded-md border border-white/8 px-3 py-2 font-mono uppercase tracking-[0.16em] text-[var(--muted)]">
                    <span className="h-2 w-2 rounded-full bg-[var(--accent)]" />
                    approved
                  </span>
                  <span className="inline-flex items-center gap-2 rounded-md border border-white/8 px-3 py-2 font-mono uppercase tracking-[0.16em] text-[var(--muted)]">
                    <span className="h-2 w-2 rounded-full bg-[var(--danger)]" />
                    blocked
                  </span>
                  <span className="inline-flex items-center gap-2 rounded-md border border-white/8 px-3 py-2 font-mono uppercase tracking-[0.16em] text-[var(--muted)]">
                    <span className="h-2 w-2 rounded-full bg-white/30" />
                    checking
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-[88px_120px_minmax(0,1fr)_110px_auto] gap-4 border-b border-white/8 px-4 py-3 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--muted)] max-lg:hidden">
                <span>Time</span>
                <span>Merchant</span>
                <span>Endpoint</span>
                <span>Amount</span>
                <span>Status</span>
              </div>

              <div className="max-h-[calc(100vh-250px)] overflow-y-auto">
                {activity.length ? (
                  activity.map((item, index) => (
                    <ActivityRow item={item} isNewest={index === 0} key={item.id} />
                  ))
                ) : (
                  <div className="flex min-h-[360px] items-center justify-center px-6 py-16">
                    <div className="max-w-xl text-center">
                      <p className="font-mono text-sm uppercase tracking-[0.22em] text-[var(--muted)]">
                        Awaiting traffic
                      </p>
                      <p className="mt-3 font-sans text-sm leading-7 text-[var(--muted)]">
                        The stream will populate with simulated x402 payment attempts, policy
                        decisions, and follow-up compliance checks as soon as the agent starts.
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
