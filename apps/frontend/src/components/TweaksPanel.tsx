'use client';

import React from 'react';
import { IconX, IconCheck } from '@/lib/icons';

type Aesthetic = 'onchain' | 'terminal' | 'fintech';
type Theme = 'dark' | 'light';
type Density = 'compact' | 'cozy' | 'roomy';

export interface Tweaks {
  aesthetic: Aesthetic;
  theme: Theme;
  density: Density;
  accent: string;
  showMonitorTicker: boolean;
}

interface TweaksPanelProps {
  tweaks: Tweaks;
  onChange: (t: Tweaks) => void;
  onClose: () => void;
}

const ACCENTS = ['#6B8AFF', '#7C66FF', '#4F9EFF', '#5EC9FF', '#6EE7A8', '#FFB547', '#FF6E6E'];

export function TweaksPanel({ tweaks, onChange, onClose }: TweaksPanelProps) {
  const set = <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => {
    onChange({ ...tweaks, [key]: value });
  };

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        width: 280,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-xl)',
        boxShadow: 'var(--shadow-pop)',
        zIndex: 60,
        overflow: 'hidden',
      }}
      className="fade-in"
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontWeight: 500, fontSize: 13, flex: 1 }}>Appearance</span>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          <IconX size={12} />
        </button>
      </div>

      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Aesthetic */}
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Aesthetic</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            {(['onchain', 'terminal', 'fintech'] as Aesthetic[]).map(a => (
              <button
                key={a}
                onClick={() => set('aesthetic', a)}
                style={{
                  padding: '7px 4px',
                  border: `1px solid ${tweaks.aesthetic === a ? 'var(--accent)' : 'var(--border)'}`,
                  background: tweaks.aesthetic === a ? 'var(--accent-soft)' : 'var(--bg)',
                  borderRadius: 'var(--radius-md)',
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: tweaks.aesthetic === a ? 'var(--accent)' : 'var(--text-dim)',
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {a}
              </button>
            ))}
          </div>
        </div>

        {/* Theme */}
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Theme</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {(['dark', 'light'] as Theme[]).map(t => (
              <button
                key={t}
                onClick={() => set('theme', t)}
                style={{
                  padding: '7px 4px',
                  border: `1px solid ${tweaks.theme === t ? 'var(--accent)' : 'var(--border)'}`,
                  background: tweaks.theme === t ? 'var(--accent-soft)' : 'var(--bg)',
                  borderRadius: 'var(--radius-md)',
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: tweaks.theme === t ? 'var(--accent)' : 'var(--text-dim)',
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 5,
                }}
              >
                {tweaks.theme === t && <IconCheck size={10} />}
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Density */}
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Density</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
            {(['compact', 'cozy', 'roomy'] as Density[]).map(d => (
              <button
                key={d}
                onClick={() => set('density', d)}
                style={{
                  padding: '7px 4px',
                  border: `1px solid ${tweaks.density === d ? 'var(--accent)' : 'var(--border)'}`,
                  background: tweaks.density === d ? 'var(--accent-soft)' : 'var(--bg)',
                  borderRadius: 'var(--radius-md)',
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: tweaks.density === d ? 'var(--accent)' : 'var(--text-dim)',
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        {/* Accent color */}
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Accent Color</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {ACCENTS.map(color => (
              <button
                key={color}
                onClick={() => set('accent', color)}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  background: color,
                  border: tweaks.accent === color ? '2px solid var(--text)' : '2px solid transparent',
                  cursor: 'pointer',
                  outline: tweaks.accent === color ? '2px solid var(--bg)' : 'none',
                  outlineOffset: -3,
                }}
              />
            ))}
          </div>
        </div>

        {/* Monitor ticker toggle */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Monitor Ticker</div>
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>Live rates scrolling bar</div>
          </div>
          <button
            onClick={() => set('showMonitorTicker', !tweaks.showMonitorTicker)}
            style={{
              width: 36,
              height: 20,
              borderRadius: 10,
              background: tweaks.showMonitorTicker ? 'var(--accent)' : 'var(--border-strong)',
              position: 'relative',
              border: 'none',
              cursor: 'pointer',
              transition: 'background 0.2s',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 3,
                left: tweaks.showMonitorTicker ? 19 : 3,
                width: 14,
                height: 14,
                borderRadius: '50%',
                background: 'white',
                transition: 'left 0.2s',
              }}
            />
          </button>
        </div>
      </div>

      <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text-faint)', textAlign: 'center', fontFamily: 'var(--font-mono)' }}>
        DeFi Composer — v0.1.0-beta
      </div>
    </div>
  );
}
