#!/usr/bin/env node
// ============================================================
// patch-policy-module-v2-addresses.mjs
//
// Corrective Safe proposal (nonce 10) for PolicyEnforcedModule V2.
//
// Context: The V2 setup at nonce 9 used the wrong USDC and Aave
// Pool addresses. The simulation engine (fork-context.ts) uses:
//   USDC:      0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f  (795 USDC)
//   Aave Pool: 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27
//
// But the V2 module was configured with:
//   USDC:      0x036CbD53842c5426634e7929541eC2318f3dCF7e  (only 30 USDC)
//   Aave Pool: 0x07eA79F68B2B3df564D0A34F8e19D9B1e339814b
//
// This patch submits 8 calls:
//   1. removeApprovedTarget(old USDC)
//   2. removeApprovedTarget(old Aave Pool)
//   3. setUsdcToken(correct USDC)             — reserve-floor now checks correct balance
//   4. addApprovedTarget(correct USDC)
//   5. addApprovedTarget(correct Aave Pool)
//   6. approveSelector(correct USDC,  approve(address,uint256))
//   7. approveSelector(correct Aave,  supply(address,uint256,address,uint16))
//   8. approveSelector(correct Aave,  withdraw(address,uint256,address))
//
// Usage:
//   node scripts/patch-policy-module-v2-addresses.mjs [--dry-run]
// ============================================================

import { readFileSync } from "node:fs";
import { encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createWalletClient, http, hashTypedData } from "viem";

// ── Addresses ──────────────────────────────────────────────────
const SAFE_ADDRESS    = "0xead39d939A83A8e57a61b9ebf4209142Df8ED690";
const MODULE_V2       = "0x0f19895c838a05203fea681774367deedf74e8d8";
const MULTI_SEND_ONLY = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";

// Wrong addresses (from nonce-9 setup — need to remove)
const USDC_OLD        = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const AAVE_OLD        = "0x07eA79F68B2B3df564D0A34F8e19D9B1e339814b";

// Correct addresses (used by simulation-engine/fork-context.ts)
const USDC_CORRECT    = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f"; // 795 USDC in Safe
const AAVE_CORRECT    = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27"; // Pool used by simulation

const SAFE_TX_SERVICE = "https://api.safe.global/tx-service/basesep";
const RPC_URL         = "https://sepolia.base.org";
const CHAIN_ID        = 84532;

// Selectors
const SEL_APPROVE  = "0x095ea7b3"; // approve(address,uint256)
const SEL_SUPPLY   = "0x617ba037"; // supply(address,uint256,address,uint16)
const SEL_WITHDRAW = "0x69328dec"; // withdraw(address,uint256,address)

