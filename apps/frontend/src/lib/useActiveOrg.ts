'use client';

/**
 * useActiveOrg — wallet-first org management
 *
 * The "org" concept in DeFi Composer maps to a treasury entity in the backend.
 * Rather than hardcoding orgs, we derive them from the connected wallet:
 *
 *   - walletAddress is always the signer/operator
 *   - safeAddress (optional) is the actual treasury Safe — if set, all
 *     on-chain reads and strategy execution target the Safe instead of the EOA
 *   - The backend org is looked up or created lazily on first use
 *
 * Mode is persisted in localStorage keyed by `${chainId}:${walletAddress}`.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAccount, useChainId } from 'wagmi';
import { type Org } from '@/lib/data';

const API_BASE = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

export type TreasuryMode = 'eoa' | 'safe' | null;  // null = not yet chosen

export interface ActiveOrg extends Org {
  safeAddress?: string;
  walletAddress?: string;
  mode: TreasuryMode;
  isLoading: boolean;
  isFallback: boolean;  // true when using the default Sepolia org, not wallet-derived
}

const FALLBACK_ORG: Org = {
  id: 'org_88e49a1b-976',
  name: 'Sepolia Test Treasury',
  kind: 'Company',
  handle: '88e49a1b',
  avatar: { bg: '#6B8AFF', letter: 'S' },
  treasuryUsd: 0,
  managedUsd: 0,
  idleUsd: 0,
  governanceThreshold: 'Safe 2-of-3',
  riskCeiling: 10,
  maxAllocPerProtocol: 100,
  benchmarkApy: 0,
  currentApy: 3.18,
};

function storageKey(chainId: number, address: string) {
  return `defi-composer:org:${chainId}:${address.toLowerCase()}`;
}

interface StoredOrgData {
  orgId: string;
  mode: TreasuryMode;
  safeAddress?: string;
}

function loadStored(chainId: number, address: string): StoredOrgData | null {
  try {
    const raw = localStorage.getItem(storageKey(chainId, address));
    return raw ? (JSON.parse(raw) as StoredOrgData) : null;
  } catch {
    return null;
  }
}

function saveStored(chainId: number, address: string, data: StoredOrgData) {
  try {
    localStorage.setItem(storageKey(chainId, address), JSON.stringify(data));
  } catch {}
}

function deriveOrgId(address: string) {
  return `org_${address.slice(2, 10).toLowerCase()}`;
}

function chainLabel(chainId: number): string {
  const labels: Record<number, string> = {
    1: 'Ethereum',
    8453: 'Base',
    84532: 'Base Sepolia',
    52638: 'contract.dev',
  };
  return labels[chainId] ?? `Chain ${chainId}`;
}

function buildOrgFromWallet(
  address: string,
  chainId: number,
  mode: TreasuryMode,
  safeAddress?: string,
  orgId?: string,
): Org {
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
  const name = mode === 'safe' && safeAddress
    ? `Safe ${safeAddress.slice(0, 6)}…${safeAddress.slice(-4)}`
    : `Wallet ${short}`;

  return {
    id: orgId ?? deriveOrgId(address),
    name: `${name} · ${chainLabel(chainId)}`,
    kind: mode === 'safe' ? 'Company' : 'Wallet',
    handle: address.slice(2, 10),
    avatar: { bg: '#6B8AFF', letter: address[2]?.toUpperCase() ?? 'W' },
    treasuryUsd: 0,
    managedUsd: 0,
    idleUsd: 0,
    governanceThreshold: mode === 'safe' ? 'Safe' : 'EOA',
    riskCeiling: 10,
    maxAllocPerProtocol: 50,
    benchmarkApy: 0,
    currentApy: 0,
  };
}

async function ensureBackendOrg(
  address: string,
  chainId: number,
  mode: TreasuryMode,
  safeAddress?: string,
): Promise<string> {
  const orgId = deriveOrgId(address);

  // Try GET first — if it exists, return it
  try {
    const res = await fetch(`${API_BASE}/api/v1/treasury/${orgId}/snapshot`);
    if (res.ok) return orgId;
  } catch {}

  // Create it
  try {
    const chain = chainLabel(chainId);
    const short = `${address.slice(0, 6)}…${address.slice(-4)}`;
    const name = mode === 'safe' && safeAddress
      ? `Safe ${safeAddress.slice(0, 6)}…${safeAddress.slice(-4)} · ${chain}`
      : `Wallet ${short} · ${chain}`;

    await fetch(`${API_BASE}/api/v1/treasury/orgs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: orgId,
        name,
        type: mode === 'safe' ? 'dao' : 'individual',
        walletAddress: address,
        safeAddress: safeAddress ?? null,
        riskProfile: 'moderate',
      }),
    });
  } catch {}

  return orgId;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useActiveOrg() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();

  const [org, setOrg] = useState<ActiveOrg>({
    ...FALLBACK_ORG,
    mode: null,
    isLoading: false,
    isFallback: true,
  });

  // Called by TreasuryModeModal once user picks a mode
  const configure = useCallback(async (mode: 'eoa' | 'safe', safeAddress?: string) => {
    if (!address) return;

    setOrg(prev => ({ ...prev, isLoading: true }));

    const orgId = await ensureBackendOrg(address, chainId, mode, safeAddress);
    const base = buildOrgFromWallet(address, chainId, mode, safeAddress, orgId);

    const data: StoredOrgData = { orgId, mode, safeAddress };
    saveStored(chainId, address, data);

    setOrg({
      ...base,
      safeAddress,
      walletAddress: address,
      mode,
      isLoading: false,
      isFallback: false,
    });
  }, [address, chainId]);

  // On wallet connect / chain change → restore from localStorage or set fallback
  useEffect(() => {
    if (!isConnected || !address) {
      setOrg({ ...FALLBACK_ORG, mode: null, isLoading: false, isFallback: true });
      return;
    }

    const stored = loadStored(chainId, address);
    if (stored) {
      const base = buildOrgFromWallet(address, chainId, stored.mode, stored.safeAddress, stored.orgId);
      setOrg({
        ...base,
        safeAddress: stored.safeAddress,
        walletAddress: address,
        mode: stored.mode,
        isLoading: false,
        isFallback: false,
      });
      // Re-ensure the org exists on the backend (silently — handles env changes / new deployments)
      void ensureBackendOrg(address, chainId, stored.mode, stored.safeAddress);
    } else {
      // No config yet → show "not yet chosen" state so modal can appear
      setOrg({
        ...buildOrgFromWallet(address, chainId, null),
        walletAddress: address,
        mode: null,
        isLoading: false,
        isFallback: false,
      });
    }
  }, [address, chainId, isConnected]);

  return { org, configure };
}
