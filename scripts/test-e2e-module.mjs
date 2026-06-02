#!/usr/bin/env node
// ============================================================
// test-e2e-module.mjs — Phase 2 E2E: AgentExecutorModule flow
//
// Tests:
//   Step 1: Fork-simulate aave_supply_usdc (same as Phase 1)
//   Step 2: Submit Safe proposal to approve the calldataHash
//           (module.approveCalldata(hash, validUntilBlock))
//   Step 3: [Manual] Safe owners sign + execute the approval tx
//   Step 4: executor calls module.execute() directly — no multisig
//
// Prerequisites:
//   1. `pnpm build` completed
//   2. EXECUTOR_PRIVATE_KEY in .env
//   3. MODULE_ADDRESS set in .env (deployed AgentExecutorModule)
//   4. Safe has Aave test USDC (0xba50Cd2A...)
//
// Usage:
//   node scripts/test-e2e-module.mjs
// ============================================================

import "dotenv/config";
import { randomUUID } from "node:crypto";

process.env["CHAIN_ID"]            = "84532";
process.env["BASE_RPC_URL"]        = process.env["BASE_RPC_URL_SEPOLIA"] ?? "https://sepolia.base.org";
process.env["SAFE_TX_SERVICE_URL"] = "https://api.safe.global/tx-service/basesep";
process.env["SAFE_ADDRESS"]        = "0xead39d939A83A8e57a61b9ebf4209142Df8ED690";
process.env["MODULE_ADDRESS"]      = process.env["MODULE_ADDRESS"] ?? "0xb745DCd470E6bD3D0cB873E9088444e0f68771C0";
process.env["FORK_MODE"]           = "true";
process.env["ANVIL_BASE_PORT"]     = "19300";

const SAFE_ADDRESS  = "0xead39d939A83A8e57a61b9ebf4209142Df8ED690";
const MODULE_ADDRESS = process.env["MODULE_ADDRESS"];
const AMOUNT_HUMAN  = "5.00";

const B = s => `\x1b[1m${s}\x1b[0m`;
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;

console.log(B("\n╔════════════════════════════════════════════════╗"));
console.log(B("║   DeFi Composer — Module Executor E2E Test     ║"));
console.log(B("╚════════════════════════════════════════════════╝\n"));
console.log(D(`  CHAIN_ID    : 84532 (Base Sepolia)`));
console.log(D(`  SAFE        : ${SAFE_ADDRESS}`));
console.log(D(`  MODULE      : ${MODULE_ADDRESS}`));
console.log(D(`  AMOUNT      : $${AMOUNT_HUMAN} USDC`));
console.log();

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

// ── Load modules ───────────────────────────────────────────────
console.log("Loading modules...");
let mandateSimulator, buildSafeTxStruct, approveOnSafe, executeViaModule, computeApprovalHash;
try {
  const sim  = await import(`${ROOT}/packages/simulation-engine/dist/index.js`);
  const exec = await import(`${ROOT}/packages/execution-engine/dist/index.js`);
  mandateSimulator   = sim.mandateSimulator;
  buildSafeTxStruct  = sim.buildSafeTxStruct;
  approveOnSafe      = exec.approveOnSafe;
  executeViaModule   = exec.executeViaModule;
  computeApprovalHash = exec.computeApprovalHash;
} catch (err) {
  console.error(R(`  ✗ Module load failed: ${err.message}`));
  process.exit(1);
}
console.log(G("  ✓ Modules loaded\n"));