// ── ABIs ────────────────────────────────────────────────────────
const MODULE_ABI = [
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
    name: "removeApprovedTarget",
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
  const toBytes  = Buffer.from(to.slice(2).padStart(40, "0"), "hex");
  const valueHex = value.toString(16).padStart(64, "0");
  const valueBuf = Buffer.from(valueHex, "hex");
  const dataBuf  = Buffer.from(data.slice(2), "hex");
  const lenHex   = dataBuf.length.toString(16).padStart(64, "0");
  const lenBuf   = Buffer.from(lenHex, "hex");
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

console.log("=== PolicyEnforcedModule V2 — Address Patch ===");
console.log(`Executor EOA:     ${account.address}`);
console.log(`Safe:             ${SAFE_ADDRESS}`);
console.log(`Module V2:        ${MODULE_V2}`);
console.log(`Removing USDC:    ${USDC_OLD}  (wrong — only 30 USDC here)`);
console.log(`Removing Aave:    ${AAVE_OLD}  (wrong pool)`);
console.log(`Adding USDC:      ${USDC_CORRECT}  (795 USDC here)`);
console.log(`Adding Aave:      ${AAVE_CORRECT}  (pool used by simulation)`);
console.log("");

// ── Build calls ─────────────────────────────────────────────────
const calls = [
  // 1. Remove old wrong USDC target
  {
    to:    MODULE_V2,
    data:  encodeFunctionData({ abi: MODULE_ABI, functionName: "removeApprovedTarget", args: [USDC_OLD] }),
    label: `V2.removeApprovedTarget(USDC_OLD ${USDC_OLD.slice(0,10)}...)`,
  },
  // 2. Remove old wrong Aave target
  {
    to:    MODULE_V2,
    data:  encodeFunctionData({ abi: MODULE_ABI, functionName: "removeApprovedTarget", args: [AAVE_OLD] }),
    label: `V2.removeApprovedTarget(AAVE_OLD ${AAVE_OLD.slice(0,10)}...)`,
  },
  // 3. Update usdcToken to correct address (fixes reserve-floor balance check)
  {
    to:    MODULE_V2,
    data:  encodeFunctionData({ abi: MODULE_ABI, functionName: "setUsdcToken", args: [USDC_CORRECT] }),
    label: `V2.setUsdcToken(USDC_CORRECT ${USDC_CORRECT.slice(0,10)}...)`,
  },
  // 4. Add correct USDC as approved target
  {
    to:    MODULE_V2,
    data:  encodeFunctionData({ abi: MODULE_ABI, functionName: "addApprovedTarget", args: [USDC_CORRECT] }),
    label: `V2.addApprovedTarget(USDC_CORRECT)`,
  },
  // 5. Add correct Aave Pool as approved target
  {
    to:    MODULE_V2,
    data:  encodeFunctionData({ abi: MODULE_ABI, functionName: "addApprovedTarget", args: [AAVE_CORRECT] }),
    label: `V2.addApprovedTarget(AAVE_CORRECT)`,
  },
  // 6. USDC.approve selector on correct USDC
  {
    to:    MODULE_V2,
    data:  encodeFunctionData({ abi: MODULE_ABI, functionName: "approveSelector", args: [USDC_CORRECT, SEL_APPROVE] }),
    label: `V2.approveSelector(USDC_CORRECT, approve)`,
  },
  // 7. Aave.supply selector on correct pool
  {
    to:    MODULE_V2,
    data:  encodeFunctionData({ abi: MODULE_ABI, functionName: "approveSelector", args: [AAVE_CORRECT, SEL_SUPPLY] }),
    label: `V2.approveSelector(AAVE_CORRECT, supply)`,
  },
  // 8. Aave.withdraw selector on correct pool
  {
    to:    MODULE_V2,
    data:  encodeFunctionData({ abi: MODULE_ABI, functionName: "approveSelector", args: [AAVE_CORRECT, SEL_WITHDRAW] }),
    label: `V2.approveSelector(AAVE_CORRECT, withdraw)`,
  },
];

console.log("Batch transactions:");
calls.forEach((c, i) => console.log(`  ${i + 1}. ${c.label}`));
console.log("");

// ── Pack into MultiSend ─────────────────────────────────────────
const packed = Buffer.concat(calls.map(c => packMultiSendCall(c.to, c.data)));
const multiSendData = encodeFunctionData({
  abi:          MULTI_SEND_ABI,
  functionName: "multiSend",
  args:         [`0x${packed.toString("hex")}`],
});

// ── Get current nonce ───────────────────────────────────────────
const safeInfoRes = await fetch(`${SAFE_TX_SERVICE}/api/v1/safes/${SAFE_ADDRESS}/`);
if (!safeInfoRes.ok) {
  console.error(`Failed to fetch Safe info: ${safeInfoRes.status} ${await safeInfoRes.text()}`);
  process.exit(1);
}
const safeInfo = await safeInfoRes.json();
const safeNonce = safeInfo.nonce;

const pendingRes = await fetch(
  `${SAFE_TX_SERVICE}/api/v1/safes/${SAFE_ADDRESS}/multisig-transactions/?executed=false&nonce__gte=${safeNonce}&limit=20`
);
const pendingData = await pendingRes.json();
const pendingAtOrAfter = (pendingData.results ?? []).filter(t => Number(t.nonce) >= safeNonce);
const nonce = pendingAtOrAfter.length > 0
  ? Math.max(...pendingAtOrAfter.map(t => Number(t.nonce))) + 1
  : safeNonce;

console.log(`Safe on-chain nonce: ${safeNonce} | Pending: ${pendingAtOrAfter.length} | Using nonce: ${nonce}`);

// ── Build SafeTx ────────────────────────────────────────────────
const safeTxMessage = {
  to:             MULTI_SEND_ONLY,
  value:          0n,
  data:           multiSendData,
  operation:      1,               // DELEGATECALL for MultiSend
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

console.log(`\nsafeTxHash: ${safeTxHash}`);

if (isDryRun) {
  console.log("\n[DRY RUN] — not submitting. Remove --dry-run to submit.");
  process.exit(0);
}

// ── Sign ────────────────────────────────────────────────────────
const walletClient = createWalletClient({
  account,
  chain:     baseSepolia,
  transport: http(RPC_URL),
});

const signature = await walletClient.signTypedData({
  domain,
  types:       SAFE_TX_TYPES,
  primaryType: "SafeTx",
  message:     safeTxMessage,
});

// ── Submit to Safe Transaction Service ─────────────────────────
const body = {
  to:                      MULTI_SEND_ONLY,
  value:                   "0",
  data:                    multiSendData,
  operation:               1,
  safeTxGas:               "0",
  baseGas:                 "0",
  gasPrice:                "0",
  gasToken:                "0x0000000000000000000000000000000000000000",
  refundReceiver:          "0x0000000000000000000000000000000000000000",
  nonce,
  contractTransactionHash: safeTxHash,
  sender:                  account.address,
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
  console.error(`\n❌ Submission failed: ${postRes.status} — ${err}`);
  process.exit(1);
}

console.log(`\n✅ Address patch proposal submitted!`);
console.log(`   safeTxHash: ${safeTxHash}`);
console.log(`   nonce:      ${nonce}`);
console.log(`   calls:      ${calls.length}`);
console.log(`\nNext step: Go to app.safe.global, sign this proposal with your second owner key, and execute.`);
console.log(`After execution:`);
console.log(`  - Module targets updated to correct Sepolia USDC + Aave addresses`);
console.log(`  - Reserve-floor balance check reads correct USDC (795 available)`);
console.log(`  - Selectors re-approved on the correct contract addresses`);
console.log(`  - Autonomous cycle should succeed end-to-end`);
