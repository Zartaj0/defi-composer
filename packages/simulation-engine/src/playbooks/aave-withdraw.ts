// ============================================================
// Aave V3 Withdraw Playbook
// Simulates: withdraw USDC/WETH from Aave → verify receipt
// Used for reserve restoration when spend/reserve floor is breached.
// ============================================================

import {
  encodeFunctionData,
  parseUnits,
  maxUint256,
  type PublicClient,
  type WalletClient,
} from "viem";
import { getActiveContracts, getActiveChainId, getTokenBalance, snapshotBalances } from "../fork-context.js";
import type { PlaybookCalldata, PlaybookResult } from "./aave-supply.js";

const AAVE_POOL_ABI = [
  {
    name: "withdraw",
    type: "function" as const,
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable" as const,
  },
] as const;

const ATOKEN_ADDRESSES_BY_CHAIN: Record<number, Record<string, `0x${string}`>> = {
  8453: {
    USDC: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
    WETH: "0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7",
  },
  84532: {
    USDC: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC",
    WETH: "0x96A4815F8Bce5aF0f02F3Ca862CE19b6F0BAAAB7",
  },
};

function getATokenAddresses(): Record<string, `0x${string}`> {
  return ATOKEN_ADDRESSES_BY_CHAIN[getActiveChainId()] ?? ATOKEN_ADDRESSES_BY_CHAIN[8453]!;
}

export interface AaveWithdrawParams {
  asset: "USDC" | "WETH";
  amountHuman: string | "max";   // "max" withdraws entire aToken balance
  to: `0x${string}`;
  signerAddress: `0x${string}`;
  mandateVersionId: string;
}

export async function simulateAaveWithdraw(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: AaveWithdrawParams
): Promise<PlaybookResult> {
  const contracts = getActiveContracts();
  const assetAddress = params.asset === "USDC" ? contracts.USDC : contracts.WETH;
  const decimals = params.asset === "USDC" ? 6 : 18;
  const aTokenAddress = getATokenAddresses()[params.asset];

  const balancesBefore = await snapshotBalances(publicClient, params.to);

  // aToken balance lives with the signer (fork wallet in simulation, Safe in production).
  // `params.to` is the RECIPIENT of withdrawn USDC — it may differ from the aToken holder.
  const aTokenHolder = params.signerAddress;
  const aTokenBalance = aTokenAddress
    ? await getTokenBalance(publicClient, aTokenAddress, aTokenHolder)
    : 0n;

  if (aTokenBalance === 0n) {
    return {
      calldata: [],
      gasEstimate: 0n,
      balancesBefore,
      balancesAfter: balancesBefore,
      expectedDeltas: {},
      passed: false,
      failureReason: `No a${params.asset} balance to withdraw`,
    };
  }

  // Amount: use maxUint256 for full withdrawal, or parse exact amount
  const amount = params.amountHuman === "max"
    ? maxUint256
    : parseUnits(params.amountHuman, decimals);

  const withdrawData = encodeFunctionData({
    abi: AAVE_POOL_ABI,
    functionName: "withdraw",
    args: [assetAddress, amount, params.to],
  });

  const calldata: PlaybookCalldata[] = [
    {
      to: contracts.AAVE_POOL,
      data: withdrawData,
      description: `Withdraw ${params.amountHuman === "max" ? "all" : params.amountHuman} ${params.asset} from Aave V3`,
    },
  ];

  // ── Gas estimation ─────────────────────────────────────────
  // Use signerAddress (fork wallet / Safe) as the `account` — it's the msg.sender.
  let totalGas = 0n;
  try {
    totalGas = await publicClient.estimateGas({
      account: params.signerAddress,
      to: contracts.AAVE_POOL,
      data: withdrawData,
    });
  } catch (err) {
    return {
      calldata,
      gasEstimate: 0n,
      balancesBefore,
      balancesAfter: balancesBefore,
      expectedDeltas: {},
      passed: false,
      failureReason: `Gas estimation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── Execute on fork ────────────────────────────────────────
  try {
    const withdrawHash = await walletClient.sendTransaction({
      account: params.signerAddress,
      to: contracts.AAVE_POOL,
      data: withdrawData,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: withdrawHash });

    const balancesAfter = await snapshotBalances(publicClient, params.to);
    const assetAfter = await getTokenBalance(publicClient, assetAddress, params.to);
    const assetBefore = BigInt(params.asset === "USDC" ? balancesBefore.usdc : balancesBefore.weth);
    const received = assetAfter - assetBefore;

    if (received <= 0n) {
      return {
        calldata,
        gasEstimate: totalGas,
        balancesBefore,
        balancesAfter,
        expectedDeltas: {},
        passed: false,
        failureReason: `Withdraw completed but no ${params.asset} received — unexpected`,
      };
    }

    return {
      calldata,
      gasEstimate: totalGas,
      balancesBefore,
      balancesAfter,
      expectedDeltas: {
        [`${params.asset}_received`]: received.toString(),
        [`a${params.asset}_spent`]: `-${aTokenBalance.toString()}`,
      },
      passed: true,
    };

  } catch (err) {
    const balancesAfter = await snapshotBalances(publicClient, params.to);
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
