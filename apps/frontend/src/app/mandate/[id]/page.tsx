"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";

const API_BASE = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

// ── Types ───────────────────────────────────────────────────────

type MandateStatus = "draft" | "active" | "paused" | "archived";

interface MandateData {
  id: string;
  name: string;
  status: MandateStatus;
  orgId: string;
  reserveFloorUsd: number;
  maxSingleActionUsd: number | null;
  approvedProtocols: string[];
  approvedAssets: string[];
  approvedActions: string[];
  createdAt: string;
}

interface SafeStatus {
  safeAddress: string | null;
  chainId: number;
  moduleAddress: string | null;
  moduleEnabled: boolean;
  usdcBalance: string | null;
  ausdcBalance: string | null;
  policy: {
    maxSingleActionUsdc: string;
    dailyLimitUsdc: string;
    reserveFloorUsdc: string;
  } | null;
}

interface SimulationRow {
  id: string;
  status: string;
  gasEstimate: number;
  forkBlockNumber: number;
  balancesBefore: Record<string, string>;
  balancesAfter: Record<string, string>;
  expectedDeltas: Record<string, string>;
  calldataHash: string;
  failureReason: string | null;
}

interface ExecutionRow {
  id: string;
  status: string;
  transactionHash: string | null;
  safeTxId: string | null;
  failureReason: string | null;
  submittedAt: string | null;
  executedAt: string | null;
  reconciledAt: string | null;
}

interface ActivityRow {
  id: string;
  timestamp: string;
  trigger: string;
  explanation: string;
  selectedPlaybook: string;
  playbookParams: Record<string, unknown>;
  decisionStatus: string;
  simulation: SimulationRow | null;
  execution: ExecutionRow | null;
}

// ── Helpers ─────────────────────────────────────────────────────

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
    hour12: false,
  });
}

function fmtPlaybook(key: string) {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

function fmtAmount(raw: string | number | undefined) {
  if (raw === undefined || raw === null) return "—";
  const n = Number(raw);
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}`;
  return `${n}`;
}

function formatDelta(key: string, val: string) {
  const n = Number(val);
  if (isNaN(n)) return val;
  const sign = n > 0 ? "+" : "";
  const display = Math.abs(n) >= 1e6 ? `${sign}${(n / 1e6).toFixed(6)}` : `${sign}${n}`;
  return `${display} ${key.replace(/_.*/, "")}`;
}

function explorerTxLink(txHash: string, chainId: number) {
  if (chainId === 84532)
    return `https://sepolia.basescan.org/tx/${txHash}`;
  return `https://basescan.org/tx/${txHash}`;
}

function safeTxLink(safeTxId: string, safeAddress: string, chainId: number) {
  const prefix = chainId === 84532 ? "basesep:" : "base:";
  return `https://app.safe.global/transactions/tx?safe=${prefix}${safeAddress}&id=multisig_${safeAddress}_${safeTxId}`;
}

// ── Sub-components ──────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active:     "bg-green-500/10 text-green-400 border-green-500/30",
    reconciled: "bg-green-500/10 text-green-400 border-green-500/30",
    passed:     "bg-green-500/10 text-green-400 border-green-500/30",
    executed:   "bg-blue-500/10  text-blue-400  border-blue-500/30",
    confirmed:  "bg-blue-500/10  text-blue-400  border-blue-500/30",
    ready:      "bg-blue-500/10  text-blue-400  border-blue-500/30",
    simulating: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    proposed:   "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    draft:      "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    failed:     "bg-red-500/10   text-red-400   border-red-500/30",
    paused:     "bg-orange-500/10 text-orange-400 border-orange-500/30",
    archived:   "bg-[#333]       text-[#888]    border-[#444]",
  };
  const cls = map[status] ?? "bg-[#1a1a1a] text-[#888] border-[#333]";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${cls}`}>
      {status}
    </span>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${ok ? "text-green-400" : "text-red-400"}`}>
      {ok ? "✓" : "✗"} {label}
    </span>
  );
}

