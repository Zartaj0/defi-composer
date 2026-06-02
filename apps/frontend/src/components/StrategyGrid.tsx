'use client';

import React from 'react';
import { type Strategy } from '@/lib/data';
import { fmtUsd, fmtPct } from '@/lib/utils';
import { IconArrowRight, IconShield, IconSpark } from '@/lib/icons';

interface StrategyGridProps {
  strategies: Strategy[];
  capitalUsd: number;
  onSelect: (s: Strategy) => void;
  onBack: () => void;
}

const PROTOCOL_COLORS: Record<string, string> = {
  'Aave V3': '#B6509E',
  'Morpho Blue': '#2470FF',
  'Uniswap V3': '#FF4FA3',
};

function ProtoPill({ name }: { name: string }) {
  const color = PROTOCOL_COLORS[name] ?? '#6A6E76';
  return (
    <div className="strat-node">
      <span className="pdot" style={{ background: color }} />
      {name}
    </div>
  );
}

function RiskDot({ level }: { level: string }) {
  return (
    <span
      className={`dot-risk ${level === 'med' ? 'med' : level === 'high' ? 'high' : ''}`}
    />
  );
}

function StrategyCard({ strategy, capital, onSelect }: { strategy: Strategy; capital: number; onSelect: () => void }) {
  const yearlyYield = capital * (strategy.apy / 100);
  const delta = strategy.benchmarkDelta;

  return (
    <div
      className={`strat-card ${strategy.rank === 1 ? 'recommended' : ''} fade-in`}
      style={{ animationDelay: `${(strategy.rank - 1) * 0.08}s` }}
    >
      <div>
        <div className="strat-rank">#{strategy.rank}</div>
        <div className="strat-name" style={{ marginTop: 4 }}>{strategy.name}</div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.4 }}>{strategy.summary}</div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 4 }}>APY</div>
          <div className="strat-apy">{fmtPct(strategy.apy, 1)}</div>
        </div>
        <div style={{ paddingBottom: 4 }}>
          <span className="tag pos">+{delta.toFixed(1)}% vs T-bill</span>
        </div>
      </div>

      <div className="strat-flow">
        {strategy.protocols.map(p => (
          <React.Fragment key={p}>
            <ProtoPill name={p} />
            {strategy.protocols.indexOf(p) < strategy.protocols.length - 1 && (
              <IconArrowRight size={10} />
            )}
          </React.Fragment>
        ))}
      </div>

      <div className="strat-metrics">
        <div className="m">
          <div className="lbl">Risk</div>
          <div className="v" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <RiskDot level={strategy.riskLevel} />
            {strategy.riskScore.toFixed(1)}/10
          </div>
        </div>
        <div className="m">
          <div className="lbl">Annual Yield</div>
          <div className="v">{fmtUsd(yearlyYield, { compact: true })}</div>
        </div>
        <div className="m">
          <div className="lbl">Gas Est.</div>
          <div className="v">{fmtUsd(strategy.gasUsd)}</div>
        </div>
      </div>

      {strategy.warnings.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {strategy.warnings.slice(0, 2).map((w, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: w.level === 'warn' ? 'var(--warn)' : 'var(--text-dim)' }}>
              <span style={{ flexShrink: 0 }}>{w.level === 'warn' ? '⚠' : 'ℹ'}</span>
              <span>{w.text}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button className="btn btn-primary" style={{ flex: 1 }} onClick={onSelect}>
          <IconSpark size={12} />
          View & Deploy
          <IconArrowRight size={12} />
        </button>
      </div>
    </div>
  );
}

export function StrategyGrid({ strategies, capitalUsd, onSelect, onBack }: StrategyGridProps) {
  const sorted = [...strategies].sort((a, b) => a.rank - b.rank);
  const best = sorted[0];

  return (
    <div className="page fade-in">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Strategy Candidates</div>
          <h2 className="h2">{strategies.length} strategies composed</h2>
          <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
            Simulated on Tenderly fork · Capital: {fmtUsd(capitalUsd)} · Ranked by risk-adjusted return
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" onClick={onBack}>
            ← Back
          </button>
        </div>
      </div>

      {/* Best vs benchmark banner */}
      {best && (
        <div style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', borderRadius: 'var(--radius-md)', padding: '10px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
          <IconShield size={14} style={{ color: 'var(--accent)' }} />
          <span>
            Best strategy: <strong>{best.name}</strong> — {fmtPct(best.apy, 1)} APY ({fmtPct(best.benchmarkDelta, 1, true)} vs T-bill benchmark) · Gas recoverable in {Math.ceil(best.gasUsd / (capitalUsd * (best.apy / 100) / 365))} days
          </span>
        </div>
      )}

      {/* Cards grid */}
      <div className="grid-3" style={{ alignItems: 'start' }}>
        {sorted.map(s => (
          <StrategyCard
            key={s.id}
            strategy={s}
            capital={capitalUsd}
            onSelect={() => onSelect(s)}
          />
        ))}
      </div>

      <div style={{ marginTop: 32 }}>
        <div className="hr-label" style={{ marginBottom: 16 }}>V1 Protocol Scope</div>
        <div className="card">
          <table className="tbl">
            <thead>
              <tr>
                <th>Protocol</th>
                <th>Purpose</th>
                <th>Execution Mode</th>
              </tr>
            </thead>
            <tbody>
              {[
                { name: 'Aave V3', purpose: 'Conservative lending yield', mode: 'Supply/withdraw only', color: '#B6509E' },
                { name: 'Morpho Blue', purpose: 'Curated USDC vault yield', mode: 'Deposit/redeem only', color: '#2470FF' },
                { name: 'Uniswap V3', purpose: 'Reserve conversion for WETH/USDC', mode: 'Swap only, no LP', color: '#FF4FA3' },
              ].map(p => (
                <tr key={p.name}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                      {p.name}
                    </div>
                  </td>
                  <td className="muted">{p.purpose}</td>
                  <td className="muted">{p.mode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
