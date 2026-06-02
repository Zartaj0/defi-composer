"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  TreasurySnapshot,
  Alert,
  PortfolioPerformance,
} from "@defi-composer/shared";

const API_BASE = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `API ${res.status}: ${path}`);
  return json.data as T;
}

export function useTreasurySnapshot(orgId: string) {
  const [snapshot, setSnapshot] = useState<TreasurySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<TreasurySnapshot>(`/api/v1/treasury/${orgId}/snapshot`);
      setSnapshot(data);
      setError(null);
    } catch (err) {
      setSnapshot(null);
      setError(err instanceof Error ? err.message : "API unreachable");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 60_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { snapshot, loading, error, refresh };
}

export function useTreasuryAlerts(orgId: string, unacknowledgedOnly = false) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<Alert[]>(
        `/api/v1/treasury/${orgId}/alerts?unacknowledgedOnly=${unacknowledgedOnly}`
      );
      setAlerts(data);
      setError(null);
    } catch (err) {
      setAlerts([]);
      setError(err instanceof Error ? err.message : "API unreachable");
    } finally {
      setLoading(false);
    }
  }, [orgId, unacknowledgedOnly]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { alerts, loading, error, refresh };
}

export function usePortfolioPerformance(orgId: string) {
  const [performance, setPerformance] = useState<PortfolioPerformance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<PortfolioPerformance>(`/api/v1/treasury/${orgId}/performance`);
      setPerformance(data);
      setError(null);
    } catch (err) {
      setPerformance(null);
      setError(err instanceof Error ? err.message : "Performance endpoint unavailable");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { performance, loading, error, refresh };
}
