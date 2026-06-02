'use client';

import { useBalance, useReadContract, useChainId } from 'wagmi';
import { formatUnits } from 'viem';

// USDC contract addresses per chain
const USDC_BY_CHAIN: Record<number, `0x${string}`> = {
  1:     '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // Ethereum mainnet
  8453:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base mainnet
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
  52638: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // contract.dev stagenet (Ethereum fork)
};

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

export function useWalletBalances(address?: `0x${string}`) {
  const chainId = useChainId();
  const usdcAddress = USDC_BY_CHAIN[chainId];

  // ETH / native token balance
  const { data: ethData, isLoading: ethLoading } = useBalance({
    address,
    query: { enabled: Boolean(address) },
  });

  // USDC balance
  const { data: usdcRaw, isLoading: usdcLoading } = useReadContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && usdcAddress) },
  });

  const ethBalance = ethData ? parseFloat(formatUnits(ethData.value, 18)) : 0;
  const usdcBalance = usdcRaw ? parseFloat(formatUnits(usdcRaw as bigint, 6)) : 0;

  return {
    ethBalance,
    usdcBalance,
    ethSymbol: ethData?.symbol ?? 'ETH',
    isLoading: ethLoading || usdcLoading,
    hasUsdcOnChain: Boolean(usdcAddress),
    chainId,
  };
}
