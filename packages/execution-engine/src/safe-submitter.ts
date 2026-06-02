// ============================================================
// SafeSubmitter
// Submits fork-proven transactions to Safe Transaction Service.
//
// Flow:
//   1. Fetch current Safe nonce from Safe API
//   2. Fill nonce into SafeTxStruct
//   3. Compute canonical EIP-712 safeTxHash (viem hashTypedData)
//   4. Sign with EXECUTOR_PRIVATE_KEY (proposer — holds NO funds)
//   5. POST to Safe Transaction Service
//   6. Return safeTxHash for tracking
//
// The Safe Transaction Service for Base:
//   https://safe-transaction-base.safe.global
//
// Requires:
//   EXECUTOR_PRIVATE_KEY  — a plain EOA key, not an owner.
//                           Safe allows anyone to propose.
//                           Owners sign separately in Safe UI.
// ============================================================

import {
  createWalletClient,
  createPublicClient,
  http,
  hashTypedData,
  type Hex,
  type Address,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { SafeTxStruct, SafeTxEip712 } from "@defi-composer/simulation-engine";
import { encodeSafeTxForSigning } from "@defi-composer/simulation-engine";

// Safe TX Service URLs (new API gateway format as of 2025):
//   Base mainnet : https://api.safe.global/tx-service/base
//   Base Sepolia : https://api.safe.global/tx-service/basesep
//
// SAFE_TX_SERVICE_URL env overrides the default (mainnet).
const SAFE_TX_SERVICE =
  process.env["SAFE_TX_SERVICE_URL"] ??
  "https://api.safe.global/tx-service/base";

/** Chain ID read from CHAIN_ID env (default 8453 = Base mainnet). */
function getChainId(): number {
  return parseInt(process.env["CHAIN_ID"] ?? "8453", 10);
}

/** Viem chain object matching CHAIN_ID. */
function getChain() {
  return getChainId() === 84532 ? baseSepolia : base;
}

/** Base RPC URL: BASE_RPC_URL env or chain default. */
function getRpcUrl(): string {
  return (
    process.env["BASE_RPC_URL"] ??
    (getChainId() === 84532 ? "https://sepolia.base.org" : "https://mainnet.base.org")
  );
}

// ─── Types ────────────────────────────────────────────────────

export interface SubmitProposalParams {
  safeAddress: Address;
  safeTxStruct: SafeTxStruct;    // nonce=0 from buildSafeTxStruct — we fill real nonce here
  simulationId: string;          // for logging
}

export interface SubmitProposalResult {
  safeTxHash: Hex;
  nonce: number;
  proposerAddress: Address;
  submittedAt: string;
}

export interface SafeExecutionStatus {
  safeTxHash: Hex;
  isExecuted: boolean;
  executionTxHash: Hex | null;
  confirmationsRequired: number;
  confirmationsSubmitted: number;
  executedAt: string | null;
}

// ─── Safe API helpers ─────────────────────────────────────────

async function safeApiGet<T>(path: string): Promise<T> {
  const url = `${SAFE_TX_SERVICE}${path}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Safe API GET ${path} failed ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function safeApiPost(path: string, body: Record<string, unknown>): Promise<void> {
  const url = `${SAFE_TX_SERVICE}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`Safe API POST ${path} failed ${res.status}: ${bodyText.slice(0, 300)}`);
  }
}

// ─── Core functions ───────────────────────────────────────────

/** Fetch the current nonce for the next pending Safe transaction. */
export async function getSafeNonce(safeAddress: Address): Promise<number> {
  const data = await safeApiGet<{ nonce: number }>(`/api/v1/safes/${safeAddress}/`);
  return data.nonce;
}

/**
 * Fetch Safe metadata — also validates the Safe exists on Base.
 * Returns null if address is not a deployed Safe.
 */
export async function getSafeInfo(safeAddress: Address): Promise<{
  nonce: number;
  threshold: number;
  owners: string[];
} | null> {
  try {
    const data = await safeApiGet<{
      nonce: number;
      threshold: number;
      owners: string[];
    }>(`/api/v1/safes/${safeAddress}/`);
    return data;
  } catch {
    return null;
  }
}

/**
 * Submit a fork-proven transaction as a Safe proposal.
 *
 * 1. Fetches real nonce from Safe API
 * 2. Fills nonce into struct
 * 3. Computes canonical EIP-712 safeTxHash
 * 4. Signs with EXECUTOR_PRIVATE_KEY
 * 5. POSTs to Safe Transaction Service
 */
