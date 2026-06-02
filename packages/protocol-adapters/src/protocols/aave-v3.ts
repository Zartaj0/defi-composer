import { createPublicClient, http, parseUnits, encodeFunctionData } from "viem";
import { base } from "viem/chains";
import { createFallbackTransport } from "../rpc-transport.js";
import type {
  AssetSymbol,
  ChainId,
  ProtocolMetadata,
} from "@defi-composer/shared";
import type {
  IProtocolAdapter,
  ProtocolMarket,
  ProtocolCapabilities,
  EncodedAction,
} from "../types/adapter.js";

// ─── Base Contract Addresses ─────────────────────────────────
const AAVE_V3_BASE = {
  POOL_ADDRESSES_PROVIDER: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D" as `0x${string}`,
  POOL: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as `0x${string}`,
  POOL_DATA_PROVIDER: "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A" as `0x${string}`,
  ORACLE: "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156" as `0x${string}`,
  UI_POOL_DATA_PROVIDER: "0xb84A20e848baE3e13897934bB4e74E2225f4546B" as `0x${string}`,
  WETH_GATEWAY: "0xa0d9C1E9E48Ca30c8d8C3B5D69FF5dc1f6DFfC24" as `0x${string}`,
};

// Base asset addresses
const BASE_ASSETS: Record<AssetSymbol, `0x${string}`> = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  cbETH: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
  wstETH: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
  rETH: "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c",
  ETH: "0x0000000000000000000000000000000000000000",
  USDT: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
  DAI: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
  AERO: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
};

// Pool ABI (minimal — supply, borrow, repay, withdraw)
const POOL_ABI = [
  {
    name: "supply",
    type: "function",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "borrow",
    type: "function",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "referralCode", type: "uint16" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "withdraw",
    type: "function",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    name: "getUserAccountData",
    type: "function",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
    stateMutability: "view",
  },
] as const;

// Data Provider ABI
const DATA_PROVIDER_ABI = [
  {
    name: "getReserveData",
    type: "function",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "unbacked", type: "uint256" },
      { name: "accruedToTreasuryScaled", type: "uint256" },
      { name: "totalAToken", type: "uint256" },
      { name: "totalStableDebt", type: "uint256" },
      { name: "totalVariableDebt", type: "uint256" },
      { name: "liquidityRate", type: "uint256" },
      { name: "variableBorrowRate", type: "uint256" },
      { name: "stableBorrowRate", type: "uint256" },
      { name: "averageStableBorrowRate", type: "uint256" },
      { name: "liquidityIndex", type: "uint256" },
      { name: "variableBorrowIndex", type: "uint256" },
      { name: "lastUpdateTimestamp", type: "uint40" },
    ],
    stateMutability: "view",
  },
  {
    name: "getReserveConfigurationData",
    type: "function",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "decimals", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "liquidationThreshold", type: "uint256" },
      { name: "liquidationBonus", type: "uint256" },
      { name: "reserveFactor", type: "uint256" },
      { name: "usageAsCollateralEnabled", type: "bool" },
      { name: "borrowingEnabled", type: "bool" },
      { name: "stableBorrowRateEnabled", type: "bool" },
      { name: "isActive", type: "bool" },
      { name: "isFrozen", type: "bool" },
    ],
    stateMutability: "view",
  },
] as const;

function rayToApy(rayRate: bigint): number {
  // Aave rates are annualized APRs in RAY (1e27). Convert to APY the same way
  // Aave's frontend utilities do: compound the per-second rate over one year.
  const rate = Number(rayRate) / 1e27;
  const secondsPerYear = 31_536_000;
  const apy = Math.pow(1 + rate / secondsPerYear, secondsPerYear) - 1;
  return Math.round(apy * 10_000); // bps
}

export class AaveV3Adapter implements IProtocolAdapter {
  readonly protocol = "aave-v3" as const;
  readonly chainId: ChainId = 8453;
  private readonly marketCache = new Map<
    AssetSymbol,
    { market: ProtocolMarket | null; fetchedAt: number }
  >();
  private readonly marketCacheTtlMs = 30_000;

  readonly metadata: ProtocolMetadata = {
    name: "aave-v3",
    displayName: "Aave V3",
    category: "lending",
    chainId: 8453,
    tvlUsd: 280_000_000, // ~$280M on Base (updated periodically)
    audited: true,
    auditCount: 6,
    deployedMonths: 24,
    hasLiquidationRisk: true,
    hasLockup: false,
    supportsLeverage: true,
    governanceTokenRisk: "low",
    contractAddresses: AAVE_V3_BASE,
  };

  private client = createPublicClient({
    chain: base,
    transport: createFallbackTransport(),
  });

  private readonly supportedAssets: AssetSymbol[] = [
    "USDC", "WETH", "cbETH",
  ];

  async getMarkets(): Promise<ProtocolMarket[]> {
    const markets: ProtocolMarket[] = [];

    for (const asset of this.supportedAssets) {
      const market = await this.getMarket(asset);
      if (market) markets.push(market);
    }

    return markets;
  }

