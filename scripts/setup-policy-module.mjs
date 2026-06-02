#!/usr/bin/env node
// ============================================================
// setup-policy-module.mjs
//
// One-time Safe setup for PolicyEnforcedModule.
// Submits a single MultiSend Safe proposal that:
//   1. Enables the PolicyEnforcedModule on the Safe
//   2. Sets the onchain policy (maxSingleAction, dailyLimit, floor)
//   3. Approves Aave V3 Pool as an allowed target
//   4. Approves MultiSendCallOnly as an allowed target
//
// After this proposal is signed + executed (2-of-3), the agent
// runs fully autonomously within policy bounds — no human signing
// per execution needed.
//
// Usage:
//   node scripts/setup-policy-module.mjs [--dry-run]
// ============================================================

import { readFileSync } from "node:fs";
import { encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createWalletClient, http, hashTypedData } from "viem";

// ── Config ────────────────────────────────────────────────────

const SAFE_ADDRESS        = "0xead39d939A83A8e57a61b9ebf4209142Df8ED690";
const MODULE_ADDRESS      = "0x85Cc2c401BFEb95415262467C2bE4C46100a5696"; // PolicyEnforcedModule
const AAVE_V3_POOL        = "0x07eA79F68B2B3df564D0A34F8e19D9B1e339814b"; // Base Sepolia
const MULTI_SEND_ONLY     = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2"; // MultiSendCallOnly
const SAFE_TX_SERVICE     = "https://api.safe.global/tx-service/basesep";
const RPC_URL             = "https://sepolia.base.org";
const CHAIN_ID            = 84532;

// Policy params (6-decimal USDC)
const MAX_SINGLE_ACTION   = 100_000_000n;  // $100 per action
const DAILY_LIMIT         = 500_000_000n;  // $500 per day
const RESERVE_FLOOR       = 50_000_000n;   // $50 minimum uninvested

// ── ABIs ──────────────────────────────────────────────────────

const SAFE_ABI = [{
  name: "enableModule",
  type: "function",
  inputs: [{ name: "module", type: "address" }],
  outputs: [],
  stateMutability: "nonpayable",
}];

