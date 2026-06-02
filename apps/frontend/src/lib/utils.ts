export const fmtUsd = (n: number, opts?: { compact?: boolean; sign?: boolean }): string => {
  const sign = opts?.sign && n > 0 ? '+' : '';
  if (opts?.compact) {
    if (Math.abs(n) >= 1_000_000) return sign + '$' + (n / 1_000_000).toFixed(1) + 'M';
    if (Math.abs(n) >= 1_000) return sign + '$' + (n / 1_000).toFixed(1) + 'K';
    return sign + '$' + n.toFixed(0);
  }
  return sign + new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
};

export const fmtPct = (n: number, dp = 2, sign = false): string => {
  const s = sign && n > 0 ? '+' : '';
  return s + n.toFixed(dp) + '%';
};

export const fmtBps = (n: number): string => ((n * 10000).toFixed(0) + ' bps');

export const shortAddr = (s: string): string => s.length > 10 ? s.slice(0, 6) + '…' + s.slice(-4) : s;

export interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}

export const buildSparklinePath = (data: number[], width: number, height: number): string => {
  if (data.length < 2) return '';
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  });
  return 'M ' + points.join(' L ');
};
