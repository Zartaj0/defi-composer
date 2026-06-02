'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { type Org } from '@/lib/data';
import { fmtUsd, fmtPct } from '@/lib/utils';
import { useWalletBalances } from '@/lib/useWalletBalances';
import { IconBell, IconBolt, IconRefresh, IconShield } from '@/lib/icons';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface ApiPosition {
  id: string;
  graph: { name: string; nodes: { protocol: string }[] };
  status: string;
  entryValueUsd?: number;
  currentValueUsd?: number;
  yieldEarnedUsd?: number;
}

interface ApiAlert {
  id: string;
  title: string;
  message?: string;
  severity: string;
  createdAt: string;
}

interface ApiSnapshot {
  totalAumUsd: number;
  managedAumUsd: number;
  idleAumUsd?: number;
  totalYieldEarned24hUsd: number;
  projectedAnnualYieldUsd: number;
  weightedAvgApyBps: number;
  activePositions: ApiPosition[];
  protocolAllocations: { protocol: string; allocationUsd: number; apyBps: number }[];
  portfolioHealthScore?: number;
}

interface TreasuryDashboardProps {
  org: Org;
  safeAddress?: string;
  onCompose: () => void;
}

type DashTab = 'overview' | 'positions' | 'alerts';

function ExitButton({ positionId, initiatedBy, onDone }: { positionId: string; initiatedBy: string; onDone: () => void }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [errMsg, setErrMsg] = useState('');

  const handleExit = async () => {
    setState('loading');
    try {
      const res = await fetch(`${API_BASE}/api/v1/positions/${positionId}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'user_initiated', initiatedBy }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) throw new Error(json?.error ?? `Failed (${res.status})`);
      setState('done');
      setTimeout(onDone, 1500);
    } catch (e) {
      setErrMsg(e instanceof Error ? e.message : 'Unknown error');
      setState('error');
      setTimeout(() => setState('idle'), 3000);
    }
  };

  if (state === 'done') return <span style={{ color: 'var(--pos)', fontSize: 12 }}>✓ Closing…</span>;
  if (state === 'error') return <span style={{ color: 'var(--neg)', fontSize: 11 }}>{errMsg}</span>;

  return (
    <button
      className="btn btn-sm"
      style={{ color: 'var(--neg)', borderColor: 'rgba(255,90,90,0.3)', background: 'rgba(255,90,90,0.07)' }}
      onClick={handleExit}
      disabled={state === 'loading'}
    >
      {state === 'loading' ? 'Exiting…' : 'Exit Position'}
    </button>
  );
}

export function TreasuryDashboard({ org, safeAddress: _safeAddress, onCompose }: TreasuryDashboardProps) {
  const { address, isConnected } = useAccount();
  const { ethBalance, usdcBalance, ethSymbol, isLoading: balLoading, chainId } = useWalletBalances(address);

  const [tab, setTab] = useState<DashTab>('overview');
  const [snapshot, setSnapshot] = useState<ApiSnapshot | null>(null);
  const [alerts, setAlerts] = useState<ApiAlert[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [snapshotRes, alertsRes] = await Promise.all([
        fetch(`${API_BASE}/api/v1/treasury/${org.id}/snapshot`),
        fetch(`${API_BASE}/api/v1/treasury/${org.id}/alerts?limit=25`),
      ]);
      const snapshotJson = await snapshotRes.json().catch(() => null);
      const alertsJson = await alertsRes.json().catch(() => null);

      if (!snapshotRes.ok || !snapshotJson?.success) {
        throw new Error(snapshotJson?.error ?? `Snapshot request failed with ${snapshotRes.status}`);
      }

      setSnapshot(snapshotJson.data as ApiSnapshot);
      setAlerts(alertsRes.ok && alertsJson?.success && Array.isArray(alertsJson.data) ? alertsJson.data : []);
    } catch (err) {
      setSnapshot(null);
      setAlerts([]);
      setError(err instanceof Error ? err.message : 'Treasury data unavailable.');
    } finally {
      setLoading(false);
    }
  }, [org.id]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => { void refresh(); }, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const totalAum = snapshot?.totalAumUsd ?? 0;
  const managedAum = snapshot?.managedAumUsd ?? 0;
  const idleAum = snapshot?.idleAumUsd ?? Math.max(totalAum - managedAum, 0);
  const utilizationPct = totalAum > 0 ? (managedAum / totalAum) * 100 : 0;
  const avgApy = (snapshot?.weightedAvgApyBps ?? 0) / 100;
  const healthScore = snapshot?.portfolioHealthScore;

  return (
    <div className="page fade-in">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 6 }}>Treasury Dashboard</div>
          <h2 className="h2">{org.name}</h2>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading}>
            <IconRefresh size={13} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button className="btn btn-primary" onClick={onCompose}>
            <IconBolt size={13} />
            Compose Strategy
          </button>
        </div>
      </div>

      {/* ── Connected Wallet Balances ─────────────────────────────────────── */}
      {isConnected && (
        <div style={{ marginBottom: 20 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Connected Wallet — On-chain</div>
          <div className="kpi-row">
            <div className="stat">
              <div className="lbl">ETH Balance</div>
              <div className="val">{balLoading ? '…' : ethBalance.toFixed(4)}</div>
              <div className="sub">{ethSymbol} · chain {chainId}</div>
            </div>
            <div className="stat">
              <div className="lbl">USDC Balance</div>
              <div className="val" style={{ color: usdcBalance > 0 ? 'var(--pos)' : 'var(--text-faint)' }}>
                {balLoading ? '…' : usdcBalance > 0 ? fmtUsd(usdcBalance, { compact: true }) : '—'}
              </div>
              <div className="sub">
                {address?.slice(0, 6)}…{address?.slice(-4)}
              </div>
            </div>
            {usdcBalance > 0 && (
              <div className="stat">
                <div className="lbl">Available to Deploy</div>
                <div className="val" style={{ color: 'var(--accent)' }}>
                  {fmtUsd(usdcBalance, { compact: true })}
                </div>
                <div className="sub">
                  <button
                    className="btn btn-sm btn-primary"
                    style={{ marginTop: 2 }}
                    onClick={onCompose}
                  >
                    Compose Strategy →
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {!isConnected && (
        <div className="card card-pad" style={{ marginBottom: 20, color: 'var(--text-dim)', fontSize: 13 }}>
          Connect your wallet in the nav bar to see live on-chain balances.
        </div>
      )}

      {/* ── Backend Treasury State ─────────────────────────────────────────── */}
      <div className="eyebrow" style={{ marginBottom: 8 }}>Backend-tracked positions</div>

      {error && (
        <div style={{ background: 'rgba(255,90,90,0.08)', border: '1px solid rgba(255,90,90,0.22)', borderRadius: 'var(--radius-md)', padding: 14, marginBottom: 18, color: 'var(--neg)', fontSize: 13 }}>
          {error}
        </div>
      )}

      {!error && !snapshot && (
        <div className="card card-pad" style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          {loading ? 'Loading live treasury state…' : 'No treasury snapshot returned by the backend.'}
        </div>
      )}

      {snapshot && (
        <>
          <div className="kpi-row" style={{ marginBottom: 20 }}>
            <div className="stat">
              <div className="lbl">Deployed AUM</div>
              <div className="val">{fmtUsd(totalAum, { compact: true })}</div>
              <div className="sub">live snapshot</div>
            </div>
            <div className="stat">
              <div className="lbl">Managed</div>
              <div className="val">{fmtUsd(managedAum, { compact: true })}</div>
              <div className="sub">{fmtPct(utilizationPct, 0)} utilization</div>
            </div>
            <div className="stat">
              <div className="lbl">Idle (backend)</div>
              <div className="val" style={{ color: idleAum > 0 ? 'var(--warn)' : 'var(--text)' }}>
                {fmtUsd(idleAum, { compact: true })}
              </div>
              <div className="sub">available for mandate decisions</div>
            </div>
            <div className="stat">
              <div className="lbl">Avg APY</div>
              <div className="val" style={{ color: 'var(--pos)' }}>{fmtPct(avgApy, 1)}</div>
              <div className="sub">weighted by deployed capital</div>
            </div>
            <div className="stat">
              <div className="lbl">24h Yield</div>
              <div className="val" style={{ color: 'var(--pos)' }}>+{fmtUsd(snapshot.totalYieldEarned24hUsd)}</div>
              <div className="sub">{fmtUsd(snapshot.projectedAnnualYieldUsd, { compact: true })}/year projected</div>
            </div>
          </div>

          <div className="tabs">
            {(['overview', 'positions', 'alerts'] as DashTab[]).map(t => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
                {t === 'alerts' && alerts.length > 0 && <span className="badge">{alerts.length}</span>}
                {t === 'positions' && snapshot.activePositions.length > 0 && (
                  <span className="badge">{snapshot.activePositions.length}</span>
                )}
              </button>
            ))}
          </div>

          {tab === 'overview' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 16 }}>
              <div className="card">
                <div style={{ padding: 'var(--tile-pad)', borderBottom: '1px solid var(--border)', fontWeight: 500, fontSize: 14 }}>
                  Protocol Allocation
                </div>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Protocol</th>
                      <th className="num">Allocation</th>
                      <th className="num">APY</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.protocolAllocations.length > 0 ? snapshot.protocolAllocations.map(item => (
                      <tr key={item.protocol}>
                        <td>{item.protocol}</td>
                        <td className="num">{fmtUsd(item.allocationUsd, { compact: true })}</td>
                        <td className="num" style={{ color: 'var(--pos)' }}>{fmtPct(item.apyBps / 100, 2)}</td>
                      </tr>
                    )) : (
                      <tr><td colSpan={3} className="muted">No deployed protocol allocations.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="card card-pad">
                <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <IconShield size={14} style={{ color: 'var(--accent)' }} />
                  Risk Status
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                  <span className="muted">Portfolio Health</span>
                  <span className="mono">{healthScore ?? 'unavailable'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                  <span className="muted">Positions</span>
                  <span className="mono">{snapshot.activePositions.length}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', fontSize: 12 }}>
                  <span className="muted">Alerts</span>
                  <span className="mono">{alerts.length}</span>
                </div>
              </div>
            </div>
          )}

          {tab === 'positions' && (
            <div className="card">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Position</th>
                    <th>Protocol</th>
                    <th className="num">Capital</th>
                    <th className="num">Yield Earned</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.activePositions.length > 0 ? snapshot.activePositions.map(pos => {
                    const protocol = pos.graph.nodes[0]?.protocol ?? 'unknown';
                    const capital = pos.currentValueUsd ?? pos.entryValueUsd ?? 0;
                    return (
                      <tr key={pos.id}>
                        <td style={{ fontWeight: 500 }}>{pos.graph.name}</td>
                        <td>{protocol}</td>
                        <td className="num">{fmtUsd(capital, { compact: true })}</td>
                        <td className="num" style={{ color: 'var(--pos)' }}>{fmtUsd(pos.yieldEarnedUsd ?? 0)}</td>
                        <td><span className={`tag ${pos.status === 'active' ? 'pos' : ''}`}>{pos.status}</span></td>
                        <td>
                          {pos.status === 'active' && (
                            <ExitButton
                              positionId={pos.id}
                              initiatedBy={address ?? 'unknown'}
                              onDone={refresh}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  }) : (
                    <tr><td colSpan={6} className="muted">No active positions in the backend.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'alerts' && (
            <div className="fade-in">
              {alerts.length > 0 ? alerts.map(alert => (
                <div key={alert.id} className={`alert ${alert.severity === 'critical' ? 'crit' : alert.severity === 'warning' ? 'warn' : 'info'}`}>
                  <div className="bar" />
                  <div className="body">
                    <div className="title">{alert.title}</div>
                    {alert.message && <div className="desc">{alert.message}</div>}
                    <div className="meta">{new Date(alert.createdAt).toLocaleString()}</div>
                  </div>
                  <div className="actions">
                    <button className="btn btn-sm btn-primary" onClick={onCompose}>Review</button>
                  </div>
                </div>
              )) : (
                <div className="card card-pad" style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                  <IconBell size={14} /> No alerts.
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
