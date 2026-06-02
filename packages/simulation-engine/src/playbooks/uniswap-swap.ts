// ============================================================
// Uniswap V3 Swap Playbook (WETH → USDC only in V1)
// Used for reserve management: converts WETH to USDC when the
// treasury needs stablecoin liquidity for operations/payroll.
//
// Enforces mandate max_slippage_bps before executing.
// Never used for yield — yield comes from Aave/Morpho.
// ============================================================

import {
  encodeFunctionData,
  parseUnits,
  type PublicClient,
  type WalletClient,
} from "viem";
import { getActiveContracts, getActiveChainId, snapshotBalances, getTokenBalance } from "../fork-context.js";
import { readEthUsdPriceBps } from "../oracles/chainlink.js";
import type { PlaybookCalldata, PlaybookResult } from "./aave-supply.js";

const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function" as const,
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable" as const,
  },
] as const;

// Uniswap V3 SwapRouter02 exactInputSingle
const SWAP_ROUTER_ABI = [
  {
    name: "exactInputSingle",
    type: "function" as const,
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "payable" as const,
  },
] as const;

// WETH/USDC pool fee: 500 bps (0.05%) — the primary deep pool on Base
const WETH_USDC_POOL_FEE = 500;

export interface UniswapSwapParams {
  amountInHuman: string;   // WETH amount to swap, e.g. "0.5"
  recipient: `0x${string}`;
  signerAddress: `0x${string}`;
  maxSlippageBps: number;  // from mandate, e.g. 30 = 0.30%
  mandateVersionId: string;
}

export async function simulateUniswapWethToUsdc(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: UniswapSwapParams
): Promise<PlaybookResult> {
  const contracts = getActiveContracts();

  // Uniswap V3 router availability check — zero address means not deployed on this chain
  if (contracts.UNISWAP_V3_ROUTER === "0x0000000000000000000000000000000000000000") {
    return {
      calldata: [], gasEstimate: 0n,
      balancesBefore: {}, balancesAfter: {}, expectedDeltas: {},
      passed: false,
      failureReason: `Uniswap V3 is not configured on chain ${getActiveChainId()}`,
    };
  }

  const amountIn = parseUnits(params.amountInHuman, 18);

  const balancesBefore = await snapshotBalances(publicClient, params.recipient);
  const wethBalance = await getTokenBalance(publicClient, contracts.WETH, params.recipient);

  if (wethBalance < amountIn) {
    return {
      calldata: [],
      gasEstimate: 0n,
      balancesBefore,
      balancesAfter: balancesBefore,
      expectedDeltas: {},
      passed: false,
      failureReason: `Insufficient WETH. Have ${wethBalance.toString()}, need ${amountIn.toString()}`,
    };
  }

  // ── Get fresh WETH price from Chainlink for minimum output calculation ────
  let expectedAmountOut = 0n;
  try {
    const ethUsd6 = await readEthUsdPriceBps(publicClient);
    // amountIn is WETH in 18 decimals; USDC output is 6 decimals
    expectedAmountOut = (amountIn * ethUsd6) / 1_000_000_000_000_000_000n;
  } catch (err) {
    return {
      calldata: [],
      gasEstimate: 0n,
      balancesBefore,
      balancesAfter: balancesBefore,
      expectedDeltas: {},
      passed: false,
      failureReason: `Fresh Chainlink price fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (expectedAmountOut === 0n) {
    return {
      calldata: [],
      gasEstimate: 0n,
      balancesBefore,
      balancesAfter: balancesBefore,
      expectedDeltas: {},
      passed: false,
      failureReason: "Chainlink returned zero price — oracle may be stale",
    };
  }

  // Apply slippage tolerance: amountOutMinimum = oracleEstimate * (1 - slippageBps/10000)
  const slippageFactor = 10000n - BigInt(params.maxSlippageBps);
  const amountOutMinimum = (expectedAmountOut * slippageFactor) / 10000n;

  // ── Build calldata ─────────────────────────────────────────
  const approveData = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [contracts.UNISWAP_V3_ROUTER, amountIn],
  });

  const swapData = encodeFunctionData({
    abi: SWAP_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [{
      tokenIn: contracts.WETH,
      tokenOut: contracts.USDC,
      fee: WETH_USDC_POOL_FEE,
      recipient: params.recipient,
      amountIn,
      amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    }],
  });

  const calldata: PlaybookCalldata[] = [
    {
      to: contracts.WETH,
      data: approveData,
      description: `Approve Uniswap Router to spend ${params.amountInHuman} WETH`,
    },
    {
      to: contracts.UNISWAP_V3_ROUTER,
      data: swapData,
      description: `Swap ${params.amountInHuman} WETH → USDC (min ${(Number(amountOutMinimum) / 1e6).toFixed(2)} USDC, max slippage ${params.maxSlippageBps}bps)`,
    },
  ];

  // ── Execute approve first, then estimate + execute swap ───────────────────
  // Must execute approve before estimating swap gas (same pattern as Aave supply)
  let totalGas = 0n;
  try {
    const approveGas = await publicClient.estimateGas({
      account: params.recipient,
      to: contracts.WETH,
      data: approveData,
    });

    // Execute approve so router has WETH allowance
    const approveHash = await walletClient.sendTransaction({
      account: params.signerAddress,
      to: contracts.WETH,
      data: approveData,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    // Estimate swap gas now that allowance is in place
    const swapGas = await publicClient.estimateGas({
      account: params.recipient,
      to: contracts.UNISWAP_V3_ROUTER,
      data: swapData,
    });
    totalGas = approveGas + swapGas;

    // Execute swap
    const swapHash = await walletClient.sendTransaction({
      account: params.signerAddress,
      to: contracts.UNISWAP_V3_ROUTER,
      data: swapData,
      chain: null,
    });
    await publicClient.waitForTransactionReceipt({ hash: swapHash });

    const balancesAfter = await snapshotBalances(publicClient, params.recipient);
    const usdcAfter = await getTokenBalance(publicClient, contracts.USDC, params.recipient);
    const usdcBefore = BigInt(balancesBefore.usdc);
    const usdcReceived = usdcAfter - usdcBefore;

    if (usdcReceived <= 0n) {
      return {
        calldata,
        gasEstimate: totalGas,
        balancesBefore,
        balancesAfter,
        expectedDeltas: {},
        passed: false,
        failureReason: "Swap completed but no USDC received",
      };
    }

    // Verify slippage was within bounds
    if (usdcReceived < amountOutMinimum) {
      return {
        calldata,
        gasEstimate: totalGas,
        balancesBefore,
        balancesAfter,
        expectedDeltas: {},
        passed: false,
        failureReason: `Received ${usdcReceived.toString()} USDC, below minimum ${amountOutMinimum.toString()}`,
      };
    }

    const slippagePct = ((Number(expectedAmountOut) - Number(usdcReceived)) / Number(expectedAmountOut)) * 100;

    return {
      calldata,
      gasEstimate: totalGas,
      balancesBefore,
      balancesAfter,
      expectedDeltas: {
        WETH_spent: `-${amountIn.toString()}`,
        USDC_received: usdcReceived.toString(),
        slippage_pct: slippagePct.toFixed(4),
      },
      passed: true,
    };

  } catch (err) {
    const balancesAfter = await snapshotBalances(publicClient, params.recipient);
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
