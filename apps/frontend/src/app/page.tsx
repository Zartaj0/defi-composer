'use client';

import React, { useState, useEffect } from 'react';
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
import { TweaksPanel, type Tweaks } from '@/components/TweaksPanel';
import { TreasuryModeModal } from '@/components/TreasuryModeModal';
import { useActiveOrg } from '@/lib/useActiveOrg';
import { type Org, type Strategy } from '@/lib/data';

type View = 'intent' | 'generating' | 'strategies' | 'detail' | 'dashboard' | 'marketplace' | 'reports' | 'mandates';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export default function HomePage() {
  const { address: walletAddress, isConnected } = useAccount();
  const { org: activeOrg, configure } = useActiveOrg();

  const [view, setView] = useState<View>('intent');
  const [intentText, setIntentText] = useState('');
  const [capitalUsd, setCapitalUsd] = useState(1_000_000);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [selectedStrategy, setSelectedStrategy] = useState<Strategy | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);
  const [intentId, setIntentId] = useState<string | undefined>(undefined);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [tweaksOpen, setTweaksOpen] = useState(false);

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

  const handleIntentSubmit = async (text: string, capital: number) => {
    setIntentText(text);
    setCapitalUsd(capital);
    setGenerationError(null);

    try {
      if (!walletAddress) {
        throw new Error('Connect a wallet before creating an executable strategy.');
      }

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

  const handleGeneratingDone = (strats: Strategy[]) => {
    setStrategies(strats);
    setView('strategies');
  };

  const handleSelectStrategy = (strategy: Strategy) => {
    setSelectedStrategy(strategy);
    setView('detail');
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

  // Show mode selector when wallet is connected but user hasn't chosen EOA vs Safe yet
  const showModeModal = isConnected && !activeOrg.isFallback && activeOrg.mode === null;

  return (
    <div className="app">
      <TopNav
        view={view}
        onNav={handleNav}
        activeOrg={activeOrg}
        onOrgChange={() => {/* controlled by useActiveOrg */}}
        onOpenTweaks={() => setTweaksOpen(v => !v)}
        onReconfigure={() => {
          // Clear stored config so TreasuryModeModal re-appears
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
        {view === 'intent' && (
          <IntentScreen
            orgName={activeOrg.name}
            onSubmit={handleIntentSubmit}
          />
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
            onDone={handleGeneratingDone}
          />
        )}

        {view === 'strategies' && (
          <StrategyGrid
            strategies={strategies}
            capitalUsd={capitalUsd}
            onSelect={handleSelectStrategy}
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

        {view === 'mandates' && (
          <MandateDashboard orgId={activeOrg.id} />
        )}

        {view === 'marketplace' && (
          <MarketplacePlaceholder onCompose={() => setView('intent')} />
        )}

        {view === 'reports' && (
          <ReportsPlaceholder org={activeOrg} />
        )}
      </main>

      {/* Mode selector — appears once after wallet connects */}
      {showModeModal && (
        <TreasuryModeModal onConfigure={configure} />
      )}

      {deployOpen && selectedStrategy && (
        <DeployModal
          strategy={selectedStrategy}
          capitalUsd={capitalUsd}
          org={activeOrg}
          intentId={intentId}
          walletAddress={walletAddress}
          safeAddress={activeOrg.safeAddress}
          onClose={() => {
            setDeployOpen(false);
            setView('dashboard');
          }}
        />
      )}

      {tweaksOpen && (
        <TweaksPanel
          tweaks={tweaks}
          onChange={setTweaks}
          onClose={() => setTweaksOpen(false)}
        />
      )}
    </div>
  );
}

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
          { name: 'Block Analitica', desc: 'Risk-adjusted multi-protocol allocation models', apy: '7.2–11.4%', tvl: '$89M', tag: 'Audited' },
          { name: 'Chaos Labs', desc: 'Quantitative parameter optimization for Aave and Morpho', apy: '6.8–8.9%', tvl: '$55M', tag: 'New' },
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
          { name: 'Q1 2026 Treasury Report', date: 'Mar 31, 2026', size: '142 KB', type: 'PDF' },
          { name: 'Q4 2025 Treasury Report', date: 'Dec 31, 2025', size: '138 KB', type: 'PDF' },
          { name: 'Fee Accrual Statement — April 2026', date: 'Apr 30, 2026', size: '24 KB', type: 'CSV' },
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