  async getMarket(asset: AssetSymbol): Promise<ProtocolMarket | null> {
    const cached = this.marketCache.get(asset);
    if (cached && Date.now() - cached.fetchedAt < this.marketCacheTtlMs) {
      return cached.market;
    }

    const assetAddress = BASE_ASSETS[asset];
    if (!assetAddress || assetAddress === "0x0000000000000000000000000000000000000000") {
      return null;
    }

    try {
      const reserveData = await this.client.readContract({
        address: AAVE_V3_BASE.POOL_DATA_PROVIDER,
        abi: DATA_PROVIDER_ABI,
        functionName: "getReserveData",
        args: [assetAddress],
      });

      const supplyApyBps = rayToApy(reserveData[5]); // liquidityRate
      const borrowApyBps = rayToApy(reserveData[6]); // variableBorrowRate

      const totalSupply = Number(reserveData[2]);
      const totalBorrow = Number(reserveData[3]) + Number(reserveData[4]);
      const utilization = totalSupply > 0 ? Math.min((totalBorrow / totalSupply) * 100, 100) : 0;

      // getReserveConfigurationData may not be available on all Data Provider versions
      let ltv = 0.8;
      let liquidationThreshold = 0.825;
      try {
        const configData = await this.client.readContract({
          address: AAVE_V3_BASE.POOL_DATA_PROVIDER,
          abi: DATA_PROVIDER_ABI,
          functionName: "getReserveConfigurationData",
          args: [assetAddress],
        });
        ltv = Number(configData[1]) / 10000;
        liquidationThreshold = Number(configData[2]) / 10000;
      } catch {
        // Use asset-specific defaults
      }

      const market = {
        asset,
        supplyApyBps,
        borrowApyBps,
        utilizationPct: utilization,
        liquidityUsd: 0,
        tvlUsd: 0,
        ltv,
        liquidationThreshold,
        totalSupplyUsd: 0,
        totalBorrowUsd: 0,
      };
      this.marketCache.set(asset, { market, fetchedAt: Date.now() });
      return market;
    } catch (err) {
      if (cached) {
        return cached.market;
      }
      console.error(`[AaveV3] Failed to fetch market for ${asset}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  async buildSupplyCalldata(
    asset: AssetSymbol,
    amount: bigint,
    onBehalfOf: `0x${string}`
  ): Promise<EncodedAction> {
    const assetAddress = BASE_ASSETS[asset];
    if (!assetAddress) throw new Error(`Unsupported asset: ${asset}`);

    const data = encodeFunctionData({
      abi: POOL_ABI,
      functionName: "supply",
      args: [assetAddress, amount, onBehalfOf, 0],
    });

    return {
      protocol: "aave-v3",
      to: AAVE_V3_BASE.POOL,
      data,
      value: 0n,
      gasEstimate: 250_000n,
      description: `Supply ${asset} to Aave V3`,
    };
  }

  async buildBorrowCalldata(
    asset: AssetSymbol,
    amount: bigint,
    onBehalfOf: `0x${string}`
  ): Promise<EncodedAction> {
    const assetAddress = BASE_ASSETS[asset];
    if (!assetAddress) throw new Error(`Unsupported asset: ${asset}`);

    const data = encodeFunctionData({
      abi: POOL_ABI,
      functionName: "borrow",
      args: [assetAddress, amount, 2n, 0, onBehalfOf], // 2 = variable rate
    });

    return {
      protocol: "aave-v3",
      to: AAVE_V3_BASE.POOL,
      data,
      value: 0n,
      gasEstimate: 300_000n,
      description: `Borrow ${asset} from Aave V3 (variable rate)`,
    };
  }

  async buildWithdrawCalldata(
    asset: AssetSymbol,
    amount: bigint,
    receiver: `0x${string}`
  ): Promise<EncodedAction> {
    const assetAddress = BASE_ASSETS[asset];
    if (!assetAddress) throw new Error(`Unsupported asset: ${asset}`);

    const data = encodeFunctionData({
      abi: POOL_ABI,
      functionName: "withdraw",
      args: [assetAddress, amount, receiver],
    });

    return {
      protocol: "aave-v3",
      to: AAVE_V3_BASE.POOL,
      data,
      value: 0n,
      gasEstimate: 200_000n,
      description: `Withdraw ${asset} from Aave V3`,
    };
  }

  async getHealthFactor(account: `0x${string}`): Promise<number | null> {
    try {
      const data = await this.client.readContract({
        address: AAVE_V3_BASE.POOL,
        abi: POOL_ABI,
        functionName: "getUserAccountData",
        args: [account],
      });

      const healthFactor = Number(data[5]) / 1e18;
      return healthFactor;
    } catch {
      return null;
    }
  }

  getCapabilities(): ProtocolCapabilities {
    return {
      canSupply: true,
      canBorrow: true,
      canProvideLiquidity: false,
      canStake: false,
      supportsLeverage: true,
      hasLiquidationRisk: true,
      hasImpermanentLoss: false,
      hasLockup: false,
      supportedAssets: this.supportedAssets,
      semanticDescription: `
        Aave V3 is a battle-tested lending protocol on Base with $280M+ TVL.
        Users supply collateral to earn yield and optionally borrow against it.
        Key properties:
        - Supply assets to earn variable APY (currently 3-8% on USDC)
        - Borrow against collateral (LTV 75-80% for ETH assets)
        - LIQUIDATION RISK: if health factor drops below 1.0, position is liquidated
        - No lockup — instant deposit and withdrawal
        - Excellent for: conservative yield, collateral for borrowing, recursive strategies
        - Risk level: low-medium (protocol is audited and 24 months live on Base)
      `.trim(),
    };
  }
}
