'use client';

import React, { useState, useCallback } from 'react';
import { useAccount, useSignTypedData, useChainId } from 'wagmi';
import { IconX, IconCheck, IconShield, IconArrowRight, IconBolt } from '@/lib/icons';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const EIP712_TYPES = {
  MandateActivation: [
    { name: 'mandateId',        type: 'string'  },
    { name: 'mandateVersionId', type: 'string'  },
    { name: 'reserveFloorUsd',  type: 'uint256' },
    { name: 'riskBudgetPct',    type: 'uint256' },
    { name: 'maxSlippageBps',   type: 'uint256' },
    { name: 'approvedProtocols',type: 'string'  },
    { name: 'nonce',            type: 'uint256' },
  ],
} as const;

interface Props {
  orgId: string;
  orgName: string;
  onCreated: (mandateId: string) => void;
  onClose: () => void;
}

type SetupStep = 'params' | 'review' | 'signing' | 'done';

interface MandateParams {
  name: string;
  reserveFloorUsd: number;
  riskBudgetPct: number;
  maxSingleActionUsd: number;
  maxProtocolAllocationPct: number;
  approvedProtocols: string[];
  approvedActions: string[];
}

const DEFAULT_PARAMS: MandateParams = {
  name: 'Primary Treasury Mandate',
  reserveFloorUsd: 50_000,
  riskBudgetPct: 10,
  maxSingleActionUsd: 500_000,
  maxProtocolAllocationPct: 60,
  approvedProtocols: ['aave-v3', 'morpho-blue'],
  approvedActions: ['supply', 'withdraw'],
};

const PROTOCOL_OPTIONS = [
  { id: 'aave-v3',    label: 'Aave V3',     desc: '~4.5% APY, battle-tested',  risk: 'Low' },
  { id: 'morpho-blue',label: 'Morpho Blue', desc: '~5.2% APY, curated vaults', risk: 'Low-Med' },
  { id: 'uniswap-v3', label: 'Uniswap V3',  desc: 'Fee income, impermanent loss risk', risk: 'Med' },
];

function Slider({ label, value, min, max, step, format, onChange }: {
  label: string; value: number; min: number; max: number; step: number;
  format: (v: number) => string; onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{label}</span>
        <span style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--text)', fontWeight: 600 }}>
          {format(value)}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--accent)', cursor: 'pointer' }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
        <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{format(min)}</span>
        <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{format(max)}</span>
      </div>
    </div>
  );
}

