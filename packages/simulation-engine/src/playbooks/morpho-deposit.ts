// ============================================================
// Morpho Steakhouse USDC ERC-4626 Deposit / Withdraw Playbooks
//
// Deposit:
//   approve USDC → deposit(amount, receiver) → verify shares > 0
//
// Withdraw:
//   deposit first (setup) → balanceOf shares → redeem(shares, receiver, owner)
//   → verify USDC received > 0
// ============================================================

import {
  encodeFunctionData,
  parseUnits,
  type PublicClient,
  type WalletClient,
} from "viem";
import { getActiveContracts, getActiveChainId, getTokenBalance, snapshotBalances } from "../fork-context.js";
import type { PlaybookCalldata, PlaybookResult } from "./aave-supply.js";

// ─── ABIs ─────────────────────────────────────────────────────
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

const ERC4626_ABI = [
  {
    name: "deposit",
    type: "function" as const,
    inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }],
    outputs: [{ name: "shares", type: "uint256" }],
    stateMutability: "nonpayable" as const,
  },
  {
    name: "redeem",
    type: "function" as const,
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "assets", type: "uint256" }],
    stateMutability: "nonpayable" as const,
  },
  {
    name: "convertToAssets",
    type: "function" as const,
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "assets", type: "uint256" }],
    stateMutability: "view" as const,
  },
  {
    name: "balanceOf",
    type: "function" as const,
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view" as const,
  },
  {
    name: "totalAssets",
    type: "function" as const,
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view" as const,
  },
] as const;

// ─── Params ────────────────────────────────────────────────────
export interface MorphoDepositParams {
  asset: "USDC";
  amountHuman: string;      // e.g. "500.00"
  onBehalfOf: `0x${string}`;
  signerAddress: `0x${string}`;
  mandateVersionId: string;
}

export interface MorphoWithdrawParams {
  asset: "USDC";
  amountHuman: string;      // amount to first deposit (then fully redeem)
  onBehalfOf: `0x${string}`;
  signerAddress: `0x${string}`;
  mandateVersionId: string;
}