const MODULE_ABI = [
  {
    name: "setPolicy",
    type: "function",
    inputs: [
      { name: "maxSingleActionUsdc", type: "uint256" },
      { name: "dailyLimitUsdc",      type: "uint256" },
      { name: "reserveFloorUsdc",    type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "addApprovedTarget",
    type: "function",
    inputs: [{ name: "target", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
];

const SAFE_TX_TYPES = {
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

// MultiSend ABI (same MultiSendCallOnly address)
const MULTI_SEND_ABI = [{
  name: "multiSend",
  type: "function",
  inputs: [{ name: "transactions", type: "bytes" }],
  outputs: [],
  stateMutability: "payable",
}];

// ── MultiSend packing ─────────────────────────────────────────

function packMultiSendCall(to, data, value = 0n) {
  const toBytes   = Buffer.from(to.slice(2), "hex"); // 20 bytes
  const valueHex  = value.toString(16).padStart(64, "0");
  const valueBuf  = Buffer.from(valueHex, "hex"); // 32 bytes
  const dataBuf   = Buffer.from(data.slice(2), "hex");
  const lenHex    = dataBuf.length.toString(16).padStart(64, "0");
  const lenBuf    = Buffer.from(lenHex, "hex"); // 32 bytes
  return Buffer.concat([
    Buffer.from([0]),  // operation: CALL
    toBytes,
    valueBuf,
    lenBuf,
    dataBuf,
  ]);
}

// ── Load private key ──────────────────────────────────────────

function loadEnv() {
  const env = {};
  try {
    readFileSync("/Users/zartaj/Test-Workspace/defi-composer/.env", "utf8")
      .split("\n")
      .filter(l => l.includes("=") && !l.startsWith("#"))
      .forEach(l => {
        const i = l.indexOf("=");
        env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
      });
  } catch {}
  return env;
}

// ── Main ──────────────────────────────────────────────────────

const isDryRun = process.argv.includes("--dry-run");

const env = loadEnv();
const rawKey = env["EXECUTOR_PRIVATE_KEY"];
if (!rawKey) { console.error("EXECUTOR_PRIVATE_KEY not set"); process.exit(1); }
const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`);
const account = privateKeyToAccount(privateKey);

console.log("=== PolicyEnforcedModule Setup ===");
console.log(`Executor EOA:   ${account.address}`);
console.log(`Safe:           ${SAFE_ADDRESS}`);
console.log(`Module:         ${MODULE_ADDRESS}`);
console.log(`Aave Pool:      ${AAVE_V3_POOL}`);
console.log(`Max/action:     $${Number(MAX_SINGLE_ACTION) / 1e6}`);
console.log(`Daily limit:    $${Number(DAILY_LIMIT) / 1e6}`);
console.log(`Reserve floor:  $${Number(RESERVE_FLOOR) / 1e6}`);
console.log("");

// Build the four call payloads
const call1 = encodeFunctionData({ abi: SAFE_ABI,   functionName: "enableModule",     args: [MODULE_ADDRESS] });
const call2 = encodeFunctionData({ abi: MODULE_ABI, functionName: "setPolicy",         args: [MAX_SINGLE_ACTION, DAILY_LIMIT, RESERVE_FLOOR] });
const call3 = encodeFunctionData({ abi: MODULE_ABI, functionName: "addApprovedTarget", args: [AAVE_V3_POOL] });
const call4 = encodeFunctionData({ abi: MODULE_ABI, functionName: "addApprovedTarget", args: [MULTI_SEND_ONLY] });

console.log("Batch transactions:");
console.log(`  1. enableModule(${MODULE_ADDRESS})`);
console.log(`  2. setPolicy($${Number(MAX_SINGLE_ACTION)/1e6}, $${Number(DAILY_LIMIT)/1e6}, $${Number(RESERVE_FLOOR)/1e6})`);
console.log(`  3. addApprovedTarget(${AAVE_V3_POOL})  ← Aave V3 Pool`);
console.log(`  4. addApprovedTarget(${MULTI_SEND_ONLY})  ← MultiSendCallOnly`);
console.log("");

// Pack into MultiSend
const packed = Buffer.concat([
  packMultiSendCall(SAFE_ADDRESS,    call1),
  packMultiSendCall(MODULE_ADDRESS,  call2),
  packMultiSendCall(MODULE_ADDRESS,  call3),
  packMultiSendCall(MODULE_ADDRESS,  call4),
]);

const multiSendData = encodeFunctionData({
  abi: MULTI_SEND_ABI,
  functionName: "multiSend",
  args: [`0x${packed.toString("hex")}`],
});

// Get current Safe nonce and check for pending proposals
const nonceRes = await fetch(`${SAFE_TX_SERVICE}/api/v1/safes/${SAFE_ADDRESS}/`);
const nonceData = await nonceRes.json();
const safeNonce = nonceData.nonce;

// Find the next available nonce: Safe nonce + count of pending proposals
const pendingRes = await fetch(
  `${SAFE_TX_SERVICE}/api/v1/safes/${SAFE_ADDRESS}/multisig-transactions/?executed=false&nonce__gte=${safeNonce}&limit=10`
);
const pendingData = await pendingRes.json();
const pendingAtOrAfter = (pendingData.results ?? []).filter(t => Number(t.nonce) >= safeNonce);
const nonce = pendingAtOrAfter.length > 0
  ? Math.max(...pendingAtOrAfter.map(t => Number(t.nonce))) + 1
  : safeNonce;

console.log(`Safe nonce: ${safeNonce} | Pending proposals: ${pendingAtOrAfter.length} | Using nonce: ${nonce}`);

// Build SafeTx struct
const safeTxMessage = {
  to:             MULTI_SEND_ONLY,
  value:          0n,
  data:           multiSendData,
  operation:      1,              // DELEGATECALL for MultiSend
  safeTxGas:      0n,
  baseGas:        0n,
  gasPrice:       0n,
  gasToken:       "0x0000000000000000000000000000000000000000",
  refundReceiver: "0x0000000000000000000000000000000000000000",
  nonce:          BigInt(nonce),
};

const domain = {
  chainId:           CHAIN_ID,
  verifyingContract: SAFE_ADDRESS,
};

const safeTxHash = hashTypedData({
  domain,
  types:       SAFE_TX_TYPES,
  primaryType: "SafeTx",
  message:     safeTxMessage,
});

console.log(`safeTxHash: ${safeTxHash}`);

if (isDryRun) {
  console.log("\n[DRY RUN] — not submitting. Remove --dry-run to submit.");
  process.exit(0);
}

// Sign
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(RPC_URL),
});

const signature = await walletClient.signTypedData({
  domain,
  types:       SAFE_TX_TYPES,
  primaryType: "SafeTx",
  message:     safeTxMessage,
});

// Submit to Safe TX Service
const body = {
  to:             MULTI_SEND_ONLY,
  value:          "0",
  data:           multiSendData,
  operation:      1,
  safeTxGas:      "0",
  baseGas:        "0",
  gasPrice:       "0",
  gasToken:       "0x0000000000000000000000000000000000000000",
  refundReceiver: "0x0000000000000000000000000000000000000000",
  nonce:          nonce,
  contractTransactionHash: safeTxHash,
  sender:         account.address,
  signature,
};

const postRes = await fetch(
  `${SAFE_TX_SERVICE}/api/v1/safes/${SAFE_ADDRESS}/multisig-transactions/`,
  {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  }
);

if (!postRes.ok) {
  const err = await postRes.text();
  console.error(`\n❌ Failed: ${postRes.status} ${err}`);
  process.exit(1);
}

console.log(`\n✅ Setup proposal submitted!`);
console.log(`   safeTxHash: ${safeTxHash}`);
console.log(`   nonce:      ${nonce}`);
console.log(`\nNext step: Go to app.safe.global and execute this proposal.`);
console.log(`After execution, the agent will run fully autonomously.`);
