'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useAccount } from 'wagmi';
import { TopNav } from '@/components/TopNav';
import { ForkModeBanner } from '@/components/ForkModeBanner';
import { MonitorTicker } from '@/components/MonitorTicker';
import { IntentScreen } from '@/components/IntentScreen';
import { GeneratingScreen } from '@/components/GeneratingScreen';
import { StrategyGrid } from '@/components/StrategyGrid';
import { StrategyDetail } from '@/components/StrategyDetail';
import { DeployModal } from '@/components/DeployModal';
import { TreasuryDashboard } from '@/components/TreasuryDashboard';
import { MandateDashboard } from '@/components/MandateDashboard';
import { MandateSetupModal } from '@/components/MandateSetupModal';
import { TweaksPanel, type Tweaks } from '@/components/TweaksPanel';
import { TreasuryModeModal } from '@/components/TreasuryModeModal';
import { useActiveOrg } from '@/lib/useActiveOrg';
import { type Org, type Strategy } from '@/lib/data';

type View = 'home' | 'mandates' | 'intent' | 'generating' | 'strategies' | 'detail' | 'dashboard' | 'marketplace' | 'reports';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export default function HomePage() {
  const { address: walletAddress, isConnected } = useAccount();
  const { org: activeOrg, configure } = useActiveOrg();

  // Default view: 'home' when not connected, auto-routes when connected
  const [view, setView] = useState<View>('home');
  const [intentText, setIntentText] = useState('');
  const [capitalUsd, setCapitalUsd] = useState(1_000_000);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [selectedStrategy, setSelectedStrategy] = useState<Strategy | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);
  const [intentId, setIntentId] = useState<string | undefined>(undefined);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [setupMandateOpen, setSetupMandateOpen] = useState(false);
  const [activeMandateId, setActiveMandateId] = useState<string | null>(null);
  const [checkingMandate, setCheckingMandate] = useState(false);

  const [tweaks, setTweaks] = useState<Tweaks>({
    aesthetic: 'onchain',
    theme: 'dark',
    density: 'cozy',
    accent: '#6B8AFF',
    showMonitorTicker: true,
  });

  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute('data-aesthetic', tweaks.aesthetic);
    el.setAttribute('data-theme', tweaks.theme);
    if (tweaks.density === 'cozy') {
      el.removeAttribute('data-density');
    } else {
      el.setAttribute('data-density', tweaks.density);
    }
    el.style.setProperty('--accent', tweaks.accent);
    const hex = tweaks.accent;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    el.style.setProperty('--accent-soft', `rgba(${r},${g},${b},0.14)`);
    el.style.setProperty('--accent-line', `rgba(${r},${g},${b},0.32)`);
  }, [tweaks]);

  // When wallet connects and org is ready, check for an active mandate
  const checkForActiveMandate = useCallback(async (orgId: string) => {
    if (checkingMandate) return;
    setCheckingMandate(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/mandates/org/${orgId}`);
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      const mandates: Array<{ id: string; status: string }> = data?.data ?? [];
      const active = mandates.find(m => m.status === 'active');
      if (active) {
        setActiveMandateId(active.id);
        // Only auto-route on fresh connect (not if user explicitly navigated elsewhere)
        setView(v => v === 'home' ? 'mandates' : v);
      } else {
        // No active mandate — show mandates view so user can create one
        setView(v => v === 'home' ? 'mandates' : v);
      }
    } catch { /* non-fatal */ }
    finally { setCheckingMandate(false); }
  }, [checkingMandate]);

  useEffect(() => {
    if (isConnected && walletAddress && !activeOrg.isFallback && activeOrg.mode !== null) {
      void checkForActiveMandate(activeOrg.id);
    }
  }, [isConnected, walletAddress, activeOrg.id, activeOrg.isFallback, activeOrg.mode]);

  const handleIntentSubmit = async (text: string, capital: number) => {
    setIntentText(text);
    setCapitalUsd(capital);
    setGenerationError(null);

    try {
      if (!walletAddress) throw new Error('Connect a wallet before creating an executable strategy.');

      const res = await fetch(`${API_BASE}/api/v1/intent/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawInput: text,
          capitalUsd: capital,
          walletAddress,
          orgId: activeOrg.id,
          safeAddress: activeOrg.safeAddress ?? null,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const id = data.data?.intentId ?? data.intentId;
        if (id) {
          setIntentId(id);
          setView('generating');
          return;
        }
      }
      const data = await res.json().catch(() => null);
      throw new Error(data?.error ?? `Backend rejected intent parsing with ${res.status}`);
    } catch (err) {
      setIntentId(undefined);
      setGenerationError(err instanceof Error ? err.message : 'Strategy generation failed.');
    }
  };

  const handleNav = (v: View) => {
    setView(v);
    if (v === 'intent') {
      setStrategies([]);
      setSelectedStrategy(null);
      setIntentId(undefined);
      setGenerationError(null);
    }
  };

  const showModeModal = isConnected && !activeOrg.isFallback && activeOrg.mode === null;

  return (
    <div className="app">
      <TopNav
        view={view}
        onNav={handleNav}
        activeOrg={activeOrg}
        onOrgChange={() => {}}
        onOpenTweaks={() => setTweaksOpen(v => !v)}
        onReconfigure={() => {
          if (walletAddress) {
            try {
              const chainId = (window as unknown as { ethereum?: { chainId?: string } }).ethereum?.chainId;
              const cid = chainId ? parseInt(chainId, 16) : 1;
              localStorage.removeItem(`defi-composer:org:${cid}:${walletAddress.toLowerCase()}`);
            } catch {}
          }
          window.location.reload();
        }}
      />
      <ForkModeBanner />
      {tweaks.showMonitorTicker && <MonitorTicker />}

      <main>

        {/* ── Home / Landing ─────────────────────────────────────── */}
        {view === 'home' && (
          <HomeScreen
            isConnected={isConnected}
            onGoToMandates={() => setView('mandates')}
            onManualMode={() => setView('intent')}
          />
        )}

        {/* ── Mandates (primary product surface) ───────────────── */}
        {view === 'mandates' && (
          <div className="page fade-in">
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 28, flexWrap: 'wrap', gap: 12 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 6 }}>
                  Autonomous Agent
                </div>
                <h2 style={{ fontSize: 'clamp(20px, 2.2vw, 28px)', fontWeight: 700, color: 'var(--text)', margin: 0 }}>
                  Treasury Mandates
                </h2>
                <p style={{ marginTop: 6, fontSize: 13, color: 'var(--text-dim)', maxWidth: 540 }}>
                  Set policy bounds once. The agent monitors balances 24/7, fork-proves every action, and executes autonomously within your limits.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => handleNav('intent')}
                  style={{ fontSize: 12 }}
                >
                  Manual Mode →
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => setSetupMandateOpen(true)}
                  disabled={!isConnected}
                  title={!isConnected ? 'Connect wallet to create a mandate' : undefined}
                >
                  + New Mandate
                </button>
              </div>
            </div>

            {!isConnected && (
              <div style={{ padding: '32px 24px', background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', textAlign: 'center', marginBottom: 24 }}>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>Connect your wallet to get started</div>
                <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                  Connect a wallet to create a mandate and let the autonomous agent manage your treasury.
                </div>
              </div>
            )}

            {isConnected && (
              <MandateDashboard
                orgId={activeOrg.id}
                onSetupMandate={() => setSetupMandateOpen(true)}
                activeMandateId={activeMandateId}
              />
            )}
          </div>
        )}

        {/* ── Manual DeFi Compose flow ──────────────────────────── */}
        {view === 'intent' && (
          <>
            <div style={{ maxWidth: 720, margin: '0 auto 16px', padding: '10px 14px', background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                Manual Mode — you sign every transaction. For autonomous 24/7 management,{' '}
                <button className="btn btn-ghost btn-sm" style={{ fontSize: 12, padding: '2px 8px' }} onClick={() => setView('mandates')}>
                  use a mandate →
                </button>
              </span>
            </div>
            <IntentScreen orgName={activeOrg.name} onSubmit={handleIntentSubmit} />
          </>
        )}

        {view === 'intent' && generationError && (
          <div style={{ maxWidth: 720, margin: '16px auto 0', padding: '12px 14px', border: '1px solid rgba(255,90,90,0.22)', borderRadius: 'var(--radius-md)', color: 'var(--neg)', background: 'rgba(255,90,90,0.08)', fontSize: 13 }}>
            {generationError}
          </div>
        )}

        {view === 'generating' && (
          <GeneratingScreen
            intentText={intentText}
            capitalUsd={capitalUsd}
            orgId={activeOrg.id}
            intentId={intentId}
            onDone={strats => { setStrategies(strats); setView('strategies'); }}
          />
        )}

        {view === 'strategies' && (
          <StrategyGrid
            strategies={strategies}
            capitalUsd={capitalUsd}
            onSelect={s => { setSelectedStrategy(s); setView('detail'); }}
            onBack={() => setView('intent')}
          />
        )}

        {view === 'detail' && selectedStrategy && (
          <StrategyDetail
            strategy={selectedStrategy}
            capitalUsd={capitalUsd}
            onDeploy={() => setDeployOpen(true)}
            onBack={() => setView('strategies')}
          />
        )}

        {view === 'dashboard' && (
          <TreasuryDashboard
            org={activeOrg}
            safeAddress={activeOrg.safeAddress}
            onCompose={() => setView('intent')}
          />
        )}

        {view === 'marketplace' && (
          <MarketplacePlaceholder onCompose={() => setView('intent')} />
        )}

        {view === 'reports' && (
          <ReportsPlaceholder org={activeOrg} />
        )}

      </main>

      {showModeModal && <TreasuryModeModal onConfigure={configure} />}

      {deployOpen && selectedStrategy && (
        <DeployModal
          strategy={selectedStrategy}
          capitalUsd={capitalUsd}
          org={activeOrg}
          intentId={intentId}
          walletAddress={walletAddress}
          safeAddress={activeOrg.safeAddress}
          onClose={() => { setDeployOpen(false); setView('dashboard'); }}
        />
      )}

      {setupMandateOpen && (
        <MandateSetupModal
          orgId={activeOrg.id}
          orgName={activeOrg.name}
          onCreated={mandateId => {
            setActiveMandateId(mandateId);
            setSetupMandateOpen(false);
            // Redirect to the mandate detail page
            window.location.href = `/mandate/${mandateId}`;
          }}
          onClose={() => setSetupMandateOpen(false)}
        />
      )}

      {tweaksOpen && (
        <TweaksPanel tweaks={tweaks} onChange={setTweaks} onClose={() => setTweaksOpen(false)} />
      )}
    </div>
  );
}

