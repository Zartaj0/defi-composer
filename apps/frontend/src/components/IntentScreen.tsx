'use client';

import React, { useState } from 'react';
import { IconSpark, IconArrowRight } from '@/lib/icons';
import { INTENT_EXAMPLES } from '@/lib/data';
import { fmtUsd } from '@/lib/utils';

interface IntentScreenProps {
  orgName: string;
  idleUsd: number;
  onSubmit: (text: string, capital: number) => void;
}

export function IntentScreen({ orgName, idleUsd, onSubmit }: IntentScreenProps) {
  const [text, setText] = useState('');
  const [capital, setCapital] = useState(String(Math.round(idleUsd * 0.3)));

  const handleSubmit = () => {
    const cap = parseFloat(capital.replace(/[^0-9.]/g, '')) || 1_000_000;
    if (text.trim().length > 4) {
      onSubmit(text.trim(), cap);
    }
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleSubmit();
    }
  };

  return (
    <div className="intent-shell">
      <div className="intent-inner fade-in">
        <p className="eyebrow" style={{ marginBottom: 16 }}>Treasury Composer — {orgName}</p>
        <h1 className="intent-hello">
          What should your<br />
          <span className="accent">idle capital</span> do?
        </h1>
        <p className="intent-sub">
          Describe your goal in plain language. DeFi Composer will build, simulate, and propose the optimal strategy — no DeFi expertise required.
        </p>

        <div className="intent-box">
          <textarea
            className="intent-textarea"
            placeholder={`e.g. "Generate yield on $${(idleUsd / 1_000_000).toFixed(1)}M idle USDC. Max 40% in any single protocol. Need instant liquidity for governance proposals."`}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKey}
            autoFocus
          />
          <div className="intent-controls">
            <div className="intent-cap">
              <span className="muted" style={{ fontSize: 12 }}>Capital</span>
              <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>$</span>
              <input
                type="text"
                value={capital}
                onChange={e => setCapital(e.target.value)}
                placeholder="1,000,000"
              />
            </div>

            <div style={{ flex: 1, fontSize: 11, color: 'var(--text-faint)' }}>
              {fmtUsd(idleUsd, { compact: true })} idle · ⌘↵ to submit
            </div>

            <button
              className="btn btn-primary"
              onClick={handleSubmit}
              disabled={text.trim().length < 5}
            >
              <IconSpark size={13} />
              Compose Strategy
              <IconArrowRight size={13} />
            </button>
          </div>
        </div>

        <div className="intent-examples">
          {INTENT_EXAMPLES.map((ex, i) => (
            <button
              key={i}
              className="ex"
              onClick={() => { setText(ex.text); setCapital(ex.capital); }}
            >
              <div className="head">{ex.head}</div>
              {ex.text}
            </button>
          ))}
        </div>

        {/* Stats row */}
        <div style={{ marginTop: 40, display: 'flex', gap: 32, paddingTop: 24, borderTop: '1px solid var(--border)' }}>
          {[
            { label: 'Protocols Monitored', value: '3' },
            { label: 'Live APY Range', value: '6.1–11.2%' },
            { label: 'Avg Simulation Time', value: '~6s' },
            { label: 'Tenderly Fork', value: 'Current Block' },
          ].map(s => (
            <div key={s.label} className="stat">
              <div className="lbl">{s.label}</div>
              <div className="val" style={{ fontSize: 18 }}>{s.value}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
