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

const statusStyles: Record<ActivityStatus, string> = {
  approved: "border-line bg-ink text-white",
  blocked: "border-line bg-accent text-ink",
  checking: "border-line bg-panel text-ink",
};

const statusLabels: Record<ActivityStatus, string> = {
  approved: "APPROVED",
  blocked: "BLOCKED",
  checking: "CHECKING",
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
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <section className="rounded-[18px] border border-line bg-panel p-5 shadow-hard">
      <p className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-ink/60">
        {label}
      </p>
      <p className="mt-3 text-4xl font-black leading-none text-ink">{value}</p>
      <p className="mt-3 text-sm font-semibold text-ink/65">{hint}</p>
    </section>
  );
}

function PolicyField({
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
    <label className="block rounded-2xl border border-line bg-white p-4 shadow-soft">
      <span className="font-mono text-[10px] font-black uppercase tracking-[0.18em] text-ink/55">
        {label}
      </span>
      <span className="mt-3 flex items-center gap-2">
        {prefix ? <span className="text-xl font-black">{prefix}</span> : null}
        <input
          className="w-full bg-transparent text-3xl font-black leading-none outline-none"
          min={min}
          step={step}
          type="number"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </span>
    </label>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  return (
    <article className="rounded-[18px] border border-line bg-white p-4 shadow-soft transition-transform duration-200 hover:-translate-y-0.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-lg font-black leading-tight">{item.merchant}</p>
            <span
              className={`rounded-full border px-3 py-1 font-mono text-[10px] font-black tracking-[0.16em] ${statusStyles[item.status]}`}
            >
              {statusLabels[item.status]}
            </span>
          </div>
          <p className="mt-1 max-w-2xl break-all text-sm font-semibold text-ink/65">
            {item.endpoint}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-black">{formatCurrency(item.amount)}</p>
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-ink/50">
            {formatTime(item.requestedAt)}
          </p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 border-t border-line/15 pt-4 md:grid-cols-[1fr_auto] md:items-end">
        <p className="text-sm font-bold leading-6 text-ink/75">{item.reason}</p>
        <p className="font-mono text-[10px] font-black uppercase tracking-[0.16em] text-ink/45">
          {item.complianceCost ? `x402 check ${formatCurrency(item.complianceCost)}` : item.purpose}
        </p>
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

  const updatePolicyNumber = (key: keyof Pick<Policy, "perCallCap" | "dailySpendLimit" | "dailyCallLimit">) => {
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

  const settleComplianceCheck = useCallback(async (request: CasperPaymentRequest) => {
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
  }, [policy.dailySpendLimit]);

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
    <main className="min-h-screen px-5 py-6 text-ink sm:px-8 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <header className="grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_420px] lg:items-center">
          <div>
            <p className="font-mono text-xs font-black uppercase tracking-[0.2em] text-ink/55">
              SENTRYAGENT / CASPER AGENTIC BUILDATHON 2026
            </p>
            <h1 className="mt-5 max-w-[10ch] text-[3.35rem] font-black leading-[0.9] text-ink sm:text-[4.4rem] lg:text-[5.4rem]">
              Spend guardrails for
              <span className="mt-3 inline-block rounded-[22px] bg-accent px-4 py-2 text-ink">
                autonomous wallets
              </span>
              .
            </h1>
            <p className="mt-6 max-w-xl text-lg font-semibold leading-8 text-ink/70">
              A policy layer between an AI agent and its Casper wallet, evaluating every x402
              payment before funds move.
            </p>
          </div>

          <div className="rounded-[20px] border border-line bg-panel p-5 shadow-hard lg:justify-self-end lg:w-full">
            <p className="font-mono text-[11px] font-black uppercase tracking-[0.18em] text-ink/55">
              MOCK AGENT / LIVE PAYMENT REQUESTS
            </p>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row">
              <button
                className="rounded-full border border-line bg-ink px-6 py-3 text-sm font-black uppercase tracking-[0.08em] text-white shadow-hard transition-transform hover:-translate-y-0.5"
                type="button"
                onClick={firePayment}
              >
                Fire request
              </button>
              <button
                className={`rounded-full border border-line px-6 py-3 text-sm font-black uppercase tracking-[0.08em] shadow-hard transition-transform hover:-translate-y-0.5 ${
                  isAutoRunning ? "bg-accent text-ink" : "bg-white text-ink"
                }`}
                type="button"
                onClick={() => setIsAutoRunning((value) => !value)}
              >
                {isAutoRunning ? "Pause loop" : "Auto-loop"}
              </button>
            </div>
            <p className="mt-4 text-sm font-bold leading-6 text-ink/65">
              {latest
                ? `Latest: ${latest.merchant} requested ${formatCurrency(latest.amount)}.`
                : "Ready to generate simulated x402 payment attempts."}
            </p>
          </div>
        </header>

        <section className="mt-8 grid gap-4 md:grid-cols-3">
          <MetricCard
            label="Today's Spend"
            value={formatCurrency(snapshot.approvedSpend)}
            hint={`${formatCurrency(Math.max(policy.dailySpendLimit - snapshot.approvedSpend, 0))} remaining`}
          />
          <MetricCard
            label="Calls Made"
            value={String(snapshot.attemptedCalls)}
            hint={`${Math.max(policy.dailyCallLimit - snapshot.attemptedCalls, 0)} calls left in policy`}
          />
          <MetricCard
            label="Calls Blocked"
            value={String(snapshot.blockedCalls)}
            hint={checkingCount ? `${checkingCount} pending compliance check` : "No pending checks"}
          />
        </section>

        <section className="mt-8 grid gap-6 lg:grid-cols-[420px_1fr]">
          <aside className="space-y-5">
            <div className="rounded-[20px] border border-line bg-panel p-5 shadow-hard">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-mono text-[11px] font-black uppercase tracking-[0.18em] text-ink/55">
                    POLICY PANEL / EDITABLE RULES
                  </p>
                  <h2 className="mt-3 text-3xl font-black leading-none">Spend policy</h2>
                </div>
                <span className="rounded-full border border-line bg-accent px-3 py-1 font-mono text-[10px] font-black uppercase tracking-[0.14em]">
                  Local
                </span>
              </div>

              <div className="mt-5 grid gap-4">
                <PolicyField
                  label="Per-call cap"
                  min={0}
                  prefix="$"
                  step={0.05}
                  value={policy.perCallCap}
                  onChange={updatePolicyNumber("perCallCap")}
                />
                <PolicyField
                  label="Daily spend limit"
                  min={0}
                  prefix="$"
                  step={0.5}
                  value={policy.dailySpendLimit}
                  onChange={updatePolicyNumber("dailySpendLimit")}
                />
                <PolicyField
                  label="Daily call limit"
                  min={0}
                  step={1}
                  value={policy.dailyCallLimit}
                  onChange={updatePolicyNumber("dailyCallLimit")}
                />
              </div>
            </div>

            <div className="rounded-[20px] border border-line bg-panel p-5 shadow-hard">
              <label className="block">
                <span className="font-mono text-[11px] font-black uppercase tracking-[0.18em] text-ink/55">
                  MERCHANT ALLOWLIST / ONE PREFIX PER LINE
                </span>
                <textarea
                  className="mt-4 min-h-48 w-full resize-none rounded-2xl border border-line bg-white p-4 font-mono text-xs font-bold leading-6 text-ink outline-none shadow-soft focus:ring-4 focus:ring-accent/25"
                  value={allowlistDraft}
                  onChange={(event) => syncAllowlist(event.target.value)}
                />
              </label>
            </div>
          </aside>

          <section className="rounded-[20px] border border-line bg-panel p-5 shadow-hard">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="font-mono text-[11px] font-black uppercase tracking-[0.18em] text-ink/55">
                  LIVE ACTIVITY / REAL-TIME
                </p>
                <h2 className="mt-3 text-3xl font-black leading-none">Attempted payments</h2>
              </div>
              <button
                className="rounded-full border border-line bg-white px-5 py-2.5 text-xs font-black uppercase tracking-[0.1em] shadow-hard transition-transform hover:-translate-y-0.5"
                type="button"
                onClick={() => setActivity([])}
              >
                Clear feed
              </button>
            </div>

            <div className="mt-5 max-h-[660px] space-y-4 overflow-y-auto pr-1">
              {activity.length ? (
                activity.map((item) => <ActivityRow item={item} key={item.id} />)
              ) : (
                <div className="grid min-h-80 place-items-center rounded-[18px] border border-dashed border-line bg-white p-8 text-center shadow-soft">
                  <div>
                    <p className="text-3xl font-black leading-tight">No payments yet.</p>
                    <p className="mt-3 max-w-md text-sm font-bold leading-6 text-ink/65">
                      Start the mock agent to watch allowed merchants pass, risky endpoints get
                      checked, and policy violations block before spend.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