export async function submitSafeProposal(
  params: SubmitProposalParams
): Promise<SubmitProposalResult> {
  const rawKey = process.env["EXECUTOR_PRIVATE_KEY"];
  if (!rawKey) {
    throw new Error(
      "EXECUTOR_PRIVATE_KEY not set. " +
      "Set it to a funded EOA key that will propose (not execute) Safe transactions. " +
      "The key does not need to be a Safe owner — it only signs the proposal."
    );
  }
  // Normalize: viem requires the 0x prefix; accept keys with or without it.
  const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;

  const account = privateKeyToAccount(privateKey);

  // 1. Get real nonce
  const nonce = await getSafeNonce(params.safeAddress);

  // 2. Fill nonce
  const struct: SafeTxStruct = { ...params.safeTxStruct, nonce };

  // 3. Build EIP-712 payload
  const eip712: SafeTxEip712 = encodeSafeTxForSigning(struct, params.safeAddress, getChainId());

  // 4. Compute canonical safeTxHash using viem's hashTypedData
  const safeTxHash = hashTypedData({
    domain:      eip712.domain as Parameters<typeof hashTypedData>[0]["domain"],
    types:       eip712.types,
    primaryType: "SafeTx",
    message:     eip712.message as Record<string, unknown>,
  }) as Hex;

  // 5. Sign with proposer wallet
  const walletClient = createWalletClient({
    account,
    chain: getChain(),
    transport: http(getRpcUrl()),
  });

  const signature = await walletClient.signTypedData({
    domain:      eip712.domain as Parameters<typeof walletClient.signTypedData>[0]["domain"],
    types:       eip712.types,
    primaryType: "SafeTx",
    message:     eip712.message as Record<string, unknown>,
  });

  // 6. POST to Safe Transaction Service
  await safeApiPost(
    `/api/v1/safes/${params.safeAddress}/multisig-transactions/`,
    {
      to:             struct.to,
      value:          struct.value,
      data:           struct.data,
      operation:      struct.operation,
      safeTxGas:      struct.safeTxGas,
      baseGas:        struct.baseGas,
      gasPrice:       struct.gasPrice,
      gasToken:       struct.gasToken,
      refundReceiver: struct.refundReceiver,
      nonce:          struct.nonce,
      contractTransactionHash: safeTxHash,
      sender:         account.address,
      signature,
    }
  );

  console.log(
    `[SafeSubmitter] Proposal submitted: safeTxHash=${safeTxHash} ` +
    `nonce=${nonce} safe=${params.safeAddress} simulation=${params.simulationId}`
  );

  return {
    safeTxHash,
    nonce,
    proposerAddress: account.address,
    submittedAt: new Date().toISOString(),
  };
}

/**
 * Poll the Safe Transaction Service for execution status.
 * Returns null if the safeTxHash is not found.
 */
export async function getSafeExecutionStatus(
  safeAddress: Address,
  safeTxHash: Hex
): Promise<SafeExecutionStatus | null> {
  try {
    const data = await safeApiGet<{
      isExecuted: boolean;
      transactionHash: string | null;
      confirmationsRequired: number;
      confirmations: Array<unknown>;
      executionDate: string | null;
    }>(`/api/v1/multisig-transactions/${safeTxHash}/`);

    return {
      safeTxHash,
      isExecuted: data.isExecuted,
      executionTxHash: data.transactionHash as Hex | null,
      confirmationsRequired: data.confirmationsRequired,
      confirmationsSubmitted: data.confirmations?.length ?? 0,
      executedAt: data.executionDate,
    };
  } catch {
    return null;
  }
}

/**
 * List pending Safe proposals — useful for the frontend
 * to display "awaiting approval" state.
 */
export async function listPendingSafeProposals(safeAddress: Address): Promise<Array<{
  safeTxHash: Hex;
  nonce: number;
  to: string;
  confirmationsRequired: number;
  confirmationsSubmitted: number;
  submissionDate: string;
}>> {
  try {
    const data = await safeApiGet<{
      results: Array<{
        safeTxHash: string;
        nonce: number;
        to: string;
        confirmationsRequired: number;
        confirmations: Array<unknown>;
        submissionDate: string;
        isExecuted: boolean;
      }>;
    }>(`/api/v1/safes/${safeAddress}/multisig-transactions/?executed=false&limit=20`);

    return data.results.map(r => ({
      safeTxHash:              r.safeTxHash as Hex,
      nonce:                   r.nonce,
      to:                      r.to,
      confirmationsRequired:   r.confirmationsRequired,
      confirmationsSubmitted:  r.confirmations?.length ?? 0,
      submissionDate:          r.submissionDate,
    }));
  } catch {
    return [];
  }
}
