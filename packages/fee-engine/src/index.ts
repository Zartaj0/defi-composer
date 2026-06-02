// ============================================================
// Fee Engine
// Management fee + performance fee calculation.
// Transparent, auditable, deterministic.
// ============================================================

import type { FeeConfig, PortfolioPerformance, Organization } from "@defi-composer/shared";

export interface FeeAccrual {
  orgId: string;
  periodStart: Date;
  periodEnd: Date;

  // AUM-based management fee
  avgAumUsd: number;
  managementFeeBps: number;
  managementFeeAccruedUsd: number;

  // Performance fee
  grossYieldUsd: number;
  benchmarkYieldUsd: number;           // what risk-free would have earned
  yieldAboveBenchmarkUsd: number;      // alpha
  performanceFeePct: number;
  performanceFeeAccruedUsd: number;

  // Curator split (from strategy marketplace)
  curatorFeesUsd: number;
  platformFeesUsd: number;

  // Total
  totalFeesUsd: number;
  netYieldToOrgUsd: number;

  // On-chain settlement
  settled: boolean;
  settlementTxHash?: `0x${string}`;
}

export interface BenchmarkComparison {
  periodDays: number;
  benchmarkRateBps: number;           // annualized risk-free rate
  benchmarkReturnForPeriod: number;   // actual return for period length
  portfolioReturnPct: number;
  alphaPct: number;                   // outperformance
  beatBenchmark: boolean;
  label: string;                      // human-readable e.g. "Beat T-bill by 3.2%"
}

export class FeeEngine {
  // ─── Management Fee ──────────────────────────────────────
  // 0.10% annually = ~0.0274% per day
  // Accrues continuously, collected monthly

  accrueManagementFee(
    avgAumUsd: number,
    feeBps: number,
    periodDays: number
  ): number {
    const annualFeeDecimal = feeBps / 10000;
    const dailyFeeDecimal = annualFeeDecimal / 365;
    return avgAumUsd * dailyFeeDecimal * periodDays;
  }

  // ─── Performance Fee ─────────────────────────────────────
  // 10% of yield ABOVE the benchmark rate
  // Only taken on positive alpha — if we underperform benchmark, no fee

  accruePerformanceFee(
    grossYieldUsd: number,
    aumUsd: number,
    benchmarkRateBps: number,
    feePct: number,
    periodDays: number
  ): { fee: number; yieldAboveBenchmark: number; benchmarkYield: number } {
    // What the risk-free rate would have earned
    const benchmarkAnnual = benchmarkRateBps / 10000;
    const benchmarkForPeriod = benchmarkAnnual * (periodDays / 365);
    const benchmarkYieldUsd = aumUsd * benchmarkForPeriod;

    // Alpha = actual yield - benchmark yield
    const yieldAboveBenchmark = Math.max(0, grossYieldUsd - benchmarkYieldUsd);

    // Performance fee = % of alpha
    const fee = yieldAboveBenchmark * (feePct / 100);

    return { fee, yieldAboveBenchmark, benchmarkYield: benchmarkYieldUsd };
  }

  // ─── Full Period Calculation ─────────────────────────────
  calculatePeriodFees(
    org: Organization,
    grossYieldUsd: number,
    avgAumUsd: number,
    periodDays: number,
    curatorFeePct: number = 0  // optional: cut for strategy curators
  ): FeeAccrual {
    const { feeConfig } = org;
    const periodStart = new Date(Date.now() - periodDays * 86400000);
    const periodEnd = new Date();

    // Management fee
    const managementFeeAccruedUsd = this.accrueManagementFee(
      avgAumUsd,
      feeConfig.managementFeeBps,
      periodDays
    );

    // Performance fee
    const { fee: perfFee, yieldAboveBenchmark, benchmarkYield } =
      this.accruePerformanceFee(
        grossYieldUsd,
        avgAumUsd,
        feeConfig.benchmarkRateBps,
        feeConfig.performanceFeePct,
        periodDays
      );

    const totalPlatformFees = managementFeeAccruedUsd + perfFee;

    // Curator gets a % of the performance fee
    const curatorFeesUsd = perfFee * (curatorFeePct / 100);
    const platformFeesUsd = totalPlatformFees - curatorFeesUsd;

    const totalFeesUsd = totalPlatformFees;
    const netYieldToOrgUsd = grossYieldUsd - totalFeesUsd;

    return {
      orgId: org.id,
      periodStart,
      periodEnd,
      avgAumUsd,
      managementFeeBps: feeConfig.managementFeeBps,
      managementFeeAccruedUsd,
      grossYieldUsd,
      benchmarkYieldUsd: benchmarkYield,
      yieldAboveBenchmarkUsd: yieldAboveBenchmark,
      performanceFeePct: feeConfig.performanceFeePct,
      performanceFeeAccruedUsd: perfFee,
      curatorFeesUsd,
      platformFeesUsd,
      totalFeesUsd,
      netYieldToOrgUsd,
      settled: false,
    };
  }

