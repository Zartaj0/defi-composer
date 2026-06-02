'use client';

import React, { useState, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { IconSpark, IconArrowRight } from '@/lib/icons';
import { INTENT_EXAMPLES } from '@/lib/data';
import { fmtUsd } from '@/lib/utils';
import { useWalletBalances } from '@/lib/useWalletBalances';

interface IntentScreenProps {
  orgName: string;
  onSubmit: (text: string, capital: number) => void;
}

export function IntentScreen({ orgName, onSubmit }: IntentScreenProps) {
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { usdcBalance, ethBalance, ethSymbol, isLoading: balLoading } = useWalletBalances(address);

  const [text, setText] = useState('');
  // Default capital: connected wallet's USDC balance (or 1M if no USDC / not connected)
  const [capital, setCapital] = useState('1000000');

  // Auto-update capital when USDC balance loads
  useEffect(() => {
    if (usdcBalance > 0) {
      // Suggest 50% of available USDC as default capital
      setCapital(String(Math.round(usdcBalance * 0.5)));
    }
  }, [usdcBalance]);

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

  // ── Not connected ─────────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <div className="intent-shell">
        <div className="intent-inner fade-in" style={{ textAlign: 'center', maxWidth: 520 }}>
          <p className="eyebrow" style={{ marginBottom: 16 }}>Treasury Composer</p>
          <h1 className="intent-hello" style={{ fontSize: 'clamp(28px, 4vw, 48px)' }}>
            Connect your <span className="accent">wallet</span> to start
          </h1>
          <p className="intent-sub" style={{ marginTop: 12, marginBottom: 32 }}>
            DeFi Composer reads your on-chain balances, generates strategies, and executes them through your Safe — all without leaving this screen.
          </p>
          <button
            className="btn btn-primary"
            style={{ fontSize: 15, padding: '12px 28px', justifyContent: 'center' }}
            onClick={openConnectModal}
          >
            Connect Wallet
          </button>
          <div style={{ marginTop: 20, fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.5 }}>
            Supports MetaMask, WalletConnect, Coinbase Wallet and more.
            <br />
            Ethereum mainnet · Base · Base Sepolia · contract.dev stagenet
          </div>
        </div>
      </div>
    );
  }

  // ── Connected ─────────────────────────────────────────────────────────────
  const availableCapital = usdcBalance > 0 ? usdcBalance : null;

  return (
    <div className="intent-shell">
      <div className="intent-inner fade-in">
        <p className="eyebrow" style={{ marginBottom: 16 }}>Treasury Composer — {orgName}</p>
        <h1 className="intent-hello">
          What should your<br />
          <span className="accent">idle capital</span> do?
        </h1>
        <p className="intent-sub">
          Describe your goal in plain language. DeFi Composer will build, simulate, and propose the optimal strategy.
        </p>

        {/* Wallet balance strip */}
        <div style={{
          display: 'flex',
          gap: 16,
          padding: '10px 14px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          marginBottom: 16,
          fontSize: 12,
          flexWrap: 'wrap',
        }}>
          <span style={{ color: 'var(--text-faint)' }}>Connected wallet</span>
          <span className="mono" style={{ color: 'var(--text-dim)', fontSize: 11 }}>
            {address?.slice(0, 6)}…{address?.slice(-4)}
          </span>
          <span style={{ color: 'var(--border)' }}>|</span>
          {balLoading ? (
            <span style={{ color: 'var(--text-faint)' }}>Loading balances…</span>
          ) : (
            <>
              <span style={{ color: 'var(--text)' }}>
                <span style={{ color: 'var(--text-faint)' }}>ETH </span>
                <span className="mono">{ethBalance.toFixed(4)} {ethSymbol}</span>
              </span>
              <span style={{ color: 'var(--text)' }}>
                <span style={{ color: 'var(--text-faint)' }}>USDC </span>
                <span className="mono" style={{ color: usdcBalance > 0 ? 'var(--pos)' : 'var(--text-faint)' }}>
                  {usdcBalance > 0 ? fmtUsd(usdcBalance, { compact: true }) : '—'}
                </span>
              </span>
            </>
          )}
        </div>

        <div className="intent-box">
          <textarea
            className="intent-textarea"
            placeholder={
              availableCapital
                ? `e.g. "Generate yield on ${fmtUsd(availableCapital, { compact: true })} idle USDC. Max 40% in any single protocol. Need instant liquidity for governance proposals."`
                : `e.g. "Generate yield on $1M idle USDC. Max 40% in any single protocol. Need instant liquidity for governance proposals."`
            }
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
              {availableCapital
                ? `${fmtUsd(availableCapital, { compact: true })} USDC on-chain · ⌘↵ to submit`
                : '⌘↵ to submit'}
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
              onClick={() => {
                setText(ex.text);
                if (!availableCapital) setCapital(ex.capital);
              }}
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
