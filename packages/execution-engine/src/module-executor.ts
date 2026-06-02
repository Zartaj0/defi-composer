// ============================================================
// ModuleExecutor
//
// Two-phase autonomous execution via AgentExecutorModule:
//
//   Phase A — approveOnSafe():
//     Submits a Safe multisig proposal to call
//     module.approveCalldata(hash, validUntilBlock).
//     Safe owners sign once, granting the executor a time-
//     limited approval to run the pre-proven calldata.
//
//   Phase B — execute():
//     Executor EOA calls module.execute(to, value, data,
//     operation, simulationId) directly — no multisig needed.
//     Module verifies hash, consumes approval, calls
//     Safe.execTransactionFromModule.
//
// Requires env:
//   EXECUTOR_PRIVATE_KEY   — executor EOA (also Safe proposer)
//   MODULE_ADDRESS         — deployed AgentExecutorModule address
//   SAFE_ADDRESS           — the Safe the module is installed on
//   CHAIN_ID               — 8453 (mainnet) | 84532 (sepolia)
//   BASE_RPC_URL           — RPC endpoint
//   SAFE_TX_SERVICE_URL    — Safe TX Service base URL
// ============================================================

import {
  createWalletClient,
  createPublicClient,
  http,
  keccak256,
  encodeAbiParameters,
  encodeFunctionData,
  type Hex,
  type Address,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { SafeTxStruct } from "@defi-composer/simulation-engine";
import { encodeSafeTxForSigning } from "@defi-composer/simulation-engine";
import { hashTypedData } from "viem";
import { getSafeNonce } from "./safe-submitter.js";

// ─── ABIs ─────────────────────────────────────────────────────

const MODULE_ABI = [
  {
    name: "approveCalldata",
    type: "function" as const,
    inputs: [
      { name: "approvalHash", type: "bytes32" },
      { name: "validUntilBlock", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable" as const,
  },
  {
    name: "execute",
    type: "function" as const,
    inputs: [
      { name: "to",          type: "address" },
      { name: "value",       type: "uint256" },
      { name: "data",        type: "bytes"   },
      { name: "operation",   type: "uint8"   },
      { name: "simulationId", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable" as const,
  },
  {
    name: "isApprovalValid",
    type: "function" as const,
    inputs: [{ name: "approvalHash", type: "bytes32" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view" as const,
  },
] as const;

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Encode a simulationId string as a bytes32 value for contract calls.
 *
 * Handles two cases:
 *   - UUID string:   strip hyphens → 32 hex chars → right-pad to 64 hex chars
 *   - 0x hex string: right-pad / truncate to exactly 66 chars (0x + 64 hex)
 *
 * UUIDs without hyphens are 32 hex chars (16 bytes). Padded to 64 hex chars
 * they occupy the left half of a bytes32, with zeros in the right half.
 */
function encodeSimIdAsBytes32(simulationId: string): Hex {
  if (simulationId.startsWith("0x")) {
    return simulationId.padEnd(66, "0").slice(0, 66) as Hex;
  }
  // Strip UUID hyphens → pure hex string (32 chars = 16 bytes for a UUID)
  const hex = simulationId.replace(/-/g, "");
  return `0x${hex.padEnd(64, "0").slice(0, 64)}` as Hex;
}

// ─── Env helpers ──────────────────────────────────────────────

function getChainId(): number { return parseInt(process.env["CHAIN_ID"] ?? "8453", 10); }
/** Returns the RPC URL that matches the active CHAIN_ID. */
function getRpcUrl(): string {
  if (getChainId() === 84532) {
    return process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org";
  }
  return process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org";
}
function getChain()              { return getChainId() === 84532 ? baseSepolia : base; }
function getSafeTxServiceUrl():  string {
  return process.env["SAFE_TX_SERVICE_URL"] ?? "https://api.safe.global/tx-service/base";
}
function getModuleAddress(): Address {
  const addr = process.env["MODULE_ADDRESS"];
  if (!addr) throw new Error("MODULE_ADDRESS env not set");
  return addr as Address;
}
function getSafeAddress(): Address {
  const addr = process.env["SAFE_ADDRESS"];
  if (!addr) throw new Error("SAFE_ADDRESS env not set");
  return addr as Address;
}
function getAccount() {
  const raw = process.env["EXECUTOR_PRIVATE_KEY"];
  if (!raw) throw new Error("EXECUTOR_PRIVATE_KEY env not set");
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
  return privateKeyToAccount(key);
}

// ─── Types ────────────────────────────────────────────────────

export interface ApproveOnSafeResult {
  safeTxHash: Hex;
  approvalHash: Hex;
  validUntilBlock: number;
  proposerAddress: Address;
  submittedAt: string;
}

export interface ExecuteResult {
  txHash: Hex;
  blockNumber: bigint;
  executedAt: string;
}

// ─── Core ─────────────────────────────────────────────────────

/**
 * Compute the approval hash for a SafeTxStruct.
 * This is what the module stores and verifies:
 *   keccak256(abi.encode(to, value, data, operation))
 */
export function computeApprovalHash(safeTxStruct: SafeTxStruct): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "bytes"   },
        { type: "uint8"   },
      ],
      [
        safeTxStruct.to as Address,
        BigInt(safeTxStruct.value),
        safeTxStruct.data as Hex,
        safeTxStruct.operation,
      ]
    )
  );
}

/**
 * Phase A: Submit a Safe multisig proposal to approve the
 * simulation artifact hash for autonomous execution.
 *
 * @param safeTxStruct   From buildSafeTxStruct (the proven batch)
 * @param simulationId   For logging
 * @param validForBlocks Approval window in blocks (~2s each on Base; 300 ≈ 10 min)
 */
export async function approveOnSafe(
  safeTxStruct: SafeTxStruct,
  simulationId: string,
  validForBlocks = 300
): Promise<ApproveOnSafeResult> {
  const account  = getAccount();
  const module   = getModuleAddress();
  const safe     = getSafeAddress();
  const chainId  = getChainId();
  const chain    = getChain();
  const rpcUrl   = getRpcUrl();
  const txSvcUrl = getSafeTxServiceUrl();

  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  // Current block → validity window
  const currentBlock   = await publicClient.getBlockNumber();
  const validUntilBlock = Number(currentBlock) + validForBlocks;

  const approvalHash = computeApprovalHash(safeTxStruct);

  // Encode: module.approveCalldata(approvalHash, validUntilBlock)
  const innerData = encodeFunctionData({
    abi: MODULE_ABI,
    functionName: "approveCalldata",
    args: [approvalHash, BigInt(validUntilBlock)],
  });

  // Build the Safe tx struct that calls module.approveCalldata
  const approveTxStruct: SafeTxStruct = {
    to:             module,
    value:          "0",
    data:           innerData,
    operation:      0, // CALL
    safeTxGas:      "0",
    baseGas:        "0",
    gasPrice:       "0",
    gasToken:       "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    nonce:          await getSafeNonce(safe),
  };

  // EIP-712 sign and submit to Safe TX Service
  const eip712 = encodeSafeTxForSigning(approveTxStruct, safe, chainId);
  const safeTxHash = hashTypedData({
    domain:      eip712.domain as Parameters<typeof hashTypedData>[0]["domain"],
    types:       eip712.types,
    primaryType: "SafeTx",
    message:     eip712.message as Record<string, unknown>,
  }) as Hex;

  const signature = await walletClient.signTypedData({
    domain:      eip712.domain as Parameters<typeof walletClient.signTypedData>[0]["domain"],
    types:       eip712.types,
    primaryType: "SafeTx",
    message:     eip712.message as Record<string, unknown>,
  });

  const postUrl = `${txSvcUrl}/api/v1/safes/${safe}/multisig-transactions/`;
  const res = await fetch(postUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to:             approveTxStruct.to,
      value:          approveTxStruct.value,
      data:           approveTxStruct.data,
      operation:      approveTxStruct.operation,
      safeTxGas:      approveTxStruct.safeTxGas,
      baseGas:        approveTxStruct.baseGas,
      gasPrice:       approveTxStruct.gasPrice,
      gasToken:       approveTxStruct.gasToken,
      refundReceiver: approveTxStruct.refundReceiver,
      nonce:          approveTxStruct.nonce,
      contractTransactionHash: safeTxHash,
      sender:         account.address,
      signature,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Safe TX Service POST failed ${res.status}: ${body.slice(0, 300)}`);
  }

  console.log(
    `[ModuleExecutor] Approve proposal submitted: ` +
    `approvalHash=${approvalHash} safeTxHash=${safeTxHash} ` +
    `validUntilBlock=${validUntilBlock} simulation=${simulationId}`
  );

  return {
    safeTxHash,
    approvalHash,
    validUntilBlock,
    proposerAddress: account.address,
    submittedAt: new Date().toISOString(),
  };
}

/**
 * Phase B: Execute an approved simulation artifact directly —
 * no multisig needed. Calls module.execute() from the executor EOA.
 *
 * @param safeTxStruct  The same struct used in approveOnSafe
 * @param simulationId  For on-chain event log
 */
export async function executeViaModule(
  safeTxStruct: SafeTxStruct,
  simulationId: string
): Promise<ExecuteResult> {
  const account = getAccount();
  const module  = getModuleAddress();
  const rpcUrl  = getRpcUrl();
  const chain   = getChain();

  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  // Verify approval is valid before sending tx
  const approvalHash = computeApprovalHash(safeTxStruct);
  const isValid = await publicClient.readContract({
    address: module,
    abi:     MODULE_ABI,
    functionName: "isApprovalValid",
    args:    [approvalHash],
  });
  if (!isValid) {
    throw new Error(
      `Approval hash ${approvalHash} is not valid on module ${module}. ` +
      "Either it was never approved, already used, or has expired."
    );
  }

  const simIdBytes = encodeSimIdAsBytes32(simulationId);

  const data = encodeFunctionData({
    abi: MODULE_ABI,
    functionName: "execute",
    args: [
      safeTxStruct.to as Address,
      BigInt(safeTxStruct.value),
      safeTxStruct.data as Hex,
      safeTxStruct.operation,
      simIdBytes,
    ],
  });

  const txHash = await walletClient.sendTransaction({
    account,
    to:   module,
    data,
    chain,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  console.log(
    `[ModuleExecutor] Executed: txHash=${txHash} ` +
    `block=${receipt.blockNumber} simulation=${simulationId}`
  );

  return {
    txHash,
    blockNumber: receipt.blockNumber,
    executedAt: new Date().toISOString(),
  };
}

// ─── PolicyEnforcedModule: single-phase autonomous execution ──

const POLICY_MODULE_ABI = [
  {
    name: "execute",
    type: "function" as const,
    inputs: [
      { name: "to",                  type: "address" },
      { name: "value",               type: "uint256" },
      { name: "data",                type: "bytes"   },
      { name: "operation",           type: "uint8"   },
      { name: "simulationId",        type: "bytes32" },
      { name: "declaredUsdcAmount",  type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable" as const,
  },
  {
    name: "canExecute",
    type: "function" as const,
    inputs: [
      { name: "to",         type: "address" },
      { name: "usdcAmount", type: "uint256" },
    ],
    outputs: [
      { name: "",       type: "bool"   },
      { name: "reason", type: "string" },
    ],
    stateMutability: "view" as const,
  },
] as const;

export interface PolicyExecuteParams {
  safeTxStruct:       SafeTxStruct;
  simulationId:       string;
  declaredUsdcAmount: number;   // 6-decimal USDC (e.g. 50_000_000 = $50)
}

export interface PolicyExecuteResult {
  txHash:      Hex;
  blockNumber: bigint;
  executedAt:  string;
}

/**
 * Execute a fork-proven transaction directly via PolicyEnforcedModule.
 * No Safe multisig approval needed — policy enforces bounds onchain.
 *
 * Prerequisites:
 *   - PolicyEnforcedModule is enabled on the Safe
 *   - Policy is active and target is whitelisted
 *   - declaredUsdcAmount <= maxSingleActionUsdc
 *   - daily limit not exceeded
 */
export async function executePolicyModule(
  params: PolicyExecuteParams
): Promise<PolicyExecuteResult> {
  const { safeTxStruct, simulationId, declaredUsdcAmount } = params;

  const account  = getAccount();
  const chain    = getChain();
  const rpcUrl   = getRpcUrl();
  const module   = getModuleAddress();

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  const simIdBytes = encodeSimIdAsBytes32(simulationId);

  // Pre-flight: check policy will pass before spending gas
  const [canExec, reason] = await publicClient.readContract({
    address:      module,
    abi:          POLICY_MODULE_ABI,
    functionName: "canExecute",
    args:         [safeTxStruct.to as Address, BigInt(declaredUsdcAmount)],
  });

  if (!canExec) {
    throw new Error(
      `[PolicyModule] canExecute() returned false: "${reason}". ` +
      `to=${safeTxStruct.to} amount=$${(declaredUsdcAmount / 1e6).toFixed(2)}`
    );
  }

  const data = encodeFunctionData({
    abi:          POLICY_MODULE_ABI,
    functionName: "execute",
    args: [
      safeTxStruct.to  as Address,
      BigInt(safeTxStruct.value),
      safeTxStruct.data as Hex,
      safeTxStruct.operation,
      simIdBytes,
      BigInt(declaredUsdcAmount),
    ],
  });

  const txHash = await walletClient.sendTransaction({
    account,
    to:    module,
    data,
    chain,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  console.log(
    `[PolicyModule] ✅ Executed autonomously: txHash=${txHash} ` +
    `block=${receipt.blockNumber} sim=${simulationId} ` +
    `amount=$${(declaredUsdcAmount / 1e6).toFixed(2)}`
  );

  return {
    txHash,
    blockNumber: receipt.blockNumber,
    executedAt:  new Date().toISOString(),
  };
}

/**
 * Check if the PolicyEnforcedModule is enabled on the Safe.
 * Returns false if module not set, not enabled, or any error.
 */
export async function isPolicyModuleEnabled(): Promise<boolean> {
  try {
    const module  = process.env["MODULE_ADDRESS"];
    const safe    = process.env["SAFE_ADDRESS"];
    const chainId = parseInt(process.env["CHAIN_ID"] ?? "8453", 10);
    const chain   = chainId === 84532 ? baseSepolia : base;
    const rpcUrl  = chainId === 84532
      ? (process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org")
      : (process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org");

    if (!module || !safe) return false;

    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

    const SAFE_IS_MODULE_ENABLED_ABI = [{
      name:            "isModuleEnabled",
      type:            "function" as const,
      inputs:          [{ name: "module", type: "address" }],
      outputs:         [{ type: "bool" }],
      stateMutability: "view" as const,
    }] as const;

    const enabled = await publicClient.readContract({
      address:      safe as Address,
      abi:          SAFE_IS_MODULE_ENABLED_ABI,
      functionName: "isModuleEnabled",
      args:         [module as Address],
    });

    return enabled as boolean;
  } catch {
    return false;
  }
}
