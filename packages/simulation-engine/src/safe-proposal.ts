// ============================================================
// SafeProposal
// Pure utility — no external HTTP calls.
//
// Takes fork-proven calldata (SimulationArtifact.inputCalldata)
// and builds a Safe transaction struct + EIP-712 payload for
// off-chain signing.
//
// FORK_MODE=true (V1):
//   The caller is responsible for fetching the Safe nonce from
//   https://safe-transaction-base.safe.global and submitting the
//   signed struct to the Safe Transaction Service.
//   This module never calls any external API.
//
// Batch encoding (>1 call):
//   Uses MultiSendCallOnly on Base:
//   0x9641d764fc13c8B624c04430C7356C1C7C8102e2
//   Each call is packed: operation(1) + to(20) + value(32) + dataLen(32) + data(N)
//   The Safe tx.data = multiSend(bytes packed).
//   operation = 1 (DELEGATECALL) so Safe delegates into MultiSend.
//
// Single call:
//   to   = target contract
//   data = raw calldata
//   operation = 0 (CALL)
// ============================================================

import { encodeFunctionData, pad, toHex, concat, keccak256, toBytes } from "viem";
import type { Hex } from "viem";

// ─── Constants ────────────────────────────────────────────────
const MULTI_SEND_CALL_ONLY = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2" as const;
const ADDRESS_ZERO = "0x0000000000000000000000000000000000000000" as const;

// Minimal MultiSend ABI — only the function we need
const MULTI_SEND_ABI = [
  {
    name: "multiSend",
    type: "function" as const,
    inputs: [{ name: "transactions", type: "bytes" }],
    outputs: [],
    stateMutability: "payable" as const,
  },
] as const;

// ─── Public types ──────────────────────────────────────────────

/**
 * Safe transaction struct ready for signing and submission.
 * nonce is 0 here — the caller must replace it with the value
 * fetched from:
 *   GET https://safe-transaction-base.safe.global/api/v1/safes/{address}/
 */
export interface SafeTxStruct {
  to: string;
  value: string;
  data: string;
  operation: 0 | 1;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: string;
  refundReceiver: string;
  nonce: number;
}

/**
 * EIP-712 typed data payload. Pass to eth_signTypedData_v4 or
 * viem's signTypedData to produce the owner signature for Safe.
 */
export interface SafeTxEip712 {
  domain: {
    chainId: number;
    verifyingContract: string;
  };
  types: {
    SafeTx: Array<{ name: string; type: string }>;
  };
  message: {
    to: string;
    value: string;
    data: string;
    operation: number;
    safeTxGas: string;
    baseGas: string;
    gasPrice: string;
    gasToken: string;
    refundReceiver: string;
    nonce: number;
  };
}

// ─── Internal helpers ─────────────────────────────────────────

/**
 * Encode a single call into the MultiSend packed format:
 *   operation (1 byte) | to (20 bytes) | value (32 bytes) | dataLength (32 bytes) | data
 *
 * All our playbook calls have value=0.
 */
function encodeMultiSendCall(call: {
  to: string;
  data: string;
  value?: string;
}): Uint8Array {
  const operationByte = new Uint8Array([0]); // 0 = CALL within MultiSend packed tx

  // to: 20 bytes (padded left to 20)
  const toPadded = pad(call.to as Hex, { size: 20, dir: "left" });

  // value: 32 bytes (always 0 for our playbooks)
  const valueHex = toHex(BigInt(call.value ?? "0"));
  const valuePadded = pad(valueHex, { size: 32, dir: "left" });

  // data and its length
  const dataHex = (call.data ?? "0x") as Hex;
  const dataRaw = hexToBytes(dataHex);
  const dataLenPadded = pad(toHex(BigInt(dataRaw.length)), { size: 32, dir: "left" });

  // concat: operation(1) + to(20) + value(32) + dataLength(32) + data(N)
  const parts: readonly Hex[] = [
    toHex(operationByte),
    toPadded,
    valuePadded,
    dataLenPadded,
    dataHex,
  ];

  return hexToBytes(concat(parts));
}

/** Convert a hex string to Uint8Array */
function hexToBytes(hex: Hex): Uint8Array {
  // Use viem's toBytes — always safe with hex strings
  return toBytes(hex);
}

function bytesToHex(bytes: Uint8Array): Hex {
  return toHex(bytes);
}

