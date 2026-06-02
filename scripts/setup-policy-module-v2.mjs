#!/usr/bin/env node
// ============================================================
// setup-policy-module-v2.mjs
//
// One-time Safe setup for PolicyEnforcedModule V2.
// Submits a single MultiSend Safe proposal that:
//   1.  Disables the V1 module (0x85Cc2c...)
//   2.  Enables  the V2 module (0x0f1989...)
//   3.  V2.setUsdcToken(USDC)           — enables reserve-floor enforcement
//   4.  V2.setPolicy(100, 500, 50)      — $100/action · $500/day · $50 floor
//   5.  V2.addApprovedTarget(USDC)      — needed for ERC-20 approve inner calls
//   6.  V2.addApprovedTarget(AavePool)  — supply/withdraw
//   7.  V2.addApprovedTarget(MultiSend) — batched transactions
//   8.  V2.approveSelector(USDC,  0x095ea7b3)  — approve(address,uint256)
//   9.  V2.approveSelector(Aave,  0x617ba037)  — supply(address,uint256,address,uint16)
//   10. V2.approveSelector(Aave,  0x69328dec)  — withdraw(address,uint256,address)
//
// After this proposal is signed + executed (2-of-3), the agent runs
// fully autonomously within policy bounds with full onchain validation.
//
// Usage:
//   node scripts/setup-policy-module-v2.mjs [--dry-run]
// ============================================================

import { readFileSync } from "node:fs";
import { encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createWalletClient, http, hashTypedData } from "viem";

// ── Config ─────────────────────────────────────────────────────
const SAFE_ADDRESS        = "0xead39d939A83A8e57a61b9ebf4209142Df8ED690";
const MODULE_V1           = "0x85Cc2c401BFEb95415262467C2bE4C46100a5696"; // old — disable
const MODULE_V2           = "0x0f19895c838a05203fea681774367deedf74e8d8"; // new — enable
const USDC_SEPOLIA        = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const AAVE_V3_POOL        = "0x07eA79F68B2B3df564D0A34F8e19D9B1e339814b";
const MULTI_SEND_ONLY     = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
const SAFE_TX_SERVICE     = "https://api.safe.global/tx-service/basesep";
const RPC_URL             = "https://sepolia.base.org";
const CHAIN_ID            = 84532;
const SENTINEL_MODULES    = "0x0000000000000000000000000000000000000001";

// Policy params (6-decimal USDC)
const MAX_SINGLE_ACTION   = 100_000_000n;  // $100 per action
const DAILY_LIMIT         = 500_000_000n;  // $500 per day
const RESERVE_FLOOR       = 50_000_000n;   // $50 minimum uninvested

// Verified function selectors (keccak256 of signature, first 4 bytes)
const SEL_APPROVE   = "0x095ea7b3"; // approve(address,uint256)
const SEL_SUPPLY    = "0x617ba037"; // supply(address,uint256,address,uint16)
const SEL_WITHDRAW  = "0x69328dec"; // withdraw(address,uint256,address)

