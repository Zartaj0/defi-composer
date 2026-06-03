'use client';

import React, { useState, useEffect } from 'react';
import { GEN_STEPS } from '@/lib/data';
import { IconCheck } from '@/lib/icons';
import { type Strategy } from '@/lib/data';
import type { CandidateStrategy } from '@defi-composer/shared';

interface GeneratingScreenProps {
  intentText: string;
  capitalUsd: number;
  orgId: string;
  intentId?: string;
  onDone: (strategies: Strategy[]) => void;
}

type StepStatus = 'pending' | 'active' | 'done';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export function GeneratingScreen({ intentText, capitalUsd, orgId, intentId, onDone }: GeneratingScreenProps) {
  const [stepIdx, setStepIdx] = useState(0);
  const [stepStatuses, setStepStatuses] = useState<StepStatus[]>(GEN_STEPS.map(() => 'pending'));
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (intentId) {
      void runWithPolling();
    } else {
      setError('Strategy generation requires a stored backend intent. No mock strategies are generated.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const advanceStep = (idx: number) => {
    setStepStatuses(prev => {
      const next = [...prev];
      if (idx > 0) next[idx - 1] = 'done';
      if (idx < next.length) next[idx] = 'active';
      return next;
    });
    setStepIdx(idx);
  };

  const runWithPolling = async () => {
    advanceStep(0);
    await delay(600);
    advanceStep(1);

    try {
      let attempts = 0;
      let stepSimulated = 2;
      const maxAttempts = 30; // 60s timeout

      while (attempts < maxAttempts) {
        await delay(2000);
        attempts++;

        if (stepSimulated < GEN_STEPS.length - 1) {
          advanceStep(stepSimulated++);
        }

        try {
          const res = await fetch(`${API_BASE}/api/v1/intent/${intentId}`);
          if (!res.ok) continue;
          const data = await res.json();

          if (data.status === 'ready' || data.data?.status === 'ready') {
            // Fetch candidates
            const candRes = await fetch(`${API_BASE}/api/v1/intent/${intentId}/candidates`);
            if (candRes.ok) {
              const candData = await candRes.json();
              // Backend returns { success, data: { status, candidates: [...] } }
              const candidates: CandidateStrategy[] =
                candData.data?.candidates ??
                (Array.isArray(candData.data) ? candData.data : null) ??
                candData.candidates ??
                (Array.isArray(candData) ? candData : []);
              if (candidates.length > 0) {
                setStepStatuses(prev => prev.map(() => 'done'));
                await delay(400);
                onDone(candidates.map(candidate => candidateToStrategy(candidate, capitalUsd)));
                return;
              }
            }
          }

          const backendStatus = data.data?.status ?? data.status;
          if (backendStatus === 'failed' || backendStatus === 'cancelled') {
            throw new Error('Strategy generation failed on the backend.');
          }
        } catch {
          // continue polling
        }
      }

      setError('Strategy generation timed out before the backend returned candidates.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Strategy generation failed.');
    }
  };

  const allDone = stepStatuses.every(s => s === 'done');

  return (
    <div className="gen-stage">
      <div className="gen-card fade-in">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {allDone ? (
            <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--accent-soft)', display: 'grid', placeItems: 'center', border: '1px solid var(--accent-line)' }}>
              <IconCheck size={14} />
            </div>
          ) : (
            <div className="gen-spin" style={{ width: 20, height: 20, flexShrink: 0 }} />
          )}
          <div>
            <div className="h3">{allDone ? 'Strategies ready' : 'Composing your strategy…'}</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
              {allDone
                ? 'Analysis complete — reviewing 3 candidates'
                : `Analyzing protocols, building DAG, running simulations`}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 16, padding: '12px 14px', background: 'var(--bg)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: 13, color: 'var(--text-dim)', fontStyle: 'italic', lineHeight: 1.4 }}>
          &ldquo;{intentText}&rdquo;
        </div>

        {error && (
          <div style={{ marginTop: 16, padding: '12px 14px', background: 'rgba(255,90,90,0.08)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(255,90,90,0.22)', fontSize: 12, color: 'var(--neg)', lineHeight: 1.5 }}>
            {error}
          </div>
        )}

        <div className="gen-steps">
          {GEN_STEPS.map((step, i) => {
            const status = stepStatuses[i];
            return (
              <div key={i} className={`gen-step ${status}`}>
                <div className="idx">
                  {status === 'done' ? <IconCheck size={10} /> : i + 1}
                </div>
                <span>{step.label}</span>
                <div className="timing">
                  {status === 'active' && <div className="gen-spin" />}
                  {status === 'done' && (
                    <span style={{ color: 'var(--pos)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>✓</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
          <span>Capital: ${Number(capitalUsd).toLocaleString()}</span>
          <span>{elapsed}s elapsed</span>
        </div>
      </div>
    </div>
  );
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function candidateToStrategy(candidate: CandidateStrategy, fallbackCapitalUsd: number): Strategy {
  const apy = candidate.simulation?.projectedApyBps !== undefined
    ? candidate.simulation.projectedApyBps / 100
    : candidate.graph.estimatedApyBps / 100;
  const gasUsd = candidate.simulation?.totalGasCostUsd ?? candidate.graph.totalGasCostUsd;
  const protocols = Array.from(new Set(candidate.graph.nodes.map(node => displayProtocol(node.protocol))));
  const warnings = candidate.riskScore.warnings.map(text => ({ level: 'warn', text }));

  return {
    id: candidate.id,
    rank: candidate.rank,
    name: candidate.name,
    summary: candidate.tagline,
    apy,
    apyRange: [Math.max(0, apy - 0.5), apy + 0.5],
    benchmarkDelta: apy - 5.0,
    riskScore: candidate.riskScore.overall,
    riskLevel: candidate.riskScore.overallLevel === 'medium' ? 'med' : candidate.riskScore.overallLevel.includes('high') ? 'high' : 'low',
    gasUsd,
    protocols,
    nodes: candidate.graph.nodes.map((node, index) => ({
      id: node.id,
      kind: node.action,
      label: `${node.action} ${node.inputAsset}`,
      protocol: displayProtocol(node.protocol),
      pos: { x: 40 + (index % 3) * 220, y: 120 + Math.floor(index / 3) * 160 },
      apy: node.expectedApyBps / 100,
    })),
    edges: candidate.graph.edges.map(edge => ({ from: edge.from, to: edge.to })),
    rationale: candidate.aiRationale,
    warnings,
    blockers: candidate.riskScore.blockers,
    riskBreakdown: {
      market: candidate.riskScore.marketRisk,
      liquidation: candidate.riskScore.liquidationRisk,
      protocol: candidate.riskScore.protocolRisk,
      liquidity: candidate.riskScore.liquidityRisk,
      oracle: candidate.riskScore.oracleRisk,
    },
    simulation: {
      capital: capitalFromSimulation(candidate, fallbackCapitalUsd),
      steps: (candidate.simulation?.capitalFlow ?? []).map(step => ({
        node: step.nodeId,
        out: step.outputAmount,
        gas: step.gasCostUsd,
        cum: step.gasCostUsd,
      })),
      stress: {
        d0: capitalFromSimulation(candidate, fallbackCapitalUsd),
        d10: capitalFromSimulation(candidate, fallbackCapitalUsd) * 0.99,
        d30: capitalFromSimulation(candidate, fallbackCapitalUsd) * (1 - ((candidate.simulation?.stressTest.maxDrawdownPct ?? 2) / 100)),
        d50: capitalFromSimulation(candidate, fallbackCapitalUsd) * (candidate.simulation?.stressTest.survives50PctDrop ? 0.95 : 0.9),
      },
      projected: {
        d1: candidate.simulation?.projectedDailyYieldUsd ?? 0,
        d30: (candidate.simulation?.projectedDailyYieldUsd ?? 0) * 30,
        y1: (candidate.simulation?.projectedDailyYieldUsd ?? 0) * 365,
      },
    },
  };
}

function displayProtocol(protocol: string): string {
  if (protocol === 'aave-v3') return 'Aave V3';
  if (protocol === 'morpho-blue') return 'Morpho Blue';
  if (protocol === 'uniswap-v3') return 'Uniswap V3';
  return protocol;
}

function capitalFromSimulation(candidate: CandidateStrategy, fallbackCapitalUsd: number): number {
  const firstInput = candidate.simulation?.capitalFlow[0]?.inputAmount;
  if (!firstInput) return fallbackCapitalUsd;
  const parsed = Number(firstInput.replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) ? parsed : fallbackCapitalUsd;
}
