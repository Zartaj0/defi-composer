'use client';

import React, { useState, useEffect, useRef } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const WS_BASE = API_BASE.replace(/^http/, 'ws');

interface TickerItem {
  label: string;
  value: string;
  delta: string;
  color: string;
}

const FALLBACK_ITEMS: TickerItem[] = [
  { label: 'Aave V3 USDC', value: '—', delta: '', color: '#B6509E' },
  { label: 'Morpho Steakhouse', value: '—', delta: '', color: '#2470FF' },
  { label: 'Uniswap WETH/USDC', value: 'swap-only', delta: '', color: '#4F92FF' },
  { label: 'Benchmark', value: 'unavailable', delta: '', color: '#6EE7A8' },
  { label: 'Monitor', value: 'connecting…', delta: '', color: '#FFB547' },
];

function fmtBps(bps: number): string {
  return (bps / 100).toFixed(2) + '%';
}

export function MonitorTicker() {
  const [items, setItems] = useState<TickerItem[]>(FALLBACK_ITEMS);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const lastAlertRef = useRef<string | null>(null);

  // Fetch live protocol APYs once on mount (REST)
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/protocols/snapshot`);
        if (!res.ok) return;
        const json = await res.json();
        const data = json.data ?? json;

        setItems([
          {
            label: 'Aave V3 USDC',
            value: data.aave?.usdc ? fmtBps(data.aave.usdc) : '—',
            delta: '',
            color: '#B6509E',
          },
          {
            label: 'Aave V3 WETH',
            value: data.aave?.weth ? fmtBps(data.aave.weth) : '—',
            delta: '',
            color: '#B6509E',
          },
          {
            label: 'Morpho Steakhouse USDC',
            value: data.morpho?.steakhouseUsdc ? fmtBps(data.morpho.steakhouseUsdc) : '—',
            delta: '',
            color: '#2470FF',
          },
          { label: 'Uniswap WETH/USDC', value: 'swap-only', delta: '', color: '#4F92FF' },
          {
            label: 'Benchmark',
            value: data.benchmark?.tBill ? fmtBps(data.benchmark.tBill) : 'unavailable',
            delta: '',
            color: '#6EE7A8',
          },
          {
            label: 'Monitor',
            value: 'live',
            delta: '',
            color: '#6EE7A8',
          },
        ]);
      } catch {
        setWsStatus('offline');
      }
    };

    load();
    const t = setInterval(load, 60_000); // refresh every 60s
    return () => clearInterval(t);
  }, []);

  // WebSocket connection for real-time alert flashes
  useEffect(() => {
    let ws: WebSocket;
    let retryTimeout: ReturnType<typeof setTimeout>;

    const connect = () => {
      try {
        ws = new WebSocket(`${WS_BASE}/api/v1/alerts/ws`);
        wsRef.current = ws;

        ws.onopen = () => setWsStatus('live');

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'alert' && msg.alert) {
              const alert = msg.alert as { title: string; severity: string };
              lastAlertRef.current = alert.title;
              // Flash the monitor item
              setItems(prev => prev.map(item =>
                item.label === 'Monitor'
                  ? { ...item, value: `⚡ ${alert.severity.toUpperCase()}`, delta: '', color: alert.severity === 'critical' ? '#FF6E6E' : '#FFB547' }
                  : item
              ));
              // Reset after 10s
              setTimeout(() => {
                setItems(prev => prev.map(item =>
                  item.label === 'Monitor' ? { ...item, value: 'live', color: '#6EE7A8' } : item
                ));
              }, 10_000);
            }
          } catch { /* ignore */ }
        };

        ws.onclose = () => {
          setWsStatus('offline');
          retryTimeout = setTimeout(connect, 5_000);
        };

        ws.onerror = () => {
          setWsStatus('offline');
        };
      } catch {
        setWsStatus('offline');
        retryTimeout = setTimeout(connect, 10_000);
      }
    };

    connect();
    return () => {
      clearTimeout(retryTimeout);
      ws?.close();
    };
  }, []);

  const doubled = [...items, ...items];

  return (
    <div
      style={{
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        overflow: 'hidden',
        height: 28,
        display: 'flex',
        alignItems: 'center',
        position: 'relative',
      }}
    >
      {/* Live indicator dot */}
      <div style={{
        position: 'absolute',
        left: 10,
        top: '50%',
        transform: 'translateY(-50%)',
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: wsStatus === 'live' ? 'var(--pos)' : wsStatus === 'connecting' ? 'var(--warn)' : 'var(--neg)',
        zIndex: 2,
        boxShadow: wsStatus === 'live' ? '0 0 4px var(--pos)' : 'none',
      }} />

      <div
        style={{
          display: 'flex',
          gap: 0,
          animation: 'ticker 50s linear infinite',
          whiteSpace: 'nowrap',
          paddingLeft: 24,
        }}
      >
        {doubled.map((item, i) => (
          <div
            key={i}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 20px',
              borderRight: '1px solid var(--border)',
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: item.color, flexShrink: 0 }} />
            <span style={{ color: 'var(--text-faint)' }}>{item.label}</span>
            <span style={{ color: 'var(--text)', fontWeight: 500 }}>{item.value}</span>
            {item.delta && (
              <span style={{ color: item.delta.startsWith('+') ? 'var(--pos)' : item.delta.startsWith('-') ? 'var(--neg)' : 'var(--text-faint)' }}>
                {item.delta}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
