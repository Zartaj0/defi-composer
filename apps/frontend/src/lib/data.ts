export interface Org {
  id: string;
  name: string;
  kind: 'DAO' | 'Company' | 'Wallet';
  handle: string;
  avatar: { bg: string; letter: string };
  treasuryUsd: number;
  managedUsd: number;
  idleUsd: number;
  governanceThreshold: string;
  riskCeiling: number;
  maxAllocPerProtocol: number;
  benchmarkApy: number;
  currentApy: number;
}

export interface Protocol {
  name: string;
  chain: string;
  color: string;
  tvlUsd: number;
  audits: number;
  age: string;
}

export interface StrategyNode {
  id: string;
  kind: string;
  label: string;
  protocol: string | null;
  pos: { x: number; y: number };
  apy?: number;
  hf?: number;
}

export interface StrategyEdge {
  from: string;
  to: string;
  amount?: number;
}

export interface Strategy {
  id: string;
  rank: number;
  name: string;
  summary: string;
  apy: number;
  apyRange: [number, number];
  benchmarkDelta: number;
  riskScore: number;
  riskLevel: string;
  gasUsd: number;
  protocols: string[];
  nodes: StrategyNode[];
  edges: StrategyEdge[];
  rationale: string;
  warnings: { level: string; text: string }[];
  blockers: string[];
  riskBreakdown: {
    market: number;
    liquidation: number;
    protocol: number;
    liquidity: number;
    oracle: number;
  };
  simulation: {
    capital: number;
    steps: { node: string; out: string; gas: number; cum: number }[];
    stress: { d0: number; d10: number; d30: number; d50: number };
    projected: { d1: number; d30: number; y1: number };
  };
}

export interface Position {
  id: string;
  name: string;
  protocol: string;
  capital: number;
  apy: number;
  dailyYield: number;
  hf: number | null;
  status: string;
}

export interface Alert {
  id: string;
  severity: string;
  title: string;
  desc: string;
  meta: string;
  action: string;
}

export interface IntentExample {
  head: string;
  text: string;
  capital: string;
}

export interface GenStep {
  label: string;
  ms: number;
}

export const ORGS: Org[] = [
  {
    id: 'org_88e49a1b-976',
    name: 'Sepolia Test Treasury',
    kind: 'Company',
    handle: '88e49a1b',
    avatar: { bg: '#6B8AFF', letter: 'S' },
    treasuryUsd: 5,
    managedUsd: 5,
    idleUsd: 0,
    governanceThreshold: 'Safe 2-of-3',
    riskCeiling: 10,
    maxAllocPerProtocol: 100,
    benchmarkApy: 0,
    currentApy: 3.18,
  },
  {
    id: 'ens-dao',
    name: 'ENS DAO',
    kind: 'DAO',
    handle: 'ens',
    avatar: { bg: '#6B8AFF', letter: 'E' },
    treasuryUsd: 14_200_000,
    managedUsd: 3_800_000,
    idleUsd: 10_400_000,
    governanceThreshold: '100K ENS',
    riskCeiling: 6,
    maxAllocPerProtocol: 40,
    benchmarkApy: 5.3,
    currentApy: 7.1,
  },
  {
    id: 'index-coop',
    name: 'Index Coop',
    kind: 'DAO',
    handle: 'index',
    avatar: { bg: '#6EE7A8', letter: 'I' },
    treasuryUsd: 6_500_000,
    managedUsd: 2_100_000,
    idleUsd: 4_400_000,
    governanceThreshold: '50K INDEX',
    riskCeiling: 5,
    maxAllocPerProtocol: 35,
    benchmarkApy: 5.3,
    currentApy: 6.4,
  },
  {
    id: 'nova-labs',
    name: 'Nova Labs',
    kind: 'Company',
    handle: 'nova',
    avatar: { bg: '#FFB547', letter: 'N' },
    treasuryUsd: 4_200_000,
    managedUsd: 1_500_000,
    idleUsd: 2_700_000,
    governanceThreshold: '3-of-5 Multisig',
    riskCeiling: 4,
    maxAllocPerProtocol: 50,
    benchmarkApy: 5.3,
    currentApy: 5.9,
  },
];

export const PROTOCOLS: Protocol[] = [
  { name: 'Aave V3', chain: 'Base', color: '#B6509E', tvlUsd: 8_400_000_000, audits: 12, age: '3y' },
  { name: 'Morpho Blue', chain: 'Base', color: '#2470FF', tvlUsd: 2_200_000_000, audits: 6, age: '1.5y' },
];

export const INTENT_EXAMPLES: IntentExample[] = [
  {
    head: 'DAO Treasury',
    text: 'Generate yield on $5M idle USDC, max 40% in any single protocol, governance vote required above $500K moves',
    capital: '5000000',
  },
  {
    head: 'Startup Buffer',
    text: 'Deploy $1.2M runway USDC conservatively, need ability to withdraw $200K within 24 hours for operations',
    capital: '1200000',
  },
  {
    head: 'Aggressive Growth',
    text: 'Maximize yield on $800K USDC, willing to take protocol risk for 10%+ APY, auto-compound rewards',
    capital: '800000',
  },
];

export const GEN_STEPS: GenStep[] = [
  { label: 'Fetching live protocol rates', ms: 800 },
  { label: 'Parsing intent & constraints', ms: 600 },
  { label: 'Building strategy candidates', ms: 1400 },
  { label: 'Running fork simulations', ms: 1800 },
  { label: 'Scoring risk factors', ms: 700 },
  { label: 'Ranking by risk-adjusted return', ms: 400 },
];
