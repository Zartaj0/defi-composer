'use client';

/**
 * TreasuryModeModal
 *
 * Shown once after wallet connects (when mode === null).
 * Asks: personal wallet or Safe treasury?
 * For Safe mode: user enters their Safe address.
 * Stores the choice via the configure() callback from useActiveOrg.
 */

import React, { useState } from 'react';
import { useAccount, useChainId } from 'wagmi';

interface Props {
  onConfigure: (mode: 'eoa' | 'safe', safeAddress?: string) => void;
}

export function TreasuryModeModal({ onConfigure }: Props) {
  const { address } = useAccount();
  const chainId = useChainId();
  const [picked, setPicked] = useState<'eoa' | 'safe' | null>(null);
  const [safeInput, setSafeInput] = useState('');
  const [error, setError] = useState('');

  const handleConfirm = () => {
    if (!picked) return;
    if (picked === 'safe') {
      if (!/^0x[0-9a-fA-F]{40}$/.test(safeInput.trim())) {
        setError('Enter a valid 0x Ethereum address');
        return;
      }
      onConfigure('safe', safeInput.trim().toLowerCase());
    } else {
      onConfigure('eoa');
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.7)',
      backdropFilter: 'blur(6px)',
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: 32,
        maxWidth: 520,
        width: '100%',
      }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 8 }}>
          Wallet connected
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', margin: '0 0 6px' }}>
          What are you managing?
        </h2>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 24, fontFamily: 'var(--font-mono)' }}>
          {address?.slice(0, 6)}…{address?.slice(-4)} · Chain {chainId}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
          {/* EOA option */}
          <button
            onClick={() => setPicked('eoa')}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 14,
              padding: '16px 18px',
              background: picked === 'eoa' ? 'var(--accent-soft)' : 'var(--bg)',
              border: `1px solid ${picked === 'eoa' ? 'var(--accent-line)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'border-color 0.15s',
            }}
          >
            <div style={{ fontSize: 22, lineHeight: 1, flexShrink: 0, marginTop: 2 }}>👤</div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)', marginBottom: 4 }}>
                Personal wallet (EOA)
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Your MetaMask/wallet holds the funds directly. Strategies sign and execute from this address. Best for individual traders or testing.
              </div>
            </div>
          </button>

          {/* Safe option */}
          <button
            onClick={() => setPicked('safe')}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 14,
              padding: '16px 18px',
              background: picked === 'safe' ? 'var(--accent-soft)' : 'var(--bg)',
              border: `1px solid ${picked === 'safe' ? 'var(--accent-line)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              textAlign: 'left',
              transition: 'border-color 0.15s',
            }}
          >
            <div style={{ fontSize: 22, lineHeight: 1, flexShrink: 0, marginTop: 2 }}>🏛️</div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)', marginBottom: 4 }}>
                Safe treasury (multisig)
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Your wallet is an owner/operator of a Gnosis Safe. The Safe holds the treasury funds. Strategies execute via the Safe + PolicyEnforcedModule. Best for DAOs and companies.
              </div>
            </div>
          </button>
        </div>

        {/* Safe address input */}
        {picked === 'safe' && (
          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 12, color: 'var(--text-dim)', display: 'block', marginBottom: 6 }}>
              Safe address
            </label>
            <input
              type="text"
              placeholder="0x..."
              value={safeInput}
              onChange={e => { setSafeInput(e.target.value); setError(''); }}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: 'var(--bg)',
                border: `1px solid ${error ? 'var(--neg)' : 'var(--border)'}`,
                borderRadius: 'var(--radius-md)',
                color: 'var(--text)',
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                outline: 'none',
              }}
              autoFocus
            />
            {error && <div style={{ fontSize: 11, color: 'var(--neg)', marginTop: 4 }}>{error}</div>}
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 6 }}>
              On the contract.dev stagenet, run{' '}
              <code style={{ background: 'var(--surface)', padding: '1px 4px', borderRadius: 3, fontFamily: 'var(--font-mono)' }}>
                bash scripts/setup-stagenet.sh YOUR_ADDRESS
              </code>
              {' '}to get the Gitcoin Safe pre-configured:{' '}
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontSize: 11 }}>
                0xde21F729137C5Af1b01d73aF1dC21eFfa2B8a0d6
              </span>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={!picked || (picked === 'safe' && !safeInput.trim())}
          >
            {picked === 'safe' ? 'Use this Safe →' : picked === 'eoa' ? 'Use my wallet →' : 'Select an option'}
          </button>
        </div>
      </div>
    </div>
  );
}
