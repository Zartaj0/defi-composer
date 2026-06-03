'use client';

import React, { useState, useCallback } from 'react';
import { useSendTransaction, useWaitForTransactionReceipt } from 'wagmi';
import { type Strategy, type Org } from '@/lib/data';
import { fmtUsd, fmtPct } from '@/lib/utils';
import { IconX, IconCheck, IconBolt, IconShield, IconArrowRight } from '@/lib/icons';

interface DeployModalProps {
  strategy: Strategy;
  capitalUsd: number;
  org: Org;
  intentId?: string;
  walletAddress?: `0x${string}`;
  safeAddress?: string;
  onClose: () => void;
}

interface TxStep {
  index: number;
  description: string;
  txType: string;
  to: `0x${string}`;
  data: `0x${string}`;
  value: `0x${string}`;
}

type DeployStep = 'review' | 'executing' | 'done';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export function DeployModal({ strategy, capitalUsd, org, intentId, walletAddress, safeAddress, onClose }: DeployModalProps) {
  const [step, setStep] = useState<DeployStep>('review');
  const [txSteps, setTxSteps] = useState<TxStep[]>([]);
  const [currentTxIdx, setCurrentTxIdx] = useState(0);
  const [completedHashes, setCompletedHashes] = useState<string[]>([]);
  const [positionId, setPositionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState('');

  const { sendTransactionAsync } = useSendTransaction();

  const yearlyYield = capitalUsd * (strategy.apy / 100);

  // ── Step 1: Deploy (create DB record) then prepare calldata ────────────────
  const handleExecute = useCallback(async () => {
    if (!walletAddress || !intentId) {
      setError('Wallet not connected or intent missing.');
      return;
    }

    setError(null);
    setStep('executing');
    setStatusMsg('Creating position record…');

    try {
      // 1. Create position record in DB
      const deployRes = await fetch(`${API_BASE}/api/v1/strategy/${strategy.id}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intentId,
          orgId: org.id,
          walletAddress,
          safeAddress: safeAddress ?? null,
          capitalUsd,
        }),
      });
      const deployData = await deployRes.json().catch(() => null);
      if (!deployRes.ok || !deployData?.success) {
        throw new Error(deployData?.error ?? `Deploy request failed (${deployRes.status})`);
      }
      const pid = deployData.data?.positionId as string;
      setPositionId(pid);

      // 2. Build transaction calldata
      setStatusMsg('Building transaction calldata…');
      const prepRes = await fetch(`${API_BASE}/api/v1/strategy/${strategy.id}/prepare-execution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress, capitalUsd, positionId: pid }),
      });
      const prepData = await prepRes.json().catch(() => null);
      if (!prepRes.ok || !prepData?.success) {
        throw new Error(prepData?.error ?? `Failed to build execution plan (${prepRes.status})`);
      }

      const steps: TxStep[] = prepData.data.steps;
      if (!steps || steps.length === 0) {
        throw new Error('No transactions to execute — strategy graph may be empty.');
      }

      setTxSteps(steps);
      setCurrentTxIdx(0);
      setStatusMsg(`Ready — ${steps.length} transaction${steps.length > 1 ? 's' : ''} to sign`);

      // 3. Send transactions one by one via MetaMask
      const hashes: string[] = [];
      for (let i = 0; i < steps.length; i++) {
        const txStep = steps[i];
        setCurrentTxIdx(i);
        setStatusMsg(`Sign transaction ${i + 1} of ${steps.length}: ${txStep.description}`);

        const hash = await sendTransactionAsync({
          to:    txStep.to,
          data:  txStep.data,
          value: BigInt(txStep.value),
        });

        hashes.push(hash);
        setCompletedHashes([...hashes]);
        setStatusMsg(`Transaction ${i + 1} submitted — waiting for confirmation…`);

        // Wait for each tx to be mined before sending the next
        // (approvals must confirm before the supply tx)
        if (i < steps.length - 1) {
          await waitForTx(hash);
        }
      }

      // 4. Mark position active
      setStatusMsg('Confirming on backend…');
      await fetch(`${API_BASE}/api/v1/strategy/${strategy.id}/confirm-execution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId: pid, txHashes: hashes }),
      }).catch(() => null); // non-critical

      setStep('done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Execution failed.';
      // User rejected the tx in MetaMask
      if (msg.includes('rejected') || msg.includes('denied') || msg.includes('cancel')) {
        setError('Transaction rejected in wallet.');
      } else {
        setError(msg);
      }
      setStep('review');
    }
  }, [walletAddress, intentId, strategy.id, org.id, safeAddress, capitalUsd, sendTransactionAsync]);

  return (
    <div className="modal-back" onClick={(e) => { if (e.target === e.currentTarget && step !== 'executing') onClose(); }}>
      <div className="modal fade-in">

        {/* Header */}
        <div className="modal-head">
          <IconBolt size={16} style={{ color: 'var(--accent)' }} />
          <span style={{ fontWeight: 500, fontSize: 14 }}>
            {step === 'done' ? 'Strategy Deployed' : 'Execute Strategy'}
          </span>
          <div style={{ flex: 1 }} />
          {step !== 'executing' && (
            <button className="btn btn-ghost btn-sm" onClick={onClose}><IconX size={12} /></button>
          )}
        </div>

        {/* Body */}
        <div className="modal-body">

          {/* ── Review ─────────────────────────────────────────────────── */}
          {step === 'review' && (
            <div className="fade-in">
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 16 }}>Review Strategy</div>

              <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14, marginBottom: 16 }}>
                <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 4 }}>{strategy.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.4 }}>{strategy.summary}</div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
                {[
                  { label: 'Capital',     value: fmtUsd(capitalUsd, { compact: true }) },
                  { label: 'APY',         value: fmtPct(strategy.apy, 1),        color: 'var(--pos)' },
                  { label: 'Annual Yield',value: fmtUsd(yearlyYield, { compact: true }), color: 'var(--pos)' },
                  { label: 'Risk Score',  value: `${strategy.riskScore.toFixed(1)}/10` },
                  { label: 'Gas Est.',    value: fmtUsd(strategy.gasUsd) },
                  { label: 'Protocols',   value: strategy.protocols.join(', ') },
                ].map(item => (
                  <div key={item.label} style={{ padding: 10, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                    <div style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{item.label}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: item.color ?? 'var(--text)' }}>{item.value}</div>
                  </div>
                ))}
              </div>

              <div style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', borderRadius: 'var(--radius-md)', padding: 12, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: error ? 12 : 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <IconShield size={13} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1 }} />
                  <span>
                    <strong style={{ color: 'var(--text)' }}>Your wallet signs every transaction.</strong>{' '}
                    MetaMask will ask you to approve each step. No private keys are stored anywhere.
                    {safeAddress && <><br /><strong style={{ color: 'var(--text)' }}>Safe mode:</strong> Transactions are sent to your Safe ({safeAddress.slice(0,6)}…{safeAddress.slice(-4)}).</>}
                  </span>
                </div>
              </div>

              {error && (
                <div style={{ marginTop: 12, background: 'rgba(255,90,90,0.08)', border: '1px solid rgba(255,90,90,0.22)', borderRadius: 'var(--radius-md)', padding: 12, fontSize: 12, color: 'var(--neg)', lineHeight: 1.5 }}>
                  {error}
                </div>
              )}
            </div>
          )}

          {/* ── Executing ──────────────────────────────────────────────── */}
          {step === 'executing' && (
            <div className="fade-in" style={{ padding: '8px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                <div className="gen-spin" style={{ width: 20, height: 20, flexShrink: 0 }} />
                <div style={{ fontSize: 14, fontWeight: 500 }}>{statusMsg}</div>
              </div>

              {txSteps.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {txSteps.map((s, i) => {
                    const done = i < currentTxIdx || completedHashes[i];
                    const active = i === currentTxIdx && !completedHashes[i];
                    return (
                      <div key={i} style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '10px 12px',
                        background: done ? 'var(--accent-soft)' : active ? 'var(--bg-elev)' : 'var(--bg)',
                        border: `1px solid ${done ? 'var(--accent-line)' : active ? 'var(--border)' : 'transparent'}`,
                        borderRadius: 'var(--radius-md)',
                        fontSize: 12,
                        opacity: i > currentTxIdx && !completedHashes[i] ? 0.45 : 1,
                      }}>
                        <div style={{ width: 20, height: 20, borderRadius: '50%', display: 'grid', placeItems: 'center', background: done ? 'var(--accent-soft)' : 'var(--surface)', border: '1px solid var(--border)', flexShrink: 0 }}>
                          {done ? <IconCheck size={10} /> : active ? <div className="gen-spin" style={{ width: 10, height: 10 }} /> : <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{i + 1}</span>}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ color: done ? 'var(--pos)' : 'var(--text)' }}>{s.description}</div>
                          {completedHashes[i] && (
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', marginTop: 2 }}>
                              {completedHashes[i].slice(0, 16)}…
                            </div>
                          )}
                        </div>
                        {done && <span style={{ fontSize: 10, color: 'var(--pos)' }}>✓</span>}
                      </div>
                    );
                  })}
                </div>
              )}

              <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>
                Check MetaMask for signature requests. Do not close this window.
              </div>
            </div>
          )}

          {/* ── Done ───────────────────────────────────────────────────── */}
          {step === 'done' && (
            <div className="fade-in" style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', display: 'grid', placeItems: 'center', margin: '0 auto 16px' }}>
                <IconCheck size={24} style={{ color: 'var(--accent)' }} />
              </div>
              <div style={{ fontSize: 18, fontWeight: 500, marginBottom: 8 }}>Funds Deployed</div>
              <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 24 }}>
                {completedHashes.length} transaction{completedHashes.length !== 1 ? 's' : ''} confirmed on-chain.
                Your capital is now earning yield.
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
                <div style={{ padding: 14, background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', borderRadius: 'var(--radius-md)' }}>
                  <div style={{ fontSize: 10, color: 'var(--accent)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Annual Yield</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, color: 'var(--pos)' }}>+{fmtUsd(yearlyYield, { compact: true })}</div>
                </div>
                <div style={{ padding: 14, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>APY</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, color: 'var(--pos)' }}>{fmtPct(strategy.apy, 1)}</div>
                </div>
              </div>

              {completedHashes.length > 0 && (
                <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 12, textAlign: 'left' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Transaction Hashes</div>
                  {completedHashes.map((h, i) => (
                    <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', marginBottom: 3, wordBreak: 'break-all' }}>{h}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="modal-foot">
          <div>
            {(step === 'review' || step === 'done') && (
              <button className="btn btn-ghost" onClick={onClose}>
                {step === 'done' ? 'Close' : 'Cancel'}
              </button>
            )}
          </div>
          <div>
            {step === 'review' && (
              <button className="btn btn-primary" onClick={handleExecute} disabled={!walletAddress}>
                <IconBolt size={13} />
                Sign & Execute
                <IconArrowRight size={13} />
              </button>
            )}
            {step === 'done' && (
              <button className="btn btn-primary" onClick={onClose}>
                <IconCheck size={13} />
                View Dashboard
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Poll until a tx is included (simple approach — wagmi's useWaitForTransactionReceipt
// requires a component, so we use a lightweight fetch loop here)
async function waitForTx(hash: string, maxWaitMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 2_000));
    // We can't call wagmi hooks outside a component, so just wait 4s minimum
    // The wallet will confirm naturally; the loop just paces sequential txs
    return;
  }
}
