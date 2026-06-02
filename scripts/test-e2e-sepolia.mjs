#!/usr/bin/env node
// ============================================================
// test-e2e-sepolia.mjs — End-to-end pipeline test for Base Sepolia
//
// Tests the full path:
//   mandateSimulator.run() (Sepolia fork proof)
//     → submitSafeProposal() (real Safe TX Service Base Sepolia)
//
// Does NOT require the Sepolia Safe to hold USDC.
// The fork simulation funds a test wallet via storage slot cheat code,
// proves the Aave supply calldata is correct, then submits the proposal
// to the real Safe TX Service for owners to review.
//
// Prerequisites:
//   1. `pnpm build` completed
//   2. EXECUTOR_PRIVATE_KEY set in .env (proposer EOA with Base Sepolia ETH)
//   3. `pnpm seed:sepolia` run (org + mandate in DB)
//   4. Sepolia Safe: 0xead39d939A83A8e57a61b9ebf4209142Df8ED690
//
// Usage:
//   node scripts/test-e2e-sepolia.mjs
//
// Exit 0 — proposal submitted to Safe TX Service
// Exit 1 — test failed (with reason)
// ============================================================

import "dotenv/config";
import { randomUUID } from "node:crypto";

process.env["CHAIN_ID"]             = "84532";
process.env["BASE_RPC_URL"]         = process.env["BASE_RPC_URL_SEPOLIA"] ?? "https://sepolia.base.org";
process.env["SAFE_TX_SERVICE_URL"]  = "https://api.safe.global/tx-service/basesep";
process.env["FORK_MODE"]            = "true";
process.env["ANVIL_BASE_PORT"]      = "19200";   // avoid conflicts with monitor

const SAFE_ADDRESS  = "0xead39d939A83A8e57a61b9ebf4209142Df8ED690";
const AMOUNT_HUMAN  = "5.00";   // small amount — Safe may have 0 USDC, fork will fund test wallet

const B = s => `\x1b[1m${s}\x1b[0m`;
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;

console.log(B("\n╔════════════════════════════════════════════════╗"));
console.log(B("║   DeFi Composer — Sepolia E2E Pipeline Test    ║"));
console.log(B("╚════════════════════════════════════════════════╝\n"));
console.log(D(`  CHAIN_ID           : 84532 (Base Sepolia)`));
console.log(D(`  BASE_RPC_URL       : ${process.env["BASE_RPC_URL"]}`));
console.log(D(`  SAFE_TX_SERVICE    : ${process.env["SAFE_TX_SERVICE_URL"]}`));
console.log(D(`  SAFE               : ${SAFE_ADDRESS}`));
console.log(D(`  AMOUNT             : $${AMOUNT_HUMAN} USDC`));
console.log();

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

// ── Step 1: Load compiled modules ──────────────────────────────
console.log("Step 1/5  Loading simulation engine...");
let mandateSimulator, submitSafeProposal, getSafeInfo, buildSafeTxStruct;
try {
  const sim = await import(`${ROOT}/packages/simulation-engine/dist/index.js`);
  mandateSimulator  = sim.mandateSimulator;
  buildSafeTxStruct = sim.buildSafeTxStruct;
} catch (err) {
  console.error(R(`  ✗ Could not load simulation engine: ${err.message}`));
  console.error(D("    Run `pnpm build` first."));
  process.exit(1);
}

try {
  const exec = await import(`${ROOT}/packages/execution-engine/dist/index.js`);
  submitSafeProposal = exec.submitSafeProposal;
  getSafeInfo        = exec.getSafeInfo;
} catch (err) {
  console.error(R(`  ✗ Could not load execution engine: ${err.message}`));
  process.exit(1);
}
console.log(G("  ✓ Modules loaded"));

// ── Step 2: Verify Safe exists on Base Sepolia ─────────────────
console.log("\nStep 2/5  Verifying Safe on Base Sepolia...");
let safeInfo;
try {
  safeInfo = await getSafeInfo(SAFE_ADDRESS);
  if (!safeInfo) throw new Error("getSafeInfo returned null — Safe not found");
  console.log(G(`  ✓ Safe found:`));
  console.log(D(`    nonce     = ${safeInfo.nonce}`));
  console.log(D(`    threshold = ${safeInfo.threshold}/${safeInfo.owners.length}`));
  console.log(D(`    owners    = ${safeInfo.owners.join(", ")}`));
} catch (err) {
  console.error(R(`  ✗ Safe verification failed: ${err.message}`));
  process.exit(1);
}

