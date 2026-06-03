'use client';

import React, { useState, useRef, useEffect } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { IconLogo, IconChev, IconSafe } from '@/lib/icons';
import { type ActiveOrg } from '@/lib/useActiveOrg';
import { type Org } from '@/lib/data';

type View = 'home' | 'mandates' | 'intent' | 'generating' | 'strategies' | 'detail' | 'dashboard' | 'marketplace' | 'reports';

interface TopNavProps {
  view: View;
  onNav: (v: View) => void;
  activeOrg: Org | ActiveOrg;
  onOrgChange: (org: Org) => void;
  onOpenTweaks: () => void;
  onReconfigure?: () => void;
}

export function TopNav({ view, onNav, activeOrg, onOrgChange, onOpenTweaks, onReconfigure }: TopNavProps) {
  const [orgOpen, setOrgOpen] = useState(false);
  const orgRef = useRef<HTMLDivElement>(null);
  const isActiveOrg = 'mode' in activeOrg;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (orgRef.current && !orgRef.current.contains(e.target as Node)) {
        setOrgOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const navItems: { label: string; key: View; accent?: boolean }[] = [
    { label: 'Mandates', key: 'mandates', accent: true },
    { label: 'Dashboard', key: 'dashboard' },
    { label: 'Manual', key: 'intent' },
    { label: 'Reports', key: 'reports' },
  ];

  return (
    <nav className="topnav">
      <div className="brand">
        <IconLogo size={20} />
        DeFi Composer
        <span className="tag" style={{ marginLeft: 2 }}>beta</span>
      </div>

      {/* Treasury context pill */}
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
          <div className="name" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {activeOrg.name}
          </div>
          <div className="kind">
            {isActiveOrg && (activeOrg as import('@/lib/useActiveOrg').ActiveOrg).mode === 'safe'
              ? 'Safe treasury'
              : isActiveOrg && (activeOrg as import('@/lib/useActiveOrg').ActiveOrg).mode === 'eoa'
              ? 'Personal wallet'
              : activeOrg.kind}
          </div>
        </div>
        <div className="chev">
          <IconChev size={12} />
        </div>

        {orgOpen && (
          <div className="menu">
            <div style={{ padding: '8px 12px 4px', fontSize: 11, color: 'var(--text-faint)', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
              Treasury context
            </div>
            <div className="item active">
              <div className="avatar" style={{ background: activeOrg.avatar.bg, width: 24, height: 24, borderRadius: 4, display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 600, fontFamily: 'var(--font-mono)', color: '#0A0B0D', flexShrink: 0 }}>
                {activeOrg.avatar.letter}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeOrg.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{activeOrg.id}</div>
              </div>
            </div>
            <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0', paddingTop: 4 }}>
              {onReconfigure && (
                <div
                  className="item"
                  onClick={(e) => { e.stopPropagation(); setOrgOpen(false); onReconfigure(); }}
                >
                  <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>⚙ Switch mode / Safe address</span>
                </div>
              )}
              <div
                className="item"
                onClick={(e) => { e.stopPropagation(); window.location.href = '/onboarding'; }}
              >
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>+ New organization</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Nav Links */}
      <div className="navlinks">
        {navItems.map(item => {
          const isActive =
            view === item.key ||
            (item.key === 'intent' && (view === 'generating' || view === 'strategies' || view === 'detail')) ||
            (item.key === 'mandates' && view === 'home');
          return (
            <button
              key={item.key}
              className={isActive ? 'active' : ''}
              onClick={() => onNav(item.key)}
              style={item.accent && isActive ? { color: 'var(--accent)' } : undefined}
            >
              {item.label}
              {item.accent && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--accent)', display: 'inline-block', marginLeft: 4, verticalAlign: 'middle', opacity: 0.8 }} />}
            </button>
          );
        })}
      </div>

      <div className="spacer" />

      {/* Settings button */}
      <button className="btn btn-sm btn-ghost" onClick={onOpenTweaks} title="Appearance & settings">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.6 2.6l1.1 1.1M10.3 10.3l1.1 1.1M2.6 11.4l1.1-1.1M10.3 3.7l1.1-1.1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>

      {/* Wallet */}
      <ConnectButton.Custom>
        {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
          const ready = mounted;
          const connected = ready && account && chain;
          return (
            <div
              {...(!ready && {
                'aria-hidden': true,
                style: { opacity: 0, pointerEvents: 'none', userSelect: 'none' },
              })}
            >
              {!connected ? (
                <button className="btn btn-primary btn-sm" onClick={openConnectModal} type="button">
                  Connect Wallet
                </button>
              ) : chain.unsupported ? (
                <button className="btn btn-sm" style={{ background: 'var(--neg)', color: '#fff', border: 'none' }} onClick={openChainModal} type="button">
                  Wrong network
                </button>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={openChainModal}
                    style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 8px' }}
                    type="button"
                  >
                    {chain.hasIcon && chain.iconUrl && (
                      <img src={chain.iconUrl} alt={chain.name ?? 'chain'} style={{ width: 12, height: 12, borderRadius: '50%' }} />
                    )}
                    {chain.name}
                  </button>
                  <button
                    className="walletpill"
                    onClick={openAccountModal}
                    type="button"
                    style={{ cursor: 'pointer', border: 'none', background: 'none', padding: 0 }}
                  >
                    <span className="dot" />
                    <IconSafe size={13} />
                    <span className="mono" style={{ fontSize: 12 }}>{account.displayName}</span>
                  </button>
                </div>
              )}
            </div>
          );
        }}
      </ConnectButton.Custom>
    </nav>
  );
}