// ── Landing / Home screen ─────────────────────────────────────

function HomeScreen({ isConnected, onGoToMandates, onManualMode }: {
  isConnected: boolean;
  onGoToMandates: () => void;
  onManualMode: () => void;
}) {
  return (
    <div className="page fade-in" style={{ maxWidth: 680, margin: '0 auto', paddingTop: 48 }}>
      <div style={{ marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent)', padding: '3px 10px', background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', borderRadius: 100 }}>
          Autonomous Treasury OS
        </span>
      </div>

      <h1 style={{ fontSize: 'clamp(28px, 4vw, 48px)', fontWeight: 700, lineHeight: 1.15, marginBottom: 16, marginTop: 16 }}>
        Your treasury agent.<br />
        <span style={{ color: 'var(--accent)' }}>Set once. Runs forever.</span>
      </h1>

      <p style={{ fontSize: 15, color: 'var(--text-dim)', lineHeight: 1.7, marginBottom: 32, maxWidth: 520 }}>
        Define your risk bounds and liquidity rules once. The agent monitors your Safe 24/7,
        detects idle capital, fork-proves every action, then executes autonomously within your policy —
        no daily intervention required.
      </p>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 48 }}>
        <button
          className="btn btn-primary"
          style={{ fontSize: 14, padding: '12px 24px' }}
          onClick={onGoToMandates}
        >
          {isConnected ? 'Go to Mandates →' : 'Connect & Create Mandate →'}
        </button>
        <button
          className="btn btn-ghost"
          style={{ fontSize: 13, padding: '12px 20px', color: 'var(--text-dim)' }}
          onClick={onManualMode}
        >
          Manual Mode (one-time strategy)
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
        {[
          { title: 'Mandate-Bounded', desc: 'Reserve floor, max action size, allowed protocols — all enforced on-chain.' },
          { title: 'Fork-Proven', desc: 'Every action simulated on an Anvil fork at current block before execution.' },
          { title: '24/7 Autonomous', desc: 'Agent scans every 5 minutes. No manual approvals needed after setup.' },
        ].map(f => (
          <div key={f.title} style={{ padding: 16, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{f.title}</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>{f.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Placeholder pages ─────────────────────────────────────────

function MarketplacePlaceholder({ onCompose }: { onCompose: () => void }) {
  return (
    <div className="page fade-in">
      <div className="eyebrow" style={{ marginBottom: 8 }}>Strategy Marketplace</div>
      <h2 className="h2">Curator Strategies</h2>
      <div className="muted" style={{ marginTop: 6, marginBottom: 32, fontSize: 13 }}>
        Community-curated strategies with on-chain reputation scores. Coming soon.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
        {[
          { name: 'Steakhouse Financial', desc: 'Conservative USDC yield strategies', apy: '8.4–9.1%', tvl: '$142M', tag: 'Verified' },
          { name: 'Block Analitica',      desc: 'Risk-adjusted multi-protocol allocation models', apy: '7.2–11.4%', tvl: '$89M',  tag: 'Audited' },
          { name: 'Chaos Labs',           desc: 'Quantitative parameter optimization for Aave and Morpho', apy: '6.8–8.9%', tvl: '$55M',  tag: 'New' },
        ].map(c => (
          <div key={c.name} className="card card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ fontWeight: 500 }}>{c.name}</div>
              <span className="tag accent">{c.tag}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.4 }}>{c.desc}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <div className="eyebrow" style={{ marginBottom: 3 }}>APY Range</div>
                <div className="mono" style={{ color: 'var(--pos)', fontSize: 14 }}>{c.apy}</div>
              </div>
              <div>
                <div className="eyebrow" style={{ marginBottom: 3 }}>Total TVL</div>
                <div className="mono" style={{ fontSize: 14 }}>{c.tvl}</div>
              </div>
            </div>
            <button className="btn btn-primary" style={{ justifyContent: 'center' }} onClick={onCompose}>Use Strategy</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportsPlaceholder({ org }: { org: Org }) {
  return (
    <div className="page fade-in">
      <div className="eyebrow" style={{ marginBottom: 8 }}>Reports</div>
      <h2 className="h2">Performance Reports</h2>
      <div className="muted" style={{ marginTop: 6, marginBottom: 32, fontSize: 13 }}>
        Audit-ready performance reports for {org.name}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[
          { name: 'Q1 2026 Treasury Report',            date: 'Mar 31, 2026', size: '142 KB', type: 'PDF' },
          { name: 'Q4 2025 Treasury Report',            date: 'Dec 31, 2025', size: '138 KB', type: 'PDF' },
          { name: 'Fee Accrual Statement — April 2026', date: 'Apr 30, 2026', size: '24 KB',  type: 'CSV' },
        ].map(r => (
          <div key={r.name} className="card card-pad" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500, marginBottom: 3 }}>{r.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
                {r.date} · {r.size}
              </div>
            </div>
            <span className="tag">{r.type}</span>
            <button className="btn btn-sm">Download</button>
          </div>
        ))}
      </div>
    </div>
  );
}
