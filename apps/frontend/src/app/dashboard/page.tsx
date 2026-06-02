"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";
import { TreasuryDashboard } from "@/components/TreasuryDashboard";
import { type Org } from "@/lib/data";

const API_BASE = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

function mapOrg(apiOrg: any): Org {
  const isDao = apiOrg.type === "dao";
  const safeAddress = apiOrg.safeAddress as string | null | undefined;
  return {
    id: apiOrg.id,
    name: apiOrg.name,
    kind: isDao ? "DAO" : apiOrg.type === "individual" ? "Wallet" : "Company",
    handle: apiOrg.id.replace(/^org_/, ""),
    avatar: {
      bg: isDao ? "#6B8AFF" : apiOrg.type === "individual" ? "#6EE7A8" : "#FFB547",
      letter: apiOrg.name.slice(0, 1).toUpperCase(),
    },
    treasuryUsd: 0,
    managedUsd: 0,
    idleUsd: 0,
    governanceThreshold: safeAddress ? "Safe approval" : "Wallet approval",
    riskCeiling: apiOrg.riskParams?.maxDrawdownPct ?? 10,
    maxAllocPerProtocol: apiOrg.riskParams?.maxAllocationPerProtocolPct ?? 40,
    benchmarkApy: (apiOrg.feeConfig?.benchmarkRateBps ?? 530) / 100,
    currentApy: 0,
  };
}

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const orgId = searchParams.get("orgId");
  const [org, setOrg] = useState<Org | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId) {
      setError("Dashboard requires an orgId query parameter.");
      return;
    }
    let active = true;

    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/treasury/orgs/${orgId}`);
        const json = await res.json();
        if (!res.ok || !json.success || !json.data) {
          throw new Error(json?.error ?? `Organization request failed with ${res.status}`);
        }
        if (active && json.success && json.data) {
          setOrg(mapOrg(json.data));
          setError(null);
        }
      } catch (err) {
        if (active) {
          setOrg(null);
          setError(err instanceof Error ? err.message : "Failed to load organization.");
        }
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, [orgId]);

  if (!org) {
    return (
      <div className="page fade-in">
        <div className="card card-pad" style={{ color: error ? "var(--neg)" : "var(--text-dim)", fontSize: 13 }}>
          {error ?? "Loading organization..."}
        </div>
      </div>
    );
  }

  return (
    <TreasuryDashboard
      org={org}
      onCompose={() => router.push("/")}
    />
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={
      <div className="page fade-in">
        <div className="card card-pad" style={{ color: "var(--text-dim)", fontSize: 13 }}>
          Loading dashboard...
        </div>
      </div>
    }>
      <DashboardContent />
    </Suspense>
  );
}
