// ============================================================
// Aave V3 Supply Playbook
// Simulates: approve USDC/WETH → supply to Aave → verify aToken receipt
// Returns exact calldata + balance deltas for the simulation artifact.
// ============================================================

import {
  encodeFunctionData,
  parseUnits,
  type PublicClient,
  type WalletClient,
} from "viem";
import { getActiveContracts, getActiveChainId, getTokenBalance, snapshotBalances } from "../fork-context.js";

// ─── Minimal ABIs ─────────────────────────────────────────────
const ERC20_ABI = [
  {
    name: "approve",
    type: "function" as const,
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable" as const,
  },
  {
    name: "balanceOf",
    type: "function" as const,
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view" as const,
  },
] as const;

const AAVE_POOL_ABI = [
  {
    name: "supply",
    type: "function" as const,
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
    stateMutability: "nonpayable" as const,
  },
] as const;

// aToken addresses per chain for balance checks
const ATOKEN_ADDRESSES_BY_CHAIN: Record<number, Record<string, `0x${string}`>> = {
  8453: {   // Base mainnet
    USDC: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
    WETH: "0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7",
  },
  84532: {  // Base Sepolia
    USDC: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC",
    WETH: "0x96A4815F8Bce5aF0f02F3Ca862CE19b6F0BAAAB7",  // aWETH Base Sepolia
  },
};

function getATokenAddresses(): Record<string, `0x${string}`> {
  return ATOKEN_ADDRESSES_BY_CHAIN[getActiveChainId()] ?? ATOKEN_ADDRESSES_BY_CHAIN[8453]!;
}

export interface AaveSupplyParams {
  asset: "USDC" | "WETH";
  amountHuman: string;     // e.g. "1000.00" for 1000 USDC
  onBehalfOf: `0x${string}`;
  signerAddress: `0x${string}`;  // wallet that signs — must match walletClient account
  mandateVersionId: string;
}

export interface PlaybookCalldata {
  to: string;
  data: string;
  value?: string;
  description: string;
}

export interface PlaybookResult {
  calldata: PlaybookCalldata[];
  gasEstimate: bigint;
  balancesBefore: Record<string, string>;
  balancesAfter: Record<string, string>;
  expectedDeltas: Record<string, string>;
  passed: boolean;
  failureReason?: string;
}

export async function simulateAaveSupply(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: AaveSupplyParams
): Promise<PlaybookResult> {
  const contracts = getActiveContracts();
  const assetAddress = params.asset === "USDC" ? contracts.USDC : contracts.WETH;
  const decimals = params.asset === "USDC" ? 6 : 18;
  const amount = parseUnits(params.amountHuman, decimals);
  const aTokenAddress = getATokenAddresses()[params.asset];

  // ── Pre-flight policy checks ───────────────────────────────
  // Balance snapshot is for the onBehalfOf address (aToken beneficiary / Safe).
  // Balance check is on the SIGNER — it's the signer who provides the USDC, not onBehalfOf.
  const balancesBefore = await snapshotBalances(publicClient, params.onBehalfOf);
  const assetBalanceBefore = await getTokenBalance(publicClient, assetAddress, params.signerAddress);

  if (assetBalanceBefore < amount) {
    return {
      calldata: [],
      gasEstimate: 0n,
      balancesBefore,
      balancesAfter: balancesBefore,
      expectedDeltas: {},
      passed: false,
      failureReason: `Insufficient ${params.asset} balance. Have ${assetBalanceBefore.toString()}, need ${amount.toString()}`,
    };
  }

  // ── Build calldata ─────────────────────────────────────────
  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [contracts.AAVE_POOL, amount],
  });

  const supplyData = encodeFunctionData({
    abi: AAVE_POOL_ABI,
    functionName: "supply",
    args: [assetAddress, amount, params.onBehalfOf, 0],
  });

  const calldata: PlaybookCalldata[] = [
    {
      to: assetAddress,
      data: approveData,
      description: `Approve Aave Pool to spend ${params.amountHuman} ${params.asset}`,
    },
    {
      to: contracts.AAVE_POOL,
      data: supplyData,
      description: `Supply ${params.amountHuman} ${params.asset} to Aave V3`,
    },
  ];

  // ── Execute on fork (approve must execute before supply gas can be estimated) ─
  let totalGas = 0n;
  try {
    // Estimate approve gas — signer is the account (fork wallet or Safe)
    const approveGas = await publicClient.estimateGas({
      account: params.signerAddress,
      to: assetAddress,
      data: approveData,
    });

    // Execute approve so the Aave pool has allowance
    const approveHash = await walletClient.sendTransaction({
      account: params.signerAddress,
      to: assetAddress,
      data: approveData,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    // Now estimate supply gas (allowance is in place) — signer provides the USDC
    const supplyGas = await publicClient.estimateGas({
      account: params.signerAddress,
      to: contracts.AAVE_POOL,
      data: supplyData,
    });
    totalGas = approveGas + supplyGas;

    // Execute supply
    const supplyHash = await walletClient.sendTransaction({
      account: params.signerAddress,
      to: contracts.AAVE_POOL,
      data: supplyData,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: supplyHash });

    // Verify balances
    const balancesAfter = await snapshotBalances(publicClient, params.onBehalfOf);
    const aTokenAfter = aTokenAddress
      ? await getTokenBalance(publicClient, aTokenAddress, params.onBehalfOf)
      : 0n;

    const expectedDeltas: Record<string, string> = {
      [`${params.asset}_spent`]: `-${amount.toString()}`,
      [`a${params.asset}_received`]: aTokenAfter.toString(),
    };

    // Confirm aToken was received (must be > 0)
    if (aTokenAddress && aTokenAfter === 0n) {
      return {
        calldata,
        gasEstimate: totalGas,
        balancesBefore,
        balancesAfter,
        expectedDeltas,
        passed: false,
        failureReason: `No a${params.asset} tokens received after supply — unexpected protocol state`,
      };
    }

    return {
      calldata,
      gasEstimate: totalGas,
      balancesBefore,
      balancesAfter,
      expectedDeltas,
      passed: true,
    };

  } catch (err) {
    const balancesAfter = await snapshotBalances(publicClient, params.onBehalfOf);
    return {
      calldata,
      gasEstimate: totalGas,
      balancesBefore,
      balancesAfter,
      expectedDeltas: {},
      passed: false,
      failureReason: `Fork execution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
