'use client';

import React, { useState, useRef, useEffect } from 'react';
import { type Strategy } from '@/lib/data';
import { fmtUsd, fmtPct, buildSparklinePath } from '@/lib/utils';
import { IconArrowRight, IconShield, IconBolt, IconCheck } from '@/lib/icons';

interface StrategyDetailProps {
  strategy: Strategy;
  capitalUsd: number;
  onDeploy: () => void;
  onBack: () => void;
}

const PROTOCOL_COLORS: Record<string, string> = {
  'Aave V3': '#B6509E',
  'Morpho Blue': '#2470FF',
  'Uniswap V3': '#FF4FA3',
};

const NODE_KIND_COLORS: Record<string, string> = {
  wallet: '#6B8AFF',
  vault: '#2470FF',
  pool: '#B6509E',
  lp: '#4F92FF',
  gauge: '#6EE7A8',
  compounder: '#FFB547',
  yield: '#6EE7A8',
};

// DAG Canvas
function DagCanvas({ strategy }: { strategy: Strategy }) {
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 100);
    return () => clearTimeout(t);
  }, []);

  const NODE_W = 180;
  const NODE_H = 76;

  // Build edge paths
  const edges = strategy.edges.map(edge => {
    const from = strategy.nodes.find(n => n.id === edge.from);
    const to = strategy.nodes.find(n => n.id === edge.to);
    if (!from || !to) return null;
    const x1 = from.pos.x + NODE_W;
    const y1 = from.pos.y + NODE_H / 2;
    const x2 = to.pos.x;
    const y2 = to.pos.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    return {
      d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
      label: edge.amount ? `${edge.amount}%` : undefined,
      midX: mx,
      midY: (y1 + y2) / 2,
    };
  }).filter(Boolean);

  return (
    <div className="dag-canvas" ref={containerRef}>
      <svg className="dag-svg">
        <defs>
          <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="var(--border-strong)" />
          </marker>
        </defs>
        {edges.map((edge, i) => edge && (
          <g key={i}>
            <path
              d={edge.d}
              stroke="var(--border-strong)"
              strokeWidth="1.5"
              fill="none"
              strokeDasharray="4 3"
              markerEnd="url(#arrowhead)"
            />
            {edge.label && (
              <text
                x={edge.midX}
                y={edge.midY - 6}
                textAnchor="middle"
                style={{ fontSize: 10, fill: 'var(--accent)', fontFamily: 'var(--font-mono)' }}
              >
                {edge.label}
              </text>
            )}
          </g>
        ))}
      </svg>

      {strategy.nodes.map(node => {
        const color = node.protocol
          ? (PROTOCOL_COLORS[node.protocol] ?? '#6A6E76')
          : (NODE_KIND_COLORS[node.kind] ?? '#6A6E76');
        return (
          <div
            key={node.id}
            className="dag-node"
            style={{
              left: node.pos.x,
              top: node.pos.y,
              opacity: visible ? 1 : 0,
              transform: visible ? 'none' : 'translateY(8px)',
              transitionDelay: visible ? `${strategy.nodes.indexOf(node) * 0.08}s` : '0s',
            }}
          >
            <div className="nh">
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
              {node.protocol ?? node.kind}
            </div>
            <div className="nt">{node.label}</div>
            {(node.apy !== undefined) && (
              <div className="nd">{fmtPct(node.apy, 1)} APY</div>
            )}
            {(node.hf !== undefined && node.hf < 100) && (
              <div className="nd" style={{ color: node.hf < 1.5 ? 'var(--neg)' : node.hf < 2.0 ? 'var(--warn)' : 'var(--text-dim)' }}>
                HF: {node.hf.toFixed(2)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Risk Radar
function RiskRadar({ breakdown }: { breakdown: Strategy['riskBreakdown'] }) {
  const axes = [
    { key: 'market', label: 'Market' },
    { key: 'liquidation', label: 'Liquidation' },
    { key: 'protocol', label: 'Protocol' },
    { key: 'liquidity', label: 'Liquidity' },
    { key: 'oracle', label: 'Oracle' },
  ] as const;

  const size = 220;
  const cx = size / 2;
  const cy = size / 2;
  const r = 80;
  const n = axes.length;

  const getPoint = (angle: number, radius: number) => ({
    x: cx + radius * Math.sin(angle),
    y: cy - radius * Math.cos(angle),
  });

  // Grid rings
  const rings = [2, 4, 6, 8, 10].map(v => {
    const pts = axes.map((_, i) => {
      const p = getPoint((2 * Math.PI * i) / n, (r * v) / 10);
      return `${p.x},${p.y}`;
    });
    return pts.join(' ');
  });

  // Data polygon
  const dataPts = axes.map((ax, i) => {
    const v = breakdown[ax.key];
    const p = getPoint((2 * Math.PI * i) / n, (r * v) / 10);
    return `${p.x},${p.y}`;
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {/* Grid rings */}
      {rings.map((pts, i) => (
        <polygon key={i} points={pts} fill="none" stroke="var(--border)" strokeWidth="0.8" />
      ))}

      {/* Axis lines */}
      {axes.map((_, i) => {
        const p = getPoint((2 * Math.PI * i) / n, r);
        return <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="var(--border)" strokeWidth="0.8" />;
      })}

      {/* Data */}
      <polygon
        points={dataPts.join(' ')}
        fill="rgba(107,138,255,0.15)"
        stroke="var(--accent)"
        strokeWidth="1.5"
      />

      {/* Labels */}
      {axes.map((ax, i) => {
        const p = getPoint((2 * Math.PI * i) / n, r + 18);
        return (
          <text
            key={i}
            x={p.x}
            y={p.y}
            textAnchor="middle"
            dominantBaseline="middle"
            style={{ fontSize: 10, fill: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}
          >
            {ax.label}
          </text>
        );
      })}
    </svg>
  );
}

// Stress Test
function StressTest({ simulation }: { simulation: Strategy['simulation'] }) {
  const [pctDrop, setPctDrop] = useState(0);

  const stressMap: Record<number, number> = {
    0: simulation.stress.d0,
    10: simulation.stress.d10,
    30: simulation.stress.d30,
    50: simulation.stress.d50,
  };

  const getStressValue = (pct: number): number => {
    const keys = [0, 10, 30, 50];
    for (let i = 0; i < keys.length - 1; i++) {
      const k1 = keys[i];
      const k2 = keys[i + 1];
      if (pct >= k1 && pct <= k2) {
        const t = (pct - k1) / (k2 - k1);
        return stressMap[k1] + t * (stressMap[k2] - stressMap[k1]);
      }
    }
    return stressMap[50];
  };

  const val = getStressValue(pctDrop);
  const loss = simulation.stress.d0 - val;
  const lossPct = (loss / simulation.stress.d0) * 100;

  const sparkData = [0, 5, 10, 20, 30, 40, 50].map(p => getStressValue(p));

  return (
    <div className="stress">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 500 }}>Stress Test Simulator</span>
        <span className="mono" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          {pctDrop === 0 ? 'No stress' : `-${pctDrop}% scenario`}
        </span>
      </div>

      <div className="stress-track">
        <input
          type="range"
          min={0}
          max={50}
          step={1}
          value={pctDrop}
          onChange={e => setPctDrop(Number(e.target.value))}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 8 }}>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Portfolio Value</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, marginTop: 4 }}>{fmtUsd(val, { compact: true })}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Loss</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, marginTop: 4, color: loss > 0 ? 'var(--neg)' : 'var(--pos)' }}>
            {loss > 0 ? '-' : ''}{fmtUsd(loss, { compact: true })}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Loss %</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, marginTop: 4, color: lossPct > 0 ? 'var(--neg)' : 'var(--pos)' }}>
            {lossPct > 0 ? '-' : ''}{Math.abs(lossPct).toFixed(1)}%
          </div>
        </div>
      </div>

      <svg width="100%" height="32" viewBox={`0 0 200 32`} style={{ marginTop: 8 }}>
        <path
          d={buildSparklinePath(sparkData, 200, 28)}
          stroke={pctDrop > 30 ? 'var(--neg)' : pctDrop > 10 ? 'var(--warn)' : 'var(--pos)'}
          strokeWidth="1.5"
          fill="none"
        />
      </svg>
    </div>
  );
}

