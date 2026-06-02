'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { IconLogo, IconChev, IconCheck, IconSafe } from '@/lib/icons';
import { shortAddr } from '@/lib/utils';
import { ORGS, type Org } from '@/lib/data';

type View = 'intent' | 'generating' | 'strategies' | 'detail' | 'dashboard' | 'marketplace' | 'reports' | 'mandates';

interface TopNavProps {
  view: View;
  onNav: (v: View) => void;
  activeOrg: Org;
  onOrgChange: (org: Org) => void;
  onOpenTweaks: () => void;
}

export function TopNav({ view, onNav, activeOrg, onOrgChange, onOpenTweaks }: TopNavProps) {
  const [orgOpen, setOrgOpen] = useState(false);
  const orgRef = useRef<HTMLDivElement>(null);
  const { address, isConnected } = useAccount();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (orgRef.current && !orgRef.current.contains(e.target as Node)) {
        setOrgOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const navItems: { label: string; key: View }[] = [
    { label: 'Compose', key: 'intent' },
    { label: 'Dashboard', key: 'dashboard' },
    { label: 'Mandates', key: 'mandates' },
    { label: 'Reports', key: 'reports' },
    { label: 'Marketplace', key: 'marketplace' },
  ];

  return (
    <nav className="topnav">
      <div className="brand">
        <IconLogo size={20} />
        DeFi Composer
        <span className="tag" style={{ marginLeft: 2 }}>beta</span>
      </div>

      {/* Org Switcher */}
      <div
        className="orgswitch"
        ref={orgRef}
        onClick={() => setOrgOpen(v => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setOrgOpen(v => !v)}
      >
        <div className="avatar" style={{ background: activeOrg.avatar.bg }}>
          {activeOrg.avatar.letter}
        </div>
        <div className="meta">
          <div className="name">{activeOrg.name}</div>
          <div className="kind">{activeOrg.kind}</div>
        </div>
        <div className="chev">
          <IconChev size={12} />
        </div>

        {orgOpen && (
          <div className="menu">
            {ORGS.map(org => (
              <div
                key={org.id}
                className={`item ${org.id === activeOrg.id ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); onOrgChange(org); setOrgOpen(false); }}
              >
                <div className="avatar" style={{ background: org.avatar.bg, width: 24, height: 24, borderRadius: 4, display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 600, fontFamily: 'var(--font-mono)', color: '#0A0B0D', flexShrink: 0 }}>
                  {org.avatar.letter}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: 12 }}>{org.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                    ${(org.treasuryUsd / 1_000_000).toFixed(1)}M treasury · {org.kind}
                  </div>
                </div>
                {org.id === activeOrg.id && (
                  <span style={{ color: 'var(--accent)' }}><IconCheck size={12} /></span>
                )}
              </div>
            ))}
              <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0', paddingTop: 4 }}>
              <div
                className="item"
                onClick={(e) => {
                  e.stopPropagation();
                  window.location.href = "/onboarding";
                }}
              >
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>+ Add organization</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Nav Links */}
      <div className="navlinks">
        {navItems.map(item => (
          <button
            key={item.key}
            className={view === item.key || (view === 'generating' && item.key === 'intent') || (view === 'strategies' && item.key === 'intent') || (view === 'detail' && item.key === 'intent') ? 'active' : ''}
            onClick={() => onNav(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="spacer" />

      {/* Settings button */}
      <button className="btn btn-sm btn-ghost" onClick={onOpenTweaks} title="Appearance & settings">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.6 2.6l1.1 1.1M10.3 10.3l1.1 1.1M2.6 11.4l1.1-1.1M10.3 3.7l1.1-1.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>

      {/* Wallet — shows connected address if available, no-op otherwise */}
      {isConnected && address ? (
        <div className="walletpill">
          <span className="dot" />
          <IconSafe size={13} />
          <span className="mono" style={{ fontSize: 12 }}>{shortAddr(address)}</span>
        </div>
      ) : null}
    </nav>
  );
}