// ─── Deposit playbook ─────────────────────────────────────────
export async function simulateMorphoDeposit(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: MorphoDepositParams
): Promise<PlaybookResult> {
  const contracts = getActiveContracts();

  // Morpho Steakhouse is mainnet-only — fail gracefully on other chains
  if (contracts.MORPHO_STEAKHOUSE_USDC === "0x0000000000000000000000000000000000000000") {
    return {
      calldata: [], gasEstimate: 0n,
      balancesBefore: {}, balancesAfter: {}, expectedDeltas: {},
      passed: false,
      failureReason: `Morpho Steakhouse USDC is not deployed on chain ${getActiveChainId()}`,
    };
  }

  const vaultAddress = contracts.MORPHO_STEAKHOUSE_USDC;
  const usdcAddress = contracts.USDC;
  const decimals = 6; // USDC
  const amount = parseUnits(params.amountHuman, decimals);

  // ── Pre-flight balance check ───────────────────────────────
  const balancesBefore = await snapshotBalances(publicClient, params.onBehalfOf);
  const usdcBalance = await getTokenBalance(publicClient, usdcAddress, params.onBehalfOf);

  if (usdcBalance < amount) {
    return {
      calldata: [],
      gasEstimate: 0n,
      balancesBefore,
      balancesAfter: balancesBefore,
      expectedDeltas: {},
      passed: false,
      failureReason: `Insufficient USDC balance. Have ${usdcBalance.toString()}, need ${amount.toString()}`,
    };
  }

  // ── Build calldata ─────────────────────────────────────────
  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [vaultAddress, amount],
  });

  const depositData = encodeFunctionData({
    abi: ERC4626_ABI,
    functionName: "deposit",
    args: [amount, params.onBehalfOf],
  });

  const calldata: PlaybookCalldata[] = [
    {
      to: usdcAddress,
      data: approveData,
      description: `Approve Morpho Steakhouse USDC vault to spend ${params.amountHuman} USDC`,
    },
    {
      to: vaultAddress,
      data: depositData,
      description: `Deposit ${params.amountHuman} USDC into Morpho Steakhouse USDC (ERC-4626)`,
    },
  ];

  // ── Execute on fork ────────────────────────────────────────
  let totalGas = 0n;
  try {
    // Estimate approve gas
    const approveGas = await publicClient.estimateGas({
      account: params.onBehalfOf,
      to: usdcAddress,
      data: approveData,
    });

    // Execute approve so vault has allowance
    const approveHash = await walletClient.sendTransaction({
      account: params.signerAddress,
      to: usdcAddress,
      data: approveData,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    // Estimate deposit gas (allowance now in place)
    const depositGas = await publicClient.estimateGas({
      account: params.onBehalfOf,
      to: vaultAddress,
      data: depositData,
    });
    totalGas = approveGas + depositGas;

    // Execute deposit
    const depositHash = await walletClient.sendTransaction({
      account: params.signerAddress,
      to: vaultAddress,
      data: depositData,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: depositHash });

    // Read shares received
    const sharesAfter = await publicClient.readContract({
      address: vaultAddress,
      abi: ERC4626_ABI,
      functionName: "balanceOf",
      args: [params.onBehalfOf],
    });

    const balancesAfter = await snapshotBalances(publicClient, params.onBehalfOf);

    if (sharesAfter === 0n) {
      return {
        calldata,
        gasEstimate: totalGas,
        balancesBefore,
        balancesAfter,
        expectedDeltas: {},
        passed: false,
        failureReason: "No Morpho vault shares received after deposit — unexpected protocol state",
      };
    }

    return {
      calldata,
      gasEstimate: totalGas,
      balancesBefore,
      balancesAfter,
      expectedDeltas: {
        USDC_spent: `-${amount.toString()}`,
        morpho_shares_received: sharesAfter.toString(),
      },
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

// ─── Withdraw playbook ────────────────────────────────────────
// Deposits first to get shares, then redeems all of them.
export async function simulateMorphoWithdraw(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: MorphoWithdrawParams
): Promise<PlaybookResult> {
  const contracts = getActiveContracts();

  // Morpho Steakhouse is mainnet-only — fail gracefully on other chains
  if (contracts.MORPHO_STEAKHOUSE_USDC === "0x0000000000000000000000000000000000000000") {
    return {
      calldata: [], gasEstimate: 0n,
      balancesBefore: {}, balancesAfter: {}, expectedDeltas: {},
      passed: false,
      failureReason: `Morpho Steakhouse USDC is not deployed on chain ${getActiveChainId()}`,
    };
  }

  const vaultAddress = contracts.MORPHO_STEAKHOUSE_USDC;
  const usdcAddress = contracts.USDC;
  const decimals = 6;
  const amount = parseUnits(params.amountHuman, decimals);

  const balancesBefore = await snapshotBalances(publicClient, params.onBehalfOf);
  const usdcBalance = await getTokenBalance(publicClient, usdcAddress, params.onBehalfOf);

  // ── Setup: deposit first so we have shares to redeem ──────
  if (usdcBalance < amount) {
    return {
      calldata: [],
      gasEstimate: 0n,
      balancesBefore,
      balancesAfter: balancesBefore,
      expectedDeltas: {},
      passed: false,
      failureReason: `Insufficient USDC balance for setup deposit. Have ${usdcBalance.toString()}, need ${amount.toString()}`,
    };
  }

  // Approve + deposit setup (not recorded in returned calldata — this is setup)
  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: "approve",
    args: [vaultAddress, amount],
  });
  const depositData = encodeFunctionData({
    abi: ERC4626_ABI,
    functionName: "deposit",
    args: [amount, params.onBehalfOf],
  });

  let totalGas = 0n;
  try {
    const approveHash = await walletClient.sendTransaction({
      account: params.signerAddress,
      to: usdcAddress,
      data: approveData,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    const depositHash = await walletClient.sendTransaction({
      account: params.signerAddress,
      to: vaultAddress,
      data: depositData,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: depositHash });

    // Read shares balance after deposit
    const shares = await publicClient.readContract({
      address: vaultAddress,
      abi: ERC4626_ABI,
      functionName: "balanceOf",
      args: [params.onBehalfOf],
    });

    if (shares === 0n) {
      return {
        calldata: [],
        gasEstimate: 0n,
        balancesBefore,
        balancesAfter: await snapshotBalances(publicClient, params.onBehalfOf),
        expectedDeltas: {},
        passed: false,
        failureReason: "Setup deposit produced no shares — cannot redeem",
      };
    }

    // ── Build redeem calldata ────────────────────────────────
    const redeemData = encodeFunctionData({
      abi: ERC4626_ABI,
      functionName: "redeem",
      args: [shares, params.onBehalfOf, params.onBehalfOf],
    });

    const calldata: PlaybookCalldata[] = [
      {
        to: vaultAddress,
        data: redeemData,
        description: `Redeem ${shares.toString()} Morpho vault shares for USDC (ERC-4626)`,
      },
    ];

    // Snapshot before redeem (after deposit setup)
    const balancesPreRedeem = await snapshotBalances(publicClient, params.onBehalfOf);
    const usdcPreRedeem = await getTokenBalance(publicClient, usdcAddress, params.onBehalfOf);

    // Estimate redeem gas
    const redeemGas = await publicClient.estimateGas({
      account: params.onBehalfOf,
      to: vaultAddress,
      data: redeemData,
    });
    totalGas = redeemGas;

    // Execute redeem
    const redeemHash = await walletClient.sendTransaction({
      account: params.signerAddress,
      to: vaultAddress,
      data: redeemData,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: redeemHash });

    const balancesAfter = await snapshotBalances(publicClient, params.onBehalfOf);
    const usdcAfter = await getTokenBalance(publicClient, usdcAddress, params.onBehalfOf);
    const usdcReceived = usdcAfter - usdcPreRedeem;

    if (usdcReceived <= 0n) {
      return {
        calldata,
        gasEstimate: totalGas,
        balancesBefore: balancesPreRedeem,
        balancesAfter,
        expectedDeltas: {},
        passed: false,
        failureReason: "Redeem completed but no USDC received — unexpected protocol state",
      };
    }

    return {
      calldata,
      gasEstimate: totalGas,
      balancesBefore: balancesPreRedeem,
      balancesAfter,
      expectedDeltas: {
        morpho_shares_spent: `-${shares.toString()}`,
        USDC_received: usdcReceived.toString(),
      },
      passed: true,
    };

  } catch (err) {
    const balancesAfter = await snapshotBalances(publicClient, params.onBehalfOf);
    return {
      calldata: [],
      gasEstimate: totalGas,
      balancesBefore,
      balancesAfter,
      expectedDeltas: {},
      passed: false,
      failureReason: `Fork execution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