export function StrategyDetail({ strategy, capitalUsd, onDeploy, onBack }: StrategyDetailProps) {
  const [tab, setTab] = useState<'overview' | 'simulation' | 'risk'>('overview');

  const yearlyYield = capitalUsd * (strategy.apy / 100);

  return (
    <div className="page fade-in">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: 12 }}>
            ← All Strategies
          </button>
          <div className="eyebrow" style={{ marginBottom: 6 }}>#{strategy.rank} Strategy</div>
          <h2 className="h2">{strategy.name}</h2>
          <div className="muted" style={{ marginTop: 6, fontSize: 13, maxWidth: 600 }}>{strategy.summary}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {strategy.blockers.length === 0 ? (
            <span className="tag pos">
              <IconCheck size={10} />
              No blockers
            </span>
          ) : (
            <span className="tag neg">{strategy.blockers.length} blockers</span>
          )}
          <button
            className="btn btn-primary btn-lg"
            onClick={onDeploy}
            disabled={strategy.blockers.length > 0}
          >
            <IconBolt size={14} />
            Deploy Strategy
          </button>
        </div>
      </div>

      {/* KPI Row */}
      <div className="kpi-row" style={{ marginBottom: 20 }}>
        <div className="stat">
          <div className="lbl">APY</div>
          <div className="val" style={{ color: 'var(--pos)' }}>{fmtPct(strategy.apy, 1)}</div>
          <div className="sub">{fmtPct(strategy.apyRange[0], 1)}–{fmtPct(strategy.apyRange[1], 1)} range</div>
        </div>
        <div className="stat">
          <div className="lbl">vs T-Bill</div>
          <div className="val" style={{ color: 'var(--pos)' }}>+{fmtPct(strategy.benchmarkDelta, 1)}</div>
          <div className="sub">5.3% benchmark</div>
        </div>
        <div className="stat">
          <div className="lbl">Annual Yield</div>
          <div className="val">{fmtUsd(yearlyYield, { compact: true })}</div>
          <div className="sub">{fmtUsd(yearlyYield / 365, { compact: true })}/day</div>
        </div>
        <div className="stat">
          <div className="lbl">Risk Score</div>
          <div className="val">{strategy.riskScore.toFixed(1)}/10</div>
          <div className="sub" style={{ textTransform: 'capitalize' }}>{strategy.riskLevel} risk</div>
        </div>
        <div className="stat">
          <div className="lbl">Gas Cost</div>
          <div className="val">{fmtUsd(strategy.gasUsd)}</div>
          <div className="sub">~{Math.ceil(strategy.gasUsd / (yearlyYield / 365))}d payback</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {(['overview', 'simulation', 'risk'] as const).map(t => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="detail-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <div className="hr-label" style={{ marginBottom: 16 }}>Execution DAG</div>
              <DagCanvas strategy={strategy} />
            </div>

            {/* Rationale */}
            <div className="card card-pad">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <IconShield size={14} style={{ color: 'var(--accent)' }} />
                <span style={{ fontSize: 13, fontWeight: 500 }}>AI Rationale</span>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.55, margin: 0 }}>
                {strategy.rationale}
              </p>
            </div>

            {/* Warnings */}
            {strategy.warnings.length > 0 && (
              <div>
                <div className="hr-label" style={{ marginBottom: 12 }}>Warnings & Notes</div>
                {strategy.warnings.map((w, i) => (
                  <div key={i} className={`alert ${w.level}`} style={{ marginBottom: 8 }}>
                    <div className="bar" />
                    <div className="body">
                      <div className="desc">{w.text}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <StressTest simulation={strategy.simulation} />

            {/* Risk breakdown */}
            <div className="card card-pad">
              <div className="hr-label" style={{ marginBottom: 14 }}>Risk Breakdown</div>
              <div className="radar-wrap">
                <RiskRadar breakdown={strategy.riskBreakdown} />
              </div>
              <div style={{ marginTop: 12 }}>
                {Object.entries(strategy.riskBreakdown).map(([key, val]) => (
                  <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                    <span style={{ textTransform: 'capitalize', color: 'var(--text-dim)' }}>{key}</span>
                    <span className="mono" style={{ color: val > 6 ? 'var(--neg)' : val > 4 ? 'var(--warn)' : 'var(--pos)' }}>
                      {val.toFixed(1)}/10
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Deploy CTA */}
            <div className="card card-pad" style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>Ready to deploy?</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 14, lineHeight: 1.4 }}>
                This strategy has been simulated on a Tenderly fork with 0 blockers. Safe multisig approval required.
              </div>
              <button
                className="btn btn-primary"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={onDeploy}
                disabled={strategy.blockers.length > 0}
              >
                <IconBolt size={13} />
                Submit to Safe Multisig
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === 'simulation' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="card">
            <div style={{ padding: 'var(--tile-pad)', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 4 }}>Execution Steps</div>
              <div className="muted" style={{ fontSize: 12 }}>Simulated on Tenderly fork at current block</div>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Action</th>
                  <th className="num">Gas (USD)</th>
                  <th className="num">Cumulative</th>
                </tr>
              </thead>
              <tbody>
                {strategy.simulation.steps.map((step, i) => (
                  <tr key={i}>
                    <td className="mono" style={{ color: 'var(--text-faint)' }}>{i + 1}</td>
                    <td>
                      <div style={{ fontWeight: 500, fontSize: 12 }}>{step.node}</div>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>{step.out}</div>
                    </td>
                    <td className="num">{step.gas > 0 ? fmtUsd(step.gas) : '—'}</td>
                    <td className="num">{step.cum > 0 ? fmtUsd(step.cum) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid-2">
            <div className="card card-pad">
              <div className="hr-label" style={{ marginBottom: 14 }}>Projected Returns</div>
              {[
                { label: 'Day 1', value: fmtUsd(strategy.simulation.projected.d1) },
                { label: '30 Days', value: fmtUsd(strategy.simulation.projected.d30) },
                { label: '1 Year', value: fmtUsd(strategy.simulation.projected.y1) },
              ].map(r => (
                <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                  <span className="muted">{r.label}</span>
                  <span className="mono" style={{ color: 'var(--pos)' }}>+{r.value}</span>
                </div>
              ))}
            </div>

            <div className="card card-pad">
              <div className="hr-label" style={{ marginBottom: 14 }}>Stress Scenarios</div>
              {[
                { label: 'No stress (D0)', value: strategy.simulation.stress.d0 },
                { label: '-10% scenario', value: strategy.simulation.stress.d10 },
                { label: '-30% scenario', value: strategy.simulation.stress.d30 },
                { label: '-50% scenario', value: strategy.simulation.stress.d50 },
              ].map(s => {
                const loss = ((strategy.simulation.stress.d0 - s.value) / strategy.simulation.stress.d0 * 100);
                return (
                  <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                    <span className="muted">{s.label}</span>
                    <div style={{ textAlign: 'right' }}>
                      <span className="mono">{fmtUsd(s.value, { compact: true })}</span>
                      {loss > 0 && (
                        <span className="mono" style={{ color: 'var(--neg)', fontSize: 11, marginLeft: 6 }}>
                          -{loss.toFixed(1)}%
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {tab === 'risk' && (
        <div className="detail-grid">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="card card-pad">
              <div className="hr-label" style={{ marginBottom: 16 }}>5-Factor Risk Analysis</div>
              {Object.entries(strategy.riskBreakdown).map(([factor, score]) => {
                const pct = (score / 10) * 100;
                return (
                  <div key={factor} style={{ marginBottom: 16 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                      <span style={{ textTransform: 'capitalize', fontWeight: 500 }}>{factor} Risk</span>
                      <span className="mono" style={{ color: score > 6 ? 'var(--neg)' : score > 4 ? 'var(--warn)' : 'var(--pos)' }}>
                        {score.toFixed(1)}/10
                      </span>
                    </div>
                    <div style={{ height: 6, background: 'var(--bg-elev-2)', borderRadius: 3, overflow: 'hidden', border: '1px solid var(--border)' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: score > 6 ? 'var(--neg)' : score > 4 ? 'var(--warn)' : 'var(--pos)', borderRadius: 3 }} />
                    </div>
                  </div>
                );
              })}
            </div>

            {strategy.blockers.length > 0 && (
              <div className="card card-pad" style={{ borderColor: 'color-mix(in srgb, var(--neg) 30%, var(--border))' }}>
                <div className="hr-label" style={{ marginBottom: 12, color: 'var(--neg)' }}>Blockers</div>
                {strategy.blockers.map((b, i) => (
                  <div key={i} className="alert crit" style={{ marginBottom: 8 }}>
                    <div className="bar" />
                    <div className="body"><div className="desc">{b}</div></div>
                  </div>
                ))}
              </div>
            )}

            {strategy.warnings.length > 0 && (
              <div className="card card-pad">
                <div className="hr-label" style={{ marginBottom: 12 }}>Warnings</div>
                {strategy.warnings.map((w, i) => (
                  <div key={i} className={`alert ${w.level}`} style={{ marginBottom: 8 }}>
                    <div className="bar" />
                    <div className="body"><div className="desc">{w.text}</div></div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card card-pad">
            <div className="hr-label" style={{ marginBottom: 16 }}>Risk Radar</div>
            <div className="radar-wrap">
              <RiskRadar breakdown={strategy.riskBreakdown} />
            </div>
            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
              Risk scores are deterministic — computed from on-chain data, protocol age, TVL, audit coverage, and liquidation parameters. Not AI-estimated.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