// ─── Exported functions ────────────────────────────────────────

/**
 * Build a SafeTxStruct from fork-proven calldata.
 *
 * @param calldata  Array of {to, data, value?} from SimulationArtifact.inputCalldata
 * @param gasEstimate  From SimulationArtifact.gasEstimate (used for metadata only; safeTxGas is "0")
 * @returns SafeTxStruct with nonce=0 (caller must fill real nonce before signing)
 */
export function buildSafeTxStruct(
  calldata: Array<{ to: string; data: string; value?: string }>,
  _gasEstimate: number,
): SafeTxStruct {
  if (calldata.length === 0) {
    throw new Error("calldata must contain at least one transaction");
  }

  const base: Omit<SafeTxStruct, "to" | "data" | "operation"> = {
    value: "0",
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: ADDRESS_ZERO,
    refundReceiver: ADDRESS_ZERO,
    nonce: 0,
  };

  if (calldata.length === 1) {
    const call = calldata[0]!;
    return {
      ...base,
      to: call.to,
      data: call.data,
      operation: 0, // CALL
    };
  }

  // Batch: pack all calls into MultiSend format
  const packed: Uint8Array[] = calldata.map(call => encodeMultiSendCall(call));

  // Concatenate all packed calls
  const totalLen = packed.reduce((acc, b) => acc + b.length, 0);
  const allPacked = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of packed) {
    allPacked.set(chunk, offset);
    offset += chunk.length;
  }

  const packedHex = bytesToHex(allPacked);

  const multiSendData = encodeFunctionData({
    abi: MULTI_SEND_ABI,
    functionName: "multiSend",
    args: [packedHex],
  });

  return {
    ...base,
    to: MULTI_SEND_CALL_ONLY,
    data: multiSendData,
    operation: 1, // DELEGATECALL for MultiSend
  };
}

/**
 * Produce EIP-712 typed data for signing a SafeTxStruct.
 *
 * The returned object can be passed directly to:
 *   - viem signTypedData({ account, domain, types, primaryType, message })
 *   - eth_signTypedData_v4 in any wallet
 *   - Safe Transaction Service POST body (with signature appended)
 *
 * @param safeTxStruct  From buildSafeTxStruct (fill real nonce before calling this)
 * @param safeAddress   The Safe multisig address that will execute the tx
 * @param chainId       8453 for Base mainnet
 */
export function encodeSafeTxForSigning(
  safeTxStruct: SafeTxStruct,
  safeAddress: string,
  chainId: number,
): SafeTxEip712 {
  const domain = {
    chainId,
    verifyingContract: safeAddress,
  };

  const types = {
    SafeTx: [
      { name: "to",             type: "address" },
      { name: "value",          type: "uint256" },
      { name: "data",           type: "bytes"   },
      { name: "operation",      type: "uint8"   },
      { name: "safeTxGas",      type: "uint256" },
      { name: "baseGas",        type: "uint256" },
      { name: "gasPrice",       type: "uint256" },
      { name: "gasToken",       type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "nonce",          type: "uint256" },
    ],
  };

  const message = {
    to:             safeTxStruct.to,
    value:          safeTxStruct.value,
    data:           safeTxStruct.data,
    operation:      safeTxStruct.operation,
    safeTxGas:      safeTxStruct.safeTxGas,
    baseGas:        safeTxStruct.baseGas,
    gasPrice:       safeTxStruct.gasPrice,
    gasToken:       safeTxStruct.gasToken,
    refundReceiver: safeTxStruct.refundReceiver,
    nonce:          safeTxStruct.nonce,
  };

  return { domain, types, message };
}

/**
 * Compute a stable identifier for this Safe tx proposal.
 * This is NOT the canonical EIP-712 SafeTxHash — for the real hash,
 * use viem's hashTypedData with the output of encodeSafeTxForSigning.
 * This is a convenience reference ID for logging and correlation.
 */
export function computeSafeTxHash(
  safeTxStruct: SafeTxStruct,
  safeAddress: string,
  chainId: number,
): Hex {
  const payload = JSON.stringify({
    safeAddress,
    chainId,
    nonce: safeTxStruct.nonce,
    to: safeTxStruct.to,
    data: safeTxStruct.data,
    operation: safeTxStruct.operation,
  });
  return keccak256(toBytes(payload));
}
