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
  const styles: Record<MandateStatus, string> = {
    draft: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
    active: "bg-green-500/10 text-green-400 border-green-500/30",
    paused: "bg-orange-500/10 text-orange-400 border-orange-500/30",
    archived: "bg-[#1a1a1a] text-[#888] border-[#333]",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${styles[status]}`}
    >
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

interface MandateDashboardProps {
  orgId?: string;
}

export function MandateDashboard({ orgId }: MandateDashboardProps) {
  const router = useRouter();
  const [mandates, setMandates] = useState<MandateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(`${API_BASE}/api/v1/mandates/org/${orgId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load mandates (${res.status})`);
        const json = await res.json();
        if (!cancelled) {
          setMandates((json?.data ?? []) as MandateSummary[]);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Unknown error");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [orgId]);

  return (
    <div className="page fade-in">
      <div className="flex items-start justify-between mb-8">
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--text-faint)",
              marginBottom: 6,
            }}
          >
            Mandates
          </div>
          <h2
            style={{
              fontSize: "clamp(20px, 2.2vw, 28px)",
              fontWeight: 700,
              color: "var(--text)",
              margin: 0,
            }}
          >
            Treasury Mandates
          </h2>
          <div
            style={{
              marginTop: 6,
              fontSize: 13,
              color: "var(--text-dim)",
            }}
          >
            Risk policies and spending rules for autonomous execution.
          </div>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => router.push("/onboarding")}
          style={{ flexShrink: 0 }}
        >
          + Create Mandate
        </button>
      </div>

      {!orgId && (
        <div
          className="card card-pad"
          style={{
            textAlign: "center",
            padding: "48px 24px",
            color: "var(--text-dim)",
          }}
        >
          <div style={{ fontSize: 14, marginBottom: 12 }}>
            No organization selected.
          </div>
          <button
            className="btn btn-primary"
            onClick={() => router.push("/onboarding")}
          >
            Set up your organization
          </button>
        </div>
      )}

      {orgId && loading && (
        <div
          style={{ color: "var(--text-faint)", fontSize: 13, textAlign: "center", padding: "48px 0" }}
        >
          Loading mandates…
        </div>
      )}

      {orgId && error && (
        <div
          style={{
            padding: "12px 14px",
            border: "1px solid rgba(255,90,90,0.22)",
            borderRadius: "var(--radius-md)",
            color: "var(--neg)",
            background: "rgba(255,90,90,0.08)",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {orgId && !loading && !error && mandates.length === 0 && (
        <div
          className="card card-pad"
          style={{
            textAlign: "center",
            padding: "48px 24px",
            color: "var(--text-dim)",
          }}
        >
          <div style={{ fontSize: 14, marginBottom: 12 }}>
            No mandates yet for this organization.
          </div>
          <button
            className="btn btn-primary"
            onClick={() => router.push("/onboarding")}
          >
            Create your first mandate
          </button>
        </div>
      )}

      {orgId && !loading && mandates.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {mandates.map((m) => (
            <div
              key={m.id}
              className="card card-pad"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                cursor: "pointer",
              }}
              onClick={() => router.push(`/mandate/${m.id}`)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  router.push(`/mandate/${m.id}`);
                }
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 4,
                  }}
                >
                  <span style={{ fontWeight: 500, fontSize: 14 }}>{m.name}</span>
                  <StatusBadge status={m.status} />
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: 16,
                    fontSize: 12,
                    color: "var(--text-faint)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <span>Reserve: ${(m.reserveFloorUsd ?? 0).toLocaleString()}</span>
                  <span>Risk: {m.riskBudgetPct}%</span>
                  <span>
                    Protocols: {(m.approvedProtocols ?? []).slice(0, 3).join(", ")}
                    {(m.approvedProtocols ?? []).length > 3
                      ? ` +${(m.approvedProtocols ?? []).length - 3}`
                      : ""}
                  </span>
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-faint)", flexShrink: 0 }}>
                {new Date(m.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </div>
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                style={{ color: "var(--text-faint)", flexShrink: 0 }}
              >
                <path
                  d="M5 3l4 4-4 4"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
