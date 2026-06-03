'use client';

import React, { useState } from 'react';
import { type Strategy, type Org } from '@/lib/data';
import { fmtUsd, fmtPct } from '@/lib/utils';
import { IconX, IconCheck, IconBolt, IconShield } from '@/lib/icons';

interface DeployModalProps {
  strategy: Strategy;
  capitalUsd: number;
  org: Org;
  intentId?: string;
  walletAddress?: `0x${string}`;
  safeAddress?: string;
  onClose: () => void;
}

type DeployStep = 'review' | 'submitting' | 'queued';

const STEPS: DeployStep[] = ['review', 'submitting', 'queued'];

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface DeployResult {
  positionId: string;
  jobId?: string;
  strategyId: string;
  status: string;
  message: string;
  positionUrl: string;
}

export function DeployModal({ strategy, capitalUsd, org, intentId, walletAddress, safeAddress, onClose }: DeployModalProps) {
  const [step, setStep] = useState<DeployStep>('review');
  const [submitting, setSubmitting] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stepIdx = STEPS.indexOf(step);

  const handleNext = async () => {
    if (step !== 'review') return;

    setError(null);
    setStep('submitting');
    setSubmitting(true);

    try {
      if (!intentId) throw new Error('Cannot deploy without a stored backend intent id.');
      if (!walletAddress) throw new Error('Connect a wallet before submitting a strategy.');

      const res = await fetch(`${API_BASE}/api/v1/strategy/${strategy.id}/deploy`, {
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
      const payload = await res.json().catch(() => null);

      if (!res.ok || !payload?.success) {
        throw new Error(payload?.error ?? `Deploy request failed with ${res.status}`);
      }

      setDeployResult(payload.data as DeployResult);
      setStep('queued');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Deploy request failed.');
      setStep('review');
    } finally {
      setSubmitting(false);
    }
  };

  const yearlyYield = capitalUsd * (strategy.apy / 100);

  return (
    <div className="modal-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal fade-in">
        {/* Header */}
        <div className="modal-head">
          <IconBolt size={16} style={{ color: 'var(--accent)' }} />
          <span style={{ fontWeight: 500, fontSize: 14 }}>Deploy Strategy</span>
          <div className="step-dots">
            {STEPS.slice(0, -1).map((s, i) => (
              <div
                key={s}
                className={`d ${i === stepIdx ? 'active' : i < stepIdx ? 'done' : ''}`}
              />
            ))}
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            <IconX size={12} />
          </button>
        </div>

        {/* Body */}
        <div className="modal-body">
          {step === 'review' && (
            <div className="fade-in">
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 16 }}>Review Strategy</div>

              <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14, marginBottom: 16 }}>
                <div style={{ fontSize: 16, fontWeight: 500, marginBottom: 4 }}>{strategy.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.4 }}>{strategy.summary}</div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
                {[
                  { label: 'Capital', value: fmtUsd(capitalUsd, { compact: true }) },
                  { label: 'APY', value: fmtPct(strategy.apy, 1), color: 'var(--pos)' },
                  { label: 'Annual Yield', value: fmtUsd(yearlyYield, { compact: true }), color: 'var(--pos)' },
                  { label: 'Risk Score', value: `${strategy.riskScore.toFixed(1)}/10` },
                  { label: 'Gas Cost', value: fmtUsd(strategy.gasUsd) },
                  { label: 'Protocols', value: strategy.protocols.length.toString() },
                ].map(item => (
                  <div key={item.label} style={{ padding: 10, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                    <div style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>{item.label}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: item.color ?? 'var(--text)' }}>{item.value}</div>
                  </div>
                ))}
              </div>

              <div style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', borderRadius: 'var(--radius-md)', padding: 12, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <IconShield size={13} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1 }} />
                  <span>
                    <strong style={{ color: 'var(--text)' }}>Simulation required.</strong> The backend will re-run required simulation and policy checks before creating any execution record.
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

          {step === 'submitting' && (
            <div className="fade-in" style={{ textAlign: 'center', padding: '20px 0' }}>
              {submitting ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
                    <div className="gen-spin" style={{ width: 40, height: 40 }} />
                  </div>
                  <div style={{ fontWeight: 500, fontSize: 15, marginBottom: 8 }}>Submitting execution request</div>
                  <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>The backend will simulate, validate, and queue the Safe proposal path.</div>
                </>
              ) : null}
            </div>
          )}

          {step === 'queued' && deployResult && (
            <div className="fade-in" style={{ textAlign: 'center', padding: '20px 0' }}>
              <div className="success-circle">
                <IconCheck size={28} style={{ color: 'var(--accent)' }} />
              </div>
              <div style={{ fontSize: 18, fontWeight: 500, marginBottom: 8, letterSpacing: '-0.01em' }}>
                Execution Queued
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 24, maxWidth: 380, margin: '0 auto 24px' }}>
                {deployResult.message}
              </div>
              <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 12, marginBottom: 20, textAlign: 'left' }}>
                <div style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>Position ID</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)', wordBreak: 'break-all' }}>{deployResult.positionId}</div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ padding: 12, background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', borderRadius: 'var(--radius-md)' }}>
                  <div style={{ fontSize: 10, color: 'var(--accent)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Annual Yield</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, color: 'var(--pos)' }}>+{fmtUsd(yearlyYield, { compact: true })}</div>
                </div>
                <div style={{ padding: 12, background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>APY</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, color: 'var(--pos)' }}>{fmtPct(strategy.apy, 1)}</div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="modal-foot">
          <div>
            {step !== 'queued' && step !== 'submitting' && (
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            )}
            {step === 'queued' && (
              <button className="btn btn-ghost" onClick={onClose}>Close</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
              {step !== 'queued' && step !== 'submitting' ? `Step ${stepIdx + 1} of ${STEPS.length - 1}` : ''}
            </span>
            {step !== 'queued' && step !== 'submitting' && (
              <button className="btn btn-primary" onClick={handleNext}>
                <><IconBolt size={13} />Queue Execution</>
              </button>
            )}
            {step === 'queued' && (
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
