// ============================================================
// Chainlink Oracle Reads
// Shared oracle helpers for fork simulation and policy checks.
// ============================================================

import type { PublicClient } from "viem";

export const CHAINLINK_BASE_FEEDS = {
  ETH_USD: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" as `0x${string}`,
} as const;

// Base Sepolia Chainlink feeds
export const CHAINLINK_BASE_SEPOLIA_FEEDS = {
  ETH_USD: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1" as `0x${string}`,
} as const;

function getActiveEthUsdFeed(): `0x${string}` {
  const chainId = parseInt(process.env["CHAIN_ID"] ?? "8453", 10);
  return chainId === 84532
    ? CHAINLINK_BASE_SEPOLIA_FEEDS.ETH_USD
    : CHAINLINK_BASE_FEEDS.ETH_USD;
}

const CHAINLINK_AGGREGATOR_ABI = [
  {
    name: "latestRoundData",
    type: "function" as const,
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view" as const,
  },
  {
    name: "decimals",
    type: "function" as const,
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view" as const,
  },
] as const;

export interface OraclePrice {
  answer: bigint;
  decimals: number;
  updatedAt: bigint;
}

export async function readFreshChainlinkPrice(
  publicClient: PublicClient,
  feed: `0x${string}`,
  maxStalenessSeconds = 3_900
): Promise<OraclePrice> {
  const [roundData, decimals, block] = await Promise.all([
    publicClient.readContract({
      address: feed,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "latestRoundData",
    }),
    publicClient.readContract({
      address: feed,
      abi: CHAINLINK_AGGREGATOR_ABI,
      functionName: "decimals",
    }),
    publicClient.getBlock(),
  ]);

  const [roundId, answer, , updatedAt, answeredInRound] = roundData;

  if (answer <= 0n) {
    throw new Error("Chainlink returned non-positive price");
  }
  if (updatedAt === 0n) {
    throw new Error("Chainlink round is incomplete");
  }
  if (answeredInRound < roundId) {
    throw new Error("Chainlink answeredInRound is stale");
  }

  const blockTimestamp = block.timestamp;
  const ageSeconds = blockTimestamp > updatedAt ? blockTimestamp - updatedAt : 0n;
  if (ageSeconds > BigInt(maxStalenessSeconds)) {
    throw new Error(
      `Chainlink price is stale: age=${ageSeconds.toString()}s max=${maxStalenessSeconds}s`
    );
  }

  return {
    answer,
    decimals: Number(decimals),
    updatedAt,
  };
}

export async function readEthUsdPriceBps(
  publicClient: PublicClient
): Promise<bigint> {
  const price = await readFreshChainlinkPrice(
    publicClient,
    getActiveEthUsdFeed()
  );

  // Convert feed answer to USD with 6 decimals for USDC-denominated policy math.
  // Example: $2,185.14200000 -> 2_185_142_000.
  if (price.decimals >= 6) {
    return price.answer / (10n ** BigInt(price.decimals - 6));
  }
  return price.answer * (10n ** BigInt(6 - price.decimals));
}

export async function amountUsdFromAsset(
  publicClient: PublicClient,
  asset: "USDC" | "WETH",
  amountHuman: string
): Promise<number> {
  const amount = Number(amountHuman);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Invalid amount: ${amountHuman}`);
  }

  if (asset === "USDC") return amount;

  const ethUsd6 = await readEthUsdPriceBps(publicClient);
  return (amount * Number(ethUsd6)) / 1e6;
}