// ── Step 1: Fork simulation ────────────────────────────────────
console.log("Step 1/3  Running fork simulation...");
const mandate = {
  mandateVersionId:  "module-e2e-test",
  approvedAssets:    ["USDC"],
  approvedProtocols: ["aave-v3"],
  approvedActions:   ["supply", "withdraw"],
  blockedActions:    ["borrow", "leverage"],
  maxSlippageBps:    50,
  reserveFloorUsd:   0,
};
const decisionId = `dec_mod_${randomUUID().slice(0, 8)}`;
let artifact;
try {
  artifact = await mandateSimulator.run({
    playbook: "aave_supply_usdc",
    mandate,
    params:   { amountHuman: AMOUNT_HUMAN, onBehalfOf: SAFE_ADDRESS },
    observedState: { liquidUsd: 100 },
    decisionId,
    orgId: "module-e2e-test",
  });
} catch (err) {
  console.error(R(`  ✗ Simulation threw: ${err.message}`));
  process.exit(1);
}
if (artifact.status !== "passed") {
  console.error(R(`  ✗ Simulation FAILED: ${artifact.failureReason}`));
  process.exit(1);
}
console.log(G(`  ✓ Simulation PASSED  gas=${artifact.gasEstimate.toLocaleString()}`));
console.log(D(`    calldataHash = ${artifact.calldataHash}`));

// ── Build Safe tx struct (same as what the module will execute) ─
const safeTxStruct = buildSafeTxStruct(artifact.inputCalldata, artifact.gasEstimate);
const approvalHash = computeApprovalHash(safeTxStruct);

console.log(D(`    approvalHash = ${approvalHash}`));
console.log(D(`    to           = ${safeTxStruct.to}`));
console.log(D(`    operation    = ${safeTxStruct.operation} (${safeTxStruct.operation === 1 ? "DELEGATECALL/MultiSend" : "CALL"})`));

// ── Step 2: Submit approval proposal to Safe ───────────────────
console.log("\nStep 2/3  Submitting approveCalldata proposal to Safe TX Service...");
let approveResult;
try {
  approveResult = await approveOnSafe(safeTxStruct, artifact.id, 600); // ~20 min window
} catch (err) {
  console.error(R(`  ✗ approveOnSafe failed: ${err.message}`));
  process.exit(1);
}

console.log(G("  ✓ Approval proposal submitted!"));
console.log(D(`    safeTxHash     = ${approveResult.safeTxHash}`));
console.log(D(`    approvalHash   = ${approveResult.approvalHash}`));
console.log(D(`    validUntilBlock= ${approveResult.validUntilBlock}`));
console.log(D(`    proposer       = ${approveResult.proposerAddress}`));

// ── Step 3: Manual sign + execute instructions ─────────────────
console.log();
console.log("  " + "─".repeat(56));
console.log(Y("\n  ⏳  MANUAL STEP REQUIRED\n"));
console.log("  The Safe proposal calls:");
console.log(`    module.approveCalldata(${approveResult.approvalHash}, ${approveResult.validUntilBlock})`);
console.log();
console.log("  1. Open Safe UI and sign with 2-of-3 owners:");
console.log(`     https://app.safe.global/base-sep:${SAFE_ADDRESS}`);
console.log();
console.log("  2. Once executed on-chain, run:");
console.log(`     node scripts/test-e2e-module-execute.mjs \\`);
console.log(`       ${safeTxStruct.to} \\`);
console.log(`       ${safeTxStruct.value} \\`);
console.log(`       '${safeTxStruct.data.slice(0, 20)}...' \\`);
console.log(`       ${safeTxStruct.operation} \\`);
console.log(`       ${artifact.id}`);
console.log();
console.log("  (Or set MODULE_APPROVED=true and re-run this script with --execute)");
console.log();

// ── Auto-execute if --execute flag and approval is live ────────
if (process.argv.includes("--execute")) {
  console.log("Step 3/3  Executing via module (--execute flag set)...");
  try {
    const execResult = await executeViaModule(safeTxStruct, artifact.id);
    console.log(G("  ✓ Executed via AgentExecutorModule!"));
    console.log(D(`    txHash      = ${execResult.txHash}`));
    console.log(D(`    blockNumber = ${execResult.blockNumber}`));
    console.log(D(`    executedAt  = ${execResult.executedAt}`));
    console.log();
    console.log(B("  ✅  Phase 2 COMPLETE — Autonomous execution confirmed!\n"));
  } catch (err) {
    console.error(R(`  ✗ executeViaModule failed: ${err.message}`));
    console.error(D("    Is the approval live on-chain? Run without --execute first."));
    process.exit(1);
  }
} else {
  console.log(D("  (Re-run with --execute after owners approve to complete Phase 2)\n"));
}