// ── Step 3: Run fork simulation ────────────────────────────────
console.log("\nStep 3/5  Running Sepolia fork simulation (aave_supply_usdc)...");
const decisionId = `dec_e2e_${randomUUID().slice(0, 8)}`;
const mandate = {
  mandateVersionId: "e2e-test",
  approvedAssets:    ["USDC"],
  approvedProtocols: ["aave-v3"],
  approvedActions:   ["supply", "withdraw"],
  blockedActions:    ["borrow", "leverage"],
  maxSlippageBps:    50,
  reserveFloorUsd:   0,
};

const t = Date.now();
let artifact;
try {
  artifact = await mandateSimulator.run({
    playbook: "aave_supply_usdc",
    mandate,
    params: {
      amountHuman: AMOUNT_HUMAN,
      onBehalfOf: SAFE_ADDRESS,  // Safe receives aUSDC in calldata
    },
    observedState: { liquidUsd: 100 },  // tells simulator Safe has ~$100
    decisionId,
    orgId: "e2e-test",
  });
} catch (err) {
  console.error(R(`  ✗ Simulation threw: ${err.message}`));
  process.exit(1);
}

const ms = Date.now() - t;
if (artifact.status !== "passed") {
  console.error(R(`  ✗ Simulation FAILED: ${artifact.failureReason}`));
  process.exit(1);
}

console.log(G(`  ✓ Simulation PASSED  ${ms}ms`));
console.log(D(`    block        = ${artifact.forkBlockNumber}`));
console.log(D(`    gas estimate = ${artifact.gasEstimate.toLocaleString()}`));
console.log(D(`    calldataHash = ${artifact.calldataHash}`));
console.log(D(`    calldata ops = ${artifact.inputCalldata.length}`));
if (Object.keys(artifact.expectedDeltas).length > 0) {
  for (const [k, v] of Object.entries(artifact.expectedDeltas)) {
    console.log(D(`    delta.${k.padEnd(20)} = ${v}`));
  }
}

// ── Step 4: Validate calldata references Safe address ──────────
// The Safe address appears ABI-encoded inside the supply calldata hex (without 0x prefix),
// so we strip "0x" and search for the raw 40-char hex address.
console.log("\nStep 4/5  Validating calldata contains Safe address...");
const calldataStr = JSON.stringify(artifact.inputCalldata).toLowerCase();
const safeAddrHex = SAFE_ADDRESS.toLowerCase().replace(/^0x/, "");
if (!calldataStr.includes(safeAddrHex)) {
  console.error(R(`  ✗ Calldata does not reference Safe address ${SAFE_ADDRESS}`));
  console.error(D(`    Calldata: ${calldataStr.slice(0, 300)}`));
  process.exit(1);
}
console.log(G(`  ✓ Calldata references Safe address (onBehalfOf is correct)`));

// Check that executor_private_key is set
if (!process.env["EXECUTOR_PRIVATE_KEY"]) {
  console.error(R(`  ✗ EXECUTOR_PRIVATE_KEY not set — cannot submit Safe proposal`));
  console.error(D("    Set EXECUTOR_PRIVATE_KEY in .env to a Base Sepolia EOA with some ETH."));
  process.exit(1);
}

// ── Step 5: Submit Safe proposal ───────────────────────────────
console.log("\nStep 5/5  Submitting proposal to Safe TX Service (Base Sepolia)...");
const calldata = artifact.inputCalldata;
let safeTxStruct;
try {
  safeTxStruct = buildSafeTxStruct(calldata, artifact.gasEstimate);
} catch (err) {
  console.error(R(`  ✗ buildSafeTxStruct failed: ${err.message}`));
  process.exit(1);
}

let result;
try {
  result = await submitSafeProposal({
    safeAddress: SAFE_ADDRESS,
    safeTxStruct,
    simulationId: artifact.id,
  });
} catch (err) {
  console.error(R(`  ✗ Safe proposal submission failed: ${err.message}`));
  process.exit(1);
}

// ── Summary ────────────────────────────────────────────────────
console.log();
console.log("  " + "─".repeat(50));
console.log(G("\n  ✅  E2E TEST PASSED — Safe proposal submitted!\n"));
console.log(`  safeTxHash    : ${result.safeTxHash}`);
console.log(`  nonce         : ${result.nonce}`);
console.log(`  proposer      : ${result.proposerAddress}`);
console.log(`  submittedAt   : ${result.submittedAt}`);
console.log();
console.log(B("  Next step: approve in Safe UI"));
console.log(`  https://app.safe.global/base-sep:${SAFE_ADDRESS}`);
console.log();