  // ─── Benchmark Comparison ────────────────────────────────
  compareToBenchmark(
    portfolioReturnUsd: number,
    aumUsd: number,
    benchmarkRateBps: number,
    periodDays: number
  ): BenchmarkComparison {
    const portfolioReturnPct = (portfolioReturnUsd / aumUsd) * 100;
    const benchmarkAnnual = benchmarkRateBps / 10000;
    const benchmarkForPeriod = benchmarkAnnual * (periodDays / 365) * 100;
    const alphaPct = portfolioReturnPct - benchmarkForPeriod;

    let label: string;
    if (alphaPct > 0) {
      label = `Beat risk-free rate by ${alphaPct.toFixed(2)}% over ${periodDays}d`;
    } else if (alphaPct === 0) {
      label = `Matched risk-free rate over ${periodDays}d`;
    } else {
      label = `Underperformed risk-free rate by ${Math.abs(alphaPct).toFixed(2)}% over ${periodDays}d`;
    }

    return {
      periodDays,
      benchmarkRateBps,
      benchmarkReturnForPeriod: benchmarkForPeriod,
      portfolioReturnPct,
      alphaPct,
      beatBenchmark: alphaPct > 0,
      label,
    };
  }

  // ─── Annual Run Rate ─────────────────────────────────────
  // Projections for investor reporting / dashboard display
  projectAnnualRevenue(aumUsd: number, feeConfig: FeeConfig): {
    managementFeeUsd: number;
    performanceFeeUsd: number; // assumes 3.5% alpha
    totalUsd: number;
    impliedYield: number;      // total gross yield on AUM
  } {
    const assumedAlphaBps = 350; // conservative: 3.5% above benchmark
    const impliedApyBps = feeConfig.benchmarkRateBps + assumedAlphaBps;
    const impliedYieldUsd = aumUsd * (impliedApyBps / 10000);

    const managementFeeUsd = aumUsd * (feeConfig.managementFeeBps / 10000);
    const performanceFeeUsd =
      (aumUsd * (assumedAlphaBps / 10000)) * (feeConfig.performanceFeePct / 100);

    return {
      managementFeeUsd,
      performanceFeeUsd,
      totalUsd: managementFeeUsd + performanceFeeUsd,
      impliedYield: impliedYieldUsd,
    };
  }

  // ─── Fee Display Helpers ─────────────────────────────────
  formatFeeAccrual(accrual: FeeAccrual): string {
    return [
      `Period: ${accrual.periodStart.toLocaleDateString()} – ${accrual.periodEnd.toLocaleDateString()}`,
      `Gross yield: $${accrual.grossYieldUsd.toFixed(2)}`,
      `Benchmark yield: $${accrual.benchmarkYieldUsd.toFixed(2)}`,
      `Alpha: $${accrual.yieldAboveBenchmarkUsd.toFixed(2)}`,
      `Management fee (${accrual.managementFeeBps}bps): $${accrual.managementFeeAccruedUsd.toFixed(2)}`,
      `Performance fee (${accrual.performanceFeePct}%): $${accrual.performanceFeeAccruedUsd.toFixed(2)}`,
      `Net yield to org: $${accrual.netYieldToOrgUsd.toFixed(2)}`,
    ].join("\n");
  }
}

export const feeEngine = new FeeEngine();