export function MandateSetupModal({ orgId, orgName, onCreated, onClose }: Props) {
  const { address } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const connectedChainId = useChainId(); // always matches the active wallet chain

  const [step, setStep] = useState<SetupStep>('params');
  const [params, setParams] = useState<MandateParams>(DEFAULT_PARAMS);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState('');

  const fmtUsd = (n: number) => n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `$${(n / 1_000).toFixed(0)}K` : `$${n.toFixed(0)}`;

  const toggleProtocol = (id: string) => {
    setParams(p => ({
      ...p,
      approvedProtocols: p.approvedProtocols.includes(id)
        ? p.approvedProtocols.filter(x => x !== id)
        : [...p.approvedProtocols, id],
    }));
  };

  const handleActivate = useCallback(async () => {
    if (!address) { setError('Connect your wallet first.'); return; }
    setError(null);
    setStep('signing');

    try {
      // 1. Create draft mandate
      setStatusMsg('Creating mandate…');
      const createRes = await fetch(`${API_BASE}/api/v1/mandates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId,
          name: params.name,
          createdBy: address,
          reserveFloorUsd: params.reserveFloorUsd,
          riskBudgetPct: params.riskBudgetPct,
          maxProtocolAllocationPct: params.maxProtocolAllocationPct,
          maxSingleActionUsd: params.maxSingleActionUsd,
          maxSlippageBps: 30,
          approvedAssets: ['USDC'],
          approvedProtocols: params.approvedProtocols,
          approvedActions: params.approvedActions,
        }),
      });
      const createData = await createRes.json().catch(() => null);
      if (!createRes.ok || !createData?.success) {
        throw new Error(createData?.error ?? `Failed to create mandate (${createRes.status})`);
      }
      const mandateId: string = createData.data.mandate.id;
      const versionId: string = createData.data.version.id;

      // 2. Sign EIP-712 activation payload
      setStatusMsg('Sign to activate mandate…');
      const sig = await signTypedDataAsync({
        domain: { name: 'DeFiComposer', version: '1', chainId: connectedChainId },
        types: EIP712_TYPES,
        primaryType: 'MandateActivation',
        message: {
          mandateId,
          mandateVersionId: versionId,
          reserveFloorUsd: BigInt(Math.round(params.reserveFloorUsd)),
          riskBudgetPct: BigInt(Math.round(params.riskBudgetPct)),
          maxSlippageBps: 30n,
          approvedProtocols: params.approvedProtocols.join(','),
          nonce: 1n,
        },
      });

      // 3. Activate
      setStatusMsg('Activating mandate…');
      const activateRes = await fetch(`${API_BASE}/api/v1/mandates/${mandateId}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature: sig, signerAddress: address, chainId: connectedChainId }),
      });
      const activateData = await activateRes.json().catch(() => null);
      if (!activateRes.ok || !activateData?.success) {
        throw new Error(activateData?.error ?? `Activation failed (${activateRes.status})`);
      }

      setStep('done');
      setTimeout(() => onCreated(mandateId), 1200);

    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Activation failed';
      if (msg.includes('rejected') || msg.includes('denied') || msg.includes('cancel')) {
        setError('Signature rejected. Try again when ready.');
      } else {
        setError(msg);
      }
      setStep('review');
    }
  }, [address, connectedChainId, orgId, params, signTypedDataAsync, onCreated]);

  return (
    <div className="modal-back" onClick={e => { if (e.target === e.currentTarget && step !== 'signing') onClose(); }}>
      <div className="modal fade-in" style={{ maxWidth: 520 }}>

        {/* Header */}
        <div className="modal-head">
          <IconShield size={16} style={{ color: 'var(--accent)' }} />
          <span style={{ fontWeight: 500, fontSize: 14 }}>
            {step === 'done' ? 'Mandate Active' : 'Set Up Autonomous Mandate'}
          </span>
          <div style={{ flex: 1 }} />
          {step !== 'signing' && (
            <button className="btn btn-ghost btn-sm" onClick={onClose}><IconX size={12} /></button>
          )}
        </div>

        <div className="modal-body">

          {/* ── Step indicator ──────────────────────────────── */}
          {step !== 'done' && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              {(['params', 'review', 'signing'] as const).map((s, i) => {
                const idx = ['params', 'review', 'signing'].indexOf(step);
                const done = i < idx;
                const active = s === step;
                return (
                  <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {i > 0 && <div style={{ width: 20, height: 1, background: done ? 'var(--accent)' : 'var(--border)' }} />}
                    <div style={{
                      width: 22, height: 22, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 10,
                      fontWeight: 600, fontFamily: 'var(--font-mono)',
                      background: done ? 'var(--accent-soft)' : active ? 'var(--bg-elev)' : 'var(--bg)',
                      border: `1px solid ${done ? 'var(--accent)' : active ? 'var(--accent)' : 'var(--border)'}`,
                      color: done ? 'var(--accent)' : active ? 'var(--accent)' : 'var(--text-faint)',
                    }}>
                      {done ? <IconCheck size={10} /> : i + 1}
                    </div>
                    <span style={{ fontSize: 11, color: active ? 'var(--text)' : 'var(--text-faint)', textTransform: 'capitalize' }}>{s}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Params ──────────────────────────────────────── */}
          {step === 'params' && (
            <div className="fade-in">
              <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 20, lineHeight: 1.5 }}>
                Set the bounds for <strong style={{ color: 'var(--text)' }}>{orgName}</strong>'s autonomous treasury agent.
                You sign once. The agent manages funds 24/7 within these limits — never beyond them.
              </div>

              {/* Mandate name */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Mandate Name</div>
                <input
                  value={params.name}
                  onChange={e => setParams(p => ({ ...p, name: e.target.value }))}
                  style={{
                    width: '100%', boxSizing: 'border-box',
                    background: 'var(--bg-elev)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)', padding: '8px 12px',
                    color: 'var(--text)', fontSize: 13, outline: 'none',
                  }}
                />
              </div>

              <Slider
                label="Emergency Reserve (always liquid, never touched)"
                value={params.reserveFloorUsd}
                min={10_000} max={2_000_000} step={10_000}
                format={fmtUsd}
                onChange={v => setParams(p => ({ ...p, reserveFloorUsd: v }))}
              />

              <Slider
                label="Max Single Action Size"
                value={params.maxSingleActionUsd}
                min={10_000} max={5_000_000} step={10_000}
                format={fmtUsd}
                onChange={v => setParams(p => ({ ...p, maxSingleActionUsd: v }))}
              />

              <Slider
                label="Risk Budget (max % in one protocol)"
                value={params.maxProtocolAllocationPct}
                min={10} max={80} step={5}
                format={v => `${v}%`}
                onChange={v => setParams(p => ({ ...p, maxProtocolAllocationPct: v }))}
              />

              <Slider
                label="Annual Risk Budget"
                value={params.riskBudgetPct}
                min={1} max={25} step={1}
                format={v => `${v}% of portfolio`}
                onChange={v => setParams(p => ({ ...p, riskBudgetPct: v }))}
              />

              {/* Protocols */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                  Approved Protocols
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {PROTOCOL_OPTIONS.map(p => {
                    const selected = params.approvedProtocols.includes(p.id);
                    return (
                      <div
                        key={p.id}
                        onClick={() => toggleProtocol(p.id)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 12,
                          padding: '10px 12px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                          background: selected ? 'var(--accent-soft)' : 'var(--bg-elev)',
                          border: `1px solid ${selected ? 'var(--accent-line)' : 'var(--border)'}`,
                          transition: 'all 0.15s',
                        }}
                      >
                        <div style={{
                          width: 16, height: 16, borderRadius: 4, border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                          background: selected ? 'var(--accent)' : 'transparent', display: 'grid', placeItems: 'center', flexShrink: 0,
                        }}>
                          {selected && <IconCheck size={10} style={{ color: '#fff' }} />}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 500 }}>{p.label}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{p.desc}</div>
                        </div>
                        <span style={{
                          fontSize: 10, padding: '2px 8px', borderRadius: 100,
                          background: p.risk === 'Low' ? 'rgba(0,200,100,0.1)' : 'rgba(255,180,0,0.1)',
                          border: `1px solid ${p.risk === 'Low' ? 'rgba(0,200,100,0.3)' : 'rgba(255,180,0,0.3)'}`,
                          color: p.risk === 'Low' ? 'var(--pos)' : '#f5a623',
                        }}>{p.risk}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {params.approvedProtocols.length === 0 && (
                <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--neg)' }}>Select at least one protocol.</div>
              )}
            </div>
          )}

          {/* ── Review ──────────────────────────────────────── */}
          {step === 'review' && (
            <div className="fade-in">
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 16 }}>Review mandate bounds</div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
                {[
                  { label: 'Mandate Name', value: params.name },
                  { label: 'Reserve Floor', value: fmtUsd(params.reserveFloorUsd) },
                  { label: 'Max / Action', value: fmtUsd(params.maxSingleActionUsd) },
                  { label: 'Max Protocol %', value: `${params.maxProtocolAllocationPct}%` },
                  { label: 'Risk Budget', value: `${params.riskBudgetPct}%` },
                  { label: 'Protocols', value: params.approvedProtocols.map(p => p.replace('aave-v3', 'Aave').replace('morpho-blue', 'Morpho').replace('uniswap-v3', 'Uni')).join(', ') },
                ].map(item => (
                  <div key={item.label} style={{ padding: '10px 12px', background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                    <div style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>{item.label}</div>
                    <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{item.value}</div>
                  </div>
                ))}
              </div>

              <div style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', borderRadius: 'var(--radius-md)', padding: 12, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6, marginBottom: error ? 12 : 0 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <IconShield size={13} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
                  <span>
                    <strong style={{ color: 'var(--text)' }}>One signature activates autonomous management.</strong>{' '}
                    The agent will scan balances every 5 minutes. Every action is fork-simulated and policy-checked
                    before execution. You can pause or revoke anytime.
                  </span>
                </div>
              </div>

              {error && (
                <div style={{ marginTop: 12, background: 'rgba(255,90,90,0.08)', border: '1px solid rgba(255,90,90,0.22)', borderRadius: 'var(--radius-md)', padding: 12, fontSize: 12, color: 'var(--neg)' }}>
                  {error}
                </div>
              )}
            </div>
          )}

          {/* ── Signing ─────────────────────────────────────── */}
          {step === 'signing' && (
            <div className="fade-in" style={{ padding: '12px 0', textAlign: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', marginBottom: 16 }}>
                <div className="gen-spin" style={{ width: 20, height: 20 }} />
                <div style={{ fontSize: 14, fontWeight: 500 }}>{statusMsg}</div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                Check your wallet for a signature request.
              </div>
            </div>
          )}

          {/* ── Done ────────────────────────────────────────── */}
          {step === 'done' && (
            <div className="fade-in" style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', display: 'grid', placeItems: 'center', margin: '0 auto 16px' }}>
                <IconCheck size={24} style={{ color: 'var(--accent)' }} />
              </div>
              <div style={{ fontSize: 18, fontWeight: 500, marginBottom: 8 }}>Mandate Active</div>
              <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                Your treasury agent is now running. It will scan balances every 5 minutes and deploy idle capital within your policy bounds.
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="modal-foot">
          <div>
            {(step === 'params' || step === 'review') && (
              <button className="btn btn-ghost" onClick={() => step === 'params' ? onClose() : setStep('params')}>
                {step === 'params' ? 'Cancel' : '← Back'}
              </button>
            )}
          </div>
          <div>
            {step === 'params' && (
              <button
                className="btn btn-primary"
                disabled={params.approvedProtocols.length === 0 || !params.name.trim()}
                onClick={() => setStep('review')}
              >
                Review <IconArrowRight size={13} />
              </button>
            )}
            {step === 'review' && (
              <button className="btn btn-primary" onClick={handleActivate} disabled={!address}>
                <IconBolt size={13} />
                Sign & Activate
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