function TxLink({ hash, chainId, label }: { hash: string; chainId: number; label?: string }) {
  return (
    <a
      href={explorerTxLink(hash, chainId)}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-xs text-violet-400 hover:text-violet-300 transition-colors underline underline-offset-2"
    >
      {label ?? `${hash.slice(0, 10)}…${hash.slice(-6)}`}
    </a>
  );
}

// ── Safe Status Header ──────────────────────────────────────────

function SafeStatusCard({
  safeStatus,
  loading,
}: {
  safeStatus: SafeStatus | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="bg-[#111] border border-[#222] rounded-xl p-5 animate-pulse">
        <div className="h-4 bg-[#1a1a1a] rounded w-48 mb-3" />
        <div className="h-3 bg-[#1a1a1a] rounded w-32" />
      </div>
    );
  }
  if (!safeStatus) return null;

  const { safeAddress, chainId, moduleEnabled, moduleAddress, usdcBalance, ausdcBalance, policy } = safeStatus;
  const chainLabel = chainId === 84532 ? "Base Sepolia" : chainId === 8453 ? "Base" : `Chain ${chainId}`;

  return (
    <div className="bg-[#111] border border-[#222] rounded-xl p-5 space-y-4">
      {/* Row 1: Safe address + chain */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-xs text-[#555] mb-1">Safe</div>
          {safeAddress ? (
            <a
              href={`https://app.safe.global/home?safe=${chainId === 84532 ? "basesep" : "base"}:${safeAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-sm text-white hover:text-violet-300 transition-colors"
            >
              {safeAddress.slice(0, 6)}…{safeAddress.slice(-4)}
              <span className="ml-1 text-xs text-[#555]">↗</span>
            </a>
          ) : (
            <span className="text-sm text-[#555]">Not configured</span>
          )}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="px-2 py-0.5 bg-[#1a1a1a] border border-[#333] rounded text-xs text-[#888]">
            {chainLabel}
          </span>
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
            moduleEnabled
              ? "bg-green-500/10 text-green-400 border-green-500/30"
              : "bg-[#1a1a1a] text-[#666] border-[#333]"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${moduleEnabled ? "bg-green-400" : "bg-[#555]"}`} />
            {moduleEnabled ? "Module active" : "Module inactive"}
          </span>
        </div>
      </div>

      {/* Row 2: Balances */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <div className="text-xs text-[#555] mb-1">USDC</div>
          <div className="text-lg font-semibold font-mono">
            {usdcBalance !== null ? `$${parseFloat(usdcBalance).toFixed(2)}` : <span className="text-[#555] text-sm">—</span>}
          </div>
        </div>
        <div>
          <div className="text-xs text-[#555] mb-1">aUSDC (Aave)</div>
          <div className="text-lg font-semibold font-mono text-blue-400">
            {ausdcBalance !== null ? `$${parseFloat(ausdcBalance).toFixed(6)}` : <span className="text-[#555] text-sm">—</span>}
          </div>
        </div>
        {policy && (
          <>
            <div>
              <div className="text-xs text-[#555] mb-1">Max / Action</div>
              <div className="text-base font-mono">${parseFloat(policy.maxSingleActionUsdc).toFixed(0)}</div>
            </div>
            <div>
              <div className="text-xs text-[#555] mb-1">Reserve Floor</div>
              <div className="text-base font-mono">${parseFloat(policy.reserveFloorUsdc).toFixed(0)}</div>
            </div>
          </>
        )}
      </div>

      {/* Row 3: Policy details + module address */}
      {(policy || moduleAddress) && (
        <div className="pt-3 border-t border-[#1a1a1a] flex flex-wrap gap-x-6 gap-y-2 text-xs text-[#555]">
          {policy && (
            <span>Daily cap: <span className="text-[#888]">${parseFloat(policy.dailyLimitUsdc).toFixed(0)}</span></span>
          )}
          {moduleAddress && (
            <span>
              Module:{" "}
              <a
                href={explorerTxLink(moduleAddress, chainId).replace("/tx/", "/address/")}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-violet-500 hover:text-violet-400"
              >
                {moduleAddress.slice(0, 10)}…
              </a>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Activity Card ────────────────────────────────────────────────

function ActivityCard({
  row,
  chainId,
  safeAddress,
}: {
  row: ActivityRow;
  chainId: number;
  safeAddress: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const sim  = row.simulation;
  const exec = row.execution;

  // Determine overall status
  const overallStatus = exec?.status ?? row.decisionStatus;

  // Policy checks — if we have a simulation that passed, all checks passed
  const policyPassed = sim?.status === "passed";

  const amountHuman = row.playbookParams?.["amountHuman"] as string | undefined;

  return (
    <div className="bg-[#111] border border-[#222] rounded-xl overflow-hidden">
      {/* Header row */}
      <div
        className="p-4 flex items-start justify-between gap-4 cursor-pointer hover:bg-[#141414] transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <StatusBadge status={overallStatus} />
            <span className="text-sm font-medium">{fmtPlaybook(row.selectedPlaybook)}</span>
            {amountHuman && (
              <span className="text-sm font-mono text-[#aaa]">{fmtAmount(amountHuman)}</span>
            )}
          </div>
          <div className="text-xs text-[#666] line-clamp-1">{row.explanation}</div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="text-xs text-[#555]">{fmtDate(row.timestamp)}</span>
          <span className="text-[#555] text-xs">{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-[#1a1a1a] divide-y divide-[#1a1a1a]">

          {/* Why */}
          <div className="px-4 py-3 space-y-1">
            <div className="text-xs font-medium text-[#555] uppercase tracking-wider mb-2">Why</div>
            <div className="text-sm text-[#ccc]">{row.explanation}</div>
            <div className="flex gap-3 flex-wrap mt-2">
              <span className="text-xs text-[#555]">trigger: <span className="text-[#888]">{row.trigger}</span></span>
              <span className="text-xs text-[#555]">decision: <span className="font-mono text-[#666]">{row.id}</span></span>
            </div>
          </div>

          {/* Simulation */}
          {sim ? (
            <div className="px-4 py-3 space-y-3">
              <div className="text-xs font-medium text-[#555] uppercase tracking-wider">Fork Simulation</div>

              {/* Balance deltas */}
              {sim.expectedDeltas && Object.keys(sim.expectedDeltas).length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {Object.entries(sim.expectedDeltas).map(([k, v]) => {
                    const n = Number(v);
                    const pos = n > 0;
                    return (
                      <div key={k} className="bg-[#0a0a0a] rounded-lg p-2.5">
                        <div className="text-xs text-[#555] mb-1">{k.replace(/_/g, " ")}</div>
                        <div className={`text-sm font-mono font-medium ${pos ? "text-green-400" : "text-red-400"}`}>
                          {formatDelta(k, v)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Sim metadata */}
              <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-xs text-[#555]">
                <span>block <span className="text-[#888] font-mono">{(sim.forkBlockNumber ?? 0).toLocaleString()}</span></span>
                <span>gas <span className="text-[#888] font-mono">{(sim.gasEstimate ?? 0).toLocaleString()}</span></span>
                <span>
                  calldata hash{" "}
                  <span className="font-mono text-[#666]">{sim.calldataHash.slice(0, 12)}…</span>
                </span>
              </div>

              {/* Policy checks — honest display based on sim outcome */}
              {policyPassed ? (
                <div className="flex flex-wrap gap-3">
                  <Check ok={true} label="reserve floor" />
                  <Check ok={true} label="selector guard" />
                  <Check ok={true} label="target allowlist" />
                  <Check ok={true} label="action cap" />
                </div>
              ) : sim.failureReason ? (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-red-400">Simulation failed</div>
                  <div className="text-xs text-red-300 font-mono bg-red-500/5 border border-red-500/20 rounded p-2 whitespace-pre-wrap">
                    {sim.failureReason}
                  </div>
                </div>
              ) : (
                <div className="text-xs text-[#555]">Simulation did not pass — no failure detail recorded</div>
              )}
            </div>
          ) : (
            <div className="px-4 py-3 text-xs text-[#555]">No simulation data</div>
          )}

          {/* Execution */}
          <div className="px-4 py-3 space-y-2">
            <div className="text-xs font-medium text-[#555] uppercase tracking-wider mb-2">Execution</div>
            {exec ? (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-xs text-[#555]">
                  <span>status <StatusBadge status={exec.status} /></span>
                  {exec.submittedAt && (
                    <span>submitted <span className="text-[#888]">{fmtDate(exec.submittedAt)}</span></span>
                  )}
                  {exec.reconciledAt && (
                    <span>reconciled <span className="text-[#888]">{fmtDate(exec.reconciledAt)}</span></span>
                  )}
                </div>

                {exec.transactionHash && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[#555]">tx</span>
                    <TxLink hash={exec.transactionHash} chainId={chainId} />
                  </div>
                )}

                {exec.safeTxId && safeAddress && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[#555]">safe proposal</span>
                    <a
                      href={safeTxLink(exec.safeTxId, safeAddress, chainId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs text-[#888] hover:text-[#bbb] transition-colors"
                    >
                      {exec.safeTxId.slice(0, 14)}…
                    </a>
                  </div>
                )}

                {!exec.transactionHash && !exec.safeTxId && (
                  <div className="text-xs text-[#555]">No transaction yet</div>
                )}

                {exec.failureReason && (
                  <div className="text-xs text-red-400 font-mono bg-red-500/5 border border-red-500/20 rounded p-2">
                    {exec.failureReason}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-[#555]">Not yet executed</div>
            )}
          </div>

        </div>
      )}
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────

export default function MandatePage() {
  const params = useParams();
  const mandateId = params["id"] as string;

  const [mandate,    setMandate]    = useState<MandateData | null>(null);
  const [safeStatus, setSafeStatus] = useState<SafeStatus | null>(null);
  const [activity,   setActivity]   = useState<ActivityRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [actLoading, setActLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchMandate = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/mandates/${mandateId}`);
      if (!res.ok) throw new Error(`Failed to load mandate (${res.status})`);
      const json = await res.json();
      const raw = json?.data as Record<string, unknown> & {
        versions?: Array<Record<string, unknown>>;
        activeVersionId?: string;
      };
      // Policy fields live on the active version, not the top-level mandate object.
      // Flatten them so the rest of the page can read them uniformly.
      const activeVersion =
        raw?.versions?.find((v) => v["id"] === raw.activeVersionId) ??
        raw?.versions?.[0] ??
        {};
      setMandate({
        ...raw,
        reserveFloorUsd:    activeVersion["reserveFloorUsd"]    ?? 0,
        maxSingleActionUsd: activeVersion["maxSingleActionUsd"] ?? null,
        approvedAssets:     activeVersion["approvedAssets"]     ?? [],
        approvedProtocols:  activeVersion["approvedProtocols"]  ?? [],
        approvedActions:    activeVersion["approvedActions"]    ?? [],
      } as MandateData);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [mandateId]);

  const fetchActivity = useCallback(async () => {
    setActLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/simulations/mandate/${mandateId}/activity`);
      if (!res.ok) return;
      const json = await res.json();
      setActivity(json?.data?.activity ?? []);
      setSafeStatus(json?.data?.safeStatus ?? null);
      setLastRefresh(new Date());
    } catch { /* non-fatal */ }
    finally { setActLoading(false); }
  }, [mandateId]);

  useEffect(() => {
    void fetchMandate();
    void fetchActivity();
  }, [fetchMandate, fetchActivity]);

  // Auto-refresh every 30s when mandate is active
  useEffect(() => {
    if (mandate?.status !== "active") return;
    const id = setInterval(() => void fetchActivity(), 30_000);
    return () => clearInterval(id);
  }, [mandate?.status, fetchActivity]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center">
        <div className="text-[#888] text-sm">Loading…</div>
      </div>
    );
  }

  if (fetchError || !mandate) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center">
        <div className="text-red-400 text-sm">{fetchError ?? "Mandate not found"}</div>
      </div>
    );
  }

  const chainId = safeStatus?.chainId ?? 84532;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">

        {/* ── Back + Title ─────────────────────────────────────── */}
        <div>
          <a href="/" className="text-xs text-[#555] hover:text-[#888] transition-colors mb-4 inline-block">
            ← Back
          </a>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold">{mandate.name}</h1>
              <div className="flex items-center gap-3 mt-2">
                <StatusBadge status={mandate.status} />
                <span className="text-xs text-[#555]">
                  {new Date(mandate.createdAt).toLocaleDateString("en-US", {
                    year: "numeric", month: "short", day: "numeric",
                  })}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {lastRefresh && (
                <span className="text-xs text-[#444]">
                  updated {lastRefresh.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}
                </span>
              )}
              <button
                onClick={() => void fetchActivity()}
                disabled={actLoading}
                className="px-3 py-1.5 bg-[#1a1a1a] hover:bg-[#222] disabled:opacity-40 border border-[#333] rounded-lg text-xs transition-colors"
              >
                {actLoading ? "Refreshing…" : "↻ Refresh"}
              </button>
            </div>
          </div>
        </div>

        {/* ── Safe Status Header ───────────────────────────────── */}
        <SafeStatusCard safeStatus={safeStatus} loading={actLoading && !safeStatus} />

        {/* ── Activity Feed ────────────────────────────────────── */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-[#888] uppercase tracking-wider">
              Activity
            </h2>
            <span className="text-xs text-[#444]">{activity.length} events</span>
          </div>

          {actLoading && activity.length === 0 ? (
            <div className="space-y-3">
              {[0, 1, 2].map(i => (
                <div key={i} className="bg-[#111] border border-[#222] rounded-xl p-4 animate-pulse">
                  <div className="h-4 bg-[#1a1a1a] rounded w-48 mb-2" />
                  <div className="h-3 bg-[#1a1a1a] rounded w-72" />
                </div>
              ))}
            </div>
          ) : activity.length === 0 ? (
            <div className="bg-[#111] border border-[#222] rounded-xl p-8 text-center text-[#555] text-sm">
              No activity yet. The agent will populate this once it detects a mandate opportunity.
            </div>
          ) : (
            <div className="space-y-3">
              {activity.map(row => (
                <ActivityCard
                  key={row.id}
                  row={row}
                  chainId={chainId}
                  safeAddress={safeStatus?.safeAddress ?? null}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Policy Summary ───────────────────────────────────── */}
        <div className="bg-[#111] border border-[#222] rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-[#888] uppercase tracking-wider">Policy</h2>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
            <div>
              <div className="text-xs text-[#555] mb-0.5">Reserve Floor</div>
              <div className="font-medium">${(mandate.reserveFloorUsd ?? 0).toLocaleString()}</div>
            </div>
            {mandate.maxSingleActionUsd && (
              <div>
                <div className="text-xs text-[#555] mb-0.5">Max / Action</div>
                <div className="font-medium">${(mandate.maxSingleActionUsd ?? 0).toLocaleString()}</div>
              </div>
            )}
            <div>
              <div className="text-xs text-[#555] mb-0.5">Approved Assets</div>
              <div className="font-mono text-xs text-[#aaa]">{(mandate.approvedAssets ?? []).join(", ")}</div>
            </div>
            <div>
              <div className="text-xs text-[#555] mb-0.5">Approved Protocols</div>
              <div className="flex flex-wrap gap-1.5">
                {(mandate.approvedProtocols ?? []).map(p => (
                  <span key={p} className="px-2 py-0.5 bg-[#1a1a1a] border border-[#333] rounded text-xs text-[#aaa]">{p}</span>
                ))}
              </div>
            </div>
          </div>
          <div>
            <div className="text-xs text-[#555] mb-2">Approved Actions</div>
            <div className="flex flex-wrap gap-2">
              {(mandate.approvedActions ?? []).map(a => (
                <span key={a} className="px-2 py-0.5 bg-violet-500/10 border border-violet-500/20 rounded text-xs text-violet-300">{a}</span>
              ))}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