// ── ABIs ────────────────────────────────────────────────────────
const SAFE_ABI = [
  {
    name: "enableModule",
    type: "function",
    inputs: [{ name: "module", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    name: "disableModule",
    type: "function",
    inputs: [
      { name: "prevModule", type: "address" },
      { name: "module",     type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
];

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
    name: "setUsdcToken",
    type: "function",
    inputs: [{ name: "token", type: "address" }],
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
  {
    name: "approveSelector",
    type: "function",
    inputs: [
      { name: "target",   type: "address" },
      { name: "selector", type: "bytes4"  },
    ],
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

const MULTI_SEND_ABI = [{
  name: "multiSend",
  type: "function",
  inputs: [{ name: "transactions", type: "bytes" }],
  outputs: [],
  stateMutability: "payable",
}];

// ── MultiSend packing ───────────────────────────────────────────
function packMultiSendCall(to, data, value = 0n) {
  const toBytes  = Buffer.from(to.slice(2).padStart(40, "0"), "hex"); // 20 bytes
  const valueHex = value.toString(16).padStart(64, "0");
  const valueBuf = Buffer.from(valueHex, "hex"); // 32 bytes
  const dataBuf  = Buffer.from(data.slice(2), "hex");
  const lenHex   = dataBuf.length.toString(16).padStart(64, "0");
  const lenBuf   = Buffer.from(lenHex, "hex"); // 32 bytes
  return Buffer.concat([
    Buffer.from([0]), // operation: CALL
    toBytes,
    valueBuf,
    lenBuf,
    dataBuf,
  ]);
}

// ── Load .env ───────────────────────────────────────────────────
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

// ── Main ────────────────────────────────────────────────────────
const isDryRun = process.argv.includes("--dry-run");
const env = loadEnv();
const rawKey = env["EXECUTOR_PRIVATE_KEY"];
if (!rawKey) { console.error("EXECUTOR_PRIVATE_KEY not set"); process.exit(1); }
const privateKey = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
const account = privateKeyToAccount(privateKey);

console.log("=== PolicyEnforcedModule V2 Setup ===");
console.log(`Executor EOA:     ${account.address}`);
console.log(`Safe:             ${SAFE_ADDRESS}`);
console.log(`V1 module:        ${MODULE_V1}  ← disabling`);
console.log(`V2 module:        ${MODULE_V2}  ← enabling`);
console.log(`USDC (Sepolia):   ${USDC_SEPOLIA}`);
console.log(`Aave V3 Pool:     ${AAVE_V3_POOL}`);
console.log(`Max/action:       $${Number(MAX_SINGLE_ACTION) / 1e6}`);
console.log(`Daily limit:      $${Number(DAILY_LIMIT) / 1e6}`);
console.log(`Reserve floor:    $${Number(RESERVE_FLOOR) / 1e6}  ← enforced onchain`);
console.log("");

// ── Get current module list to find prevModule for disableModule ─
const safeInfoRes = await fetch(`${SAFE_TX_SERVICE}/api/v1/safes/${SAFE_ADDRESS}/`);
const safeInfo = await safeInfoRes.json();
const modules = safeInfo.modules ?? [];
const v1Index = modules.findIndex(m => m.toLowerCase() === MODULE_V1.toLowerCase());
// prevModule: the module that points to V1 in the linked list.
// In Safe's linked list, modules are stored newest-first. The "prev" in
// disableModule(prevModule, module) is the address whose .next == module,
// or SENTINEL if module is at the head.
// If V1 is in modules[0] (head), prevModule = SENTINEL.
// If V1 is at modules[i], prevModule = modules[i-1].
let prevModule;
if (v1Index < 0) {
  console.warn(`V1 module not found in Safe modules list. Skipping disableModule.`);
  prevModule = null;
} else if (v1Index === 0) {
  prevModule = SENTINEL_MODULES;
} else {
  prevModule = modules[v1Index - 1];
}
console.log(`Current modules:  ${modules.join(", ") || "(none)"}`);
console.log(`prevModule for disableModule: ${prevModule ?? "N/A (skip)"}`);
console.log("");

// ── Build call payloads ─────────────────────────────────────────
const calls = [];

// 1. Disable V1 (if found)
if (prevModule !== null) {
  calls.push({
    to: SAFE_ADDRESS,
    data: encodeFunctionData({ abi: SAFE_ABI, functionName: "disableModule", args: [prevModule, MODULE_V1] }),
    label: `disableModule(${MODULE_V1.slice(0,10)}...)`,
  });
}

// 2. Enable V2
calls.push({
  to: SAFE_ADDRESS,
  data: encodeFunctionData({ abi: SAFE_ABI, functionName: "enableModule", args: [MODULE_V2] }),
  label: `enableModule(V2)`,
});

// 3. setUsdcToken
calls.push({
  to: MODULE_V2,
  data: encodeFunctionData({ abi: MODULE_ABI, functionName: "setUsdcToken", args: [USDC_SEPOLIA] }),
  label: `V2.setUsdcToken(USDC)`,
});

// 4. setPolicy
calls.push({
  to: MODULE_V2,
  data: encodeFunctionData({ abi: MODULE_ABI, functionName: "setPolicy", args: [MAX_SINGLE_ACTION, DAILY_LIMIT, RESERVE_FLOOR] }),
  label: `V2.setPolicy($${Number(MAX_SINGLE_ACTION)/1e6}, $${Number(DAILY_LIMIT)/1e6}, $${Number(RESERVE_FLOOR)/1e6})`,
});

// 5-7. addApprovedTarget
for (const [addr, name] of [[USDC_SEPOLIA, "USDC"], [AAVE_V3_POOL, "Aave Pool"], [MULTI_SEND_ONLY, "MultiSend"]]) {
  calls.push({
    to: MODULE_V2,
    data: encodeFunctionData({ abi: MODULE_ABI, functionName: "addApprovedTarget", args: [addr] }),
    label: `V2.addApprovedTarget(${name})`,
  });
}

// 8-10. approveSelector
const selectors = [
  [USDC_SEPOLIA,  SEL_APPROVE,  "USDC.approve(address,uint256)"],
  [AAVE_V3_POOL,  SEL_SUPPLY,   "Aave.supply(address,uint256,address,uint16)"],
  [AAVE_V3_POOL,  SEL_WITHDRAW, "Aave.withdraw(address,uint256,address)"],
];
for (const [target, sel, label] of selectors) {
  calls.push({
    to: MODULE_V2,
    data: encodeFunctionData({ abi: MODULE_ABI, functionName: "approveSelector", args: [target, sel] }),
    label: `V2.approveSelector(${label})`,
  });
}

console.log("Batch transactions:");
calls.forEach((c, i) => console.log(`  ${i + 1}. ${c.label}`));
console.log("");

// ── Pack into MultiSend ─────────────────────────────────────────
const packed = Buffer.concat(calls.map(c => packMultiSendCall(c.to, c.data)));
const multiSendData = encodeFunctionData({
  abi: MULTI_SEND_ABI,
  functionName: "multiSend",
  args: [`0x${packed.toString("hex")}`],
});

// ── Get nonce ───────────────────────────────────────────────────
const safeNonce = safeInfo.nonce;
const pendingRes = await fetch(
  `${SAFE_TX_SERVICE}/api/v1/safes/${SAFE_ADDRESS}/multisig-transactions/?executed=false&nonce__gte=${safeNonce}&limit=20`
);
const pendingData = await pendingRes.json();
const pendingAtOrAfter = (pendingData.results ?? []).filter(t => Number(t.nonce) >= safeNonce);
const nonce = pendingAtOrAfter.length > 0
  ? Math.max(...pendingAtOrAfter.map(t => Number(t.nonce))) + 1
  : safeNonce;

console.log(`Safe nonce: ${safeNonce} | Pending: ${pendingAtOrAfter.length} | Using nonce: ${nonce}`);

// ── Build and sign SafeTx ───────────────────────────────────────
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

const domain = { chainId: CHAIN_ID, verifyingContract: SAFE_ADDRESS };

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

// ── Sign and submit ─────────────────────────────────────────────
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
  nonce,
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

console.log(`\n✅ V2 setup proposal submitted!`);
console.log(`   safeTxHash: ${safeTxHash}`);
console.log(`   nonce:      ${nonce}`);
console.log(`   calls:      ${calls.length}`);
console.log(`\nNext step: Go to app.safe.global and sign + execute this proposal.`);
console.log(`After execution:`);
console.log(`  - V1 module disabled`);
console.log(`  - V2 module active with reserve floor + selector validation`);
console.log(`  - Agent runs fully autonomous with hardened onchain policy`);
