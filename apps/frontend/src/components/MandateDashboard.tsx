"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

const API_BASE = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

type MandateStatus = "draft" | "active" | "paused" | "archived";

interface MandateSummary {
  id: string;
  name: string;
  status: MandateStatus;
  reserveFloorUsd: number;
  riskBudgetPct: number;
  approvedProtocols: string[];
  createdAt: string;
}

function StatusBadge({ status }: { status: MandateStatus }) {
  const map: Record<MandateStatus, { bg: string; color: string; border: string }> = {
    active:   { bg: "rgba(0,200,100,0.1)", color: "#4ade80", border: "rgba(0,200,100,0.25)" },
    draft:    { bg: "rgba(255,180,0,0.1)", color: "#f5a623", border: "rgba(255,180,0,0.25)" },
    paused:   { bg: "rgba(255,120,0,0.1)", color: "#fb923c", border: "rgba(255,120,0,0.25)" },
    archived: { bg: "var(--bg-elev)",      color: "var(--text-faint)", border: "var(--border)" },
  };
  const s = map[status] ?? map.archived;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "2px 8px", borderRadius: 100, fontSize: 11, fontWeight: 500,
      background: s.bg, color: s.color, border: `1px solid ${s.border}`,
    }}>
      {status === "active" && <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.color, display: "inline-block" }} />}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

interface MandateDashboardProps {
  orgId?: string;
  onSetupMandate?: () => void;
  activeMandateId?: string | null;
}

export function MandateDashboard({ orgId, onSetupMandate, activeMandateId }: MandateDashboardProps) {
  const router = useRouter();
  const [mandates, setMandates] = useState<MandateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`${API_BASE}/api/v1/mandates/org/${orgId}`)
      .then(async res => {
        if (!res.ok) throw new Error(`Failed to load mandates (${res.status})`);
        const json = await res.json();
        if (!cancelled) setMandates((json?.data ?? []) as MandateSummary[]);
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : "Unknown error"); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [orgId]);

  if (!orgId) return null;

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {[0, 1].map(i => (
          <div key={i} style={{ height: 72, borderRadius: "var(--radius-md)", background: "var(--bg-elev)", border: "1px solid var(--border)", animation: "pulse 2s infinite" }} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: "12px 14px", border: "1px solid rgba(255,90,90,0.22)", borderRadius: "var(--radius-md)", color: "var(--neg)", background: "rgba(255,90,90,0.08)", fontSize: 13 }}>
        {error}
      </div>
    );
  }

  if (mandates.length === 0) {
    return (
      <div style={{ padding: "48px 24px", background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🤖</div>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No mandates yet</div>
        <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 20, maxWidth: 400, margin: "0 auto 20px" }}>
          Create a mandate to let the agent autonomously manage your treasury.
          Set your risk bounds once — the agent handles the rest 24/7.
        </div>
        {onSetupMandate && (
          <button className="btn btn-primary" onClick={onSetupMandate}>
            + Create First Mandate
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {mandates.map(m => {
        const isActive = m.status === "active";
        const isHighlighted = m.id === activeMandateId;
        return (
          <div
            key={m.id}
            onClick={() => router.push(`/mandate/${m.id}`)}
            role="button"
            tabIndex={0}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") router.push(`/mandate/${m.id}`); }}
            style={{
              display: "flex", alignItems: "center", gap: 16,
              padding: "16px 20px",
              background: isHighlighted ? "var(--accent-soft)" : "var(--bg-elev)",
              border: `1px solid ${isHighlighted ? "var(--accent-line)" : "var(--border)"}`,
              borderRadius: "var(--radius-md)",
              cursor: "pointer",
              transition: "background 0.15s, border-color 0.15s",
            }}
          >
            {/* Agent status indicator */}
            <div style={{
              width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
              background: isActive ? "#4ade80" : "var(--text-faint)",
              boxShadow: isActive ? "0 0 6px rgba(74,222,128,0.5)" : "none",
            }} />

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 500, fontSize: 14 }}>{m.name}</span>
                <StatusBadge status={m.status} />
                {isActive && (
                  <span style={{ fontSize: 10, color: "var(--accent)", fontFamily: "var(--font-mono)", letterSpacing: "0.06em" }}>
                    AGENT RUNNING
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--text-faint)", fontFamily: "var(--font-mono)", flexWrap: "wrap" }}>
                <span>Reserve: ${(m.reserveFloorUsd ?? 0).toLocaleString()}</span>
                <span>Risk: {m.riskBudgetPct}%</span>
                <span>
                  {(m.approvedProtocols ?? []).map(p =>
                    p.replace("aave-v3", "Aave V3").replace("morpho-blue", "Morpho").replace("uniswap-v3", "Uniswap")
                  ).join(", ")}
                </span>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
              <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
                {new Date(m.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </span>
              <span style={{ fontSize: 12, color: "var(--accent)", fontWeight: 500 }}>View →</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
