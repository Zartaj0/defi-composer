#!/usr/bin/env node
// ============================================================
// verify-fork.mjs — Canonical fork verification harness
//
// Single source of truth. Runs identically for Claude, Codex, CI.
// Imports from compiled dist/ — run `pnpm build` first.
//
// Usage:
//   pnpm verify:fork                              # spawns local Anvil
//   FORK_RPC_URL=http://127.0.0.1:18100 pnpm verify:fork  # use existing fork
//   NO_PROXY=* pnpm verify:fork                   # bypass macOS proxy crash
//
// Exit 0  — all checks correct
// Exit 1  — one or more checks wrong
// Exit 2  — environment error (Anvil crash, build missing)
//
// Always writes scripts/verify-fork-report.json
// ============================================================

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── Colour helpers ──────────────────────────────────────────────
const G = s => `\x1b[32m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;
const D = s => `\x1b[2m${s}\x1b[0m`;

// ── Import compiled simulation engine ───────────────────────────
let mandateSimulator;
try {
  const mod = await import(join(ROOT, "packages/simulation-engine/dist/mandate-simulator.js"));
  mandateSimulator = mod.mandateSimulator;
} catch (err) {
  console.error(R("\nERROR: Could not import simulation engine."));
  console.error(R("Run `pnpm build` first, then retry.\n"));
  console.error(D(err.message));
  process.exit(2);
}

// ── Chain detection ─────────────────────────────────────────────
const CHAIN_ID   = parseInt(process.env.CHAIN_ID ?? "8453", 10);
const IS_SEPOLIA = CHAIN_ID === 84532;

// ── Test definitions ────────────────────────────────────────────
const BASE = {
  mandateVersionId:  "verify-fork-test",
  approvedAssets:    ["USDC", "WETH"],
  approvedProtocols: ["aave-v3", "uniswap-v3", "morpho"],
  approvedActions:   ["supply", "withdraw", "swap", "deposit"],
  blockedActions:    ["borrow", "leverage"],
  maxSlippageBps:    100,
  reserveFloorUsd:   500,
};

const TESTS = [
  // ── Real fork playbooks ─────────────────────────────────────
  {
    id: "aave-supply-usdc",
    label: "Aave V3 — supply 1,000 USDC",
    playbook: "aave_supply_usdc",
    amountHuman: "1000.00",
    liquidUsd: 100_000,
    expectPass: true,
  },
  {
    id: "aave-withdraw-usdc",
    label: "Aave V3 — withdraw 500 USDC (roundtrip)",
    playbook: "aave_withdraw_usdc",
    amountHuman: "500.00",
    liquidUsd: 100_000,
    expectPass: true,
  },
  {
    id: "uniswap-weth-usdc",
    label: "Uniswap V3 — swap 0.1 WETH → USDC",
    playbook: "uniswap_weth_to_usdc",
    amountHuman: "0.1",
    liquidUsd: 100_000,
    // On Sepolia: Uniswap has no WETH/USDC pool — graceful failure is correct.
    // On mainnet: Chainlink staleness is acceptable (oracle may lag on fork).
    expectPass: !IS_SEPOLIA,
    allowBlockedBy: IS_SEPOLIA ? "not configured on chain" : "Chainlink price is stale",
  },
  {
    id: "morpho-deposit-usdc",
    label: "Morpho Steakhouse — deposit 500 USDC (ERC-4626)",
    playbook: "morpho_deposit_usdc",
    amountHuman: "500.00",
    liquidUsd: 100_000,
    // Morpho Steakhouse is mainnet-only; Sepolia failure is correct.
    expectPass: !IS_SEPOLIA,
    allowBlockedBy: IS_SEPOLIA ? "not deployed on chain" : undefined,
  },
  {
    id: "morpho-withdraw-usdc",
    label: "Morpho Steakhouse — withdraw 250 USDC (ERC-4626)",
    playbook: "morpho_withdraw_usdc",
    amountHuman: "250.00",
    liquidUsd: 100_000,
    expectPass: !IS_SEPOLIA,
    allowBlockedBy: IS_SEPOLIA ? "not deployed on chain" : undefined,
  },
  // ── Policy gates (no fork needed — blocked before Anvil starts)
  {
    id: "policy-reserve-floor",
    label: "Policy — reserve floor breach blocked",
    playbook: "aave_supply_usdc",
    amountHuman: "1000.00",
    liquidUsd: 100_000,
    mandateOverride: { reserveFloorUsd: 99_500 },
    expectPass: false,
    expectBlockedBy: "reserve floor",
  },
  {
    id: "policy-no-state",
    label: "Policy — missing observedState blocked",
    playbook: "aave_supply_usdc",
    amountHuman: "1000.00",
    // liquidUsd intentionally omitted
    expectPass: false,
    expectBlockedBy: "Observed liquid treasury value",
  },
  {
    id: "policy-blocked-action",
    label: "Policy — explicitly blocked action",
    playbook: "aave_supply_usdc",
    amountHuman: "1000.00",
    liquidUsd: 100_000,
    mandateOverride: { blockedActions: ["supply"] },
    expectPass: false,
    expectBlockedBy: "explicitly blocked",
  },
  {
    id: "policy-unapproved-protocol",
    label: "Policy — unapproved protocol blocked",
    playbook: "uniswap_weth_to_usdc",
    amountHuman: "0.1",
    liquidUsd: 100_000,
    mandateOverride: { approvedProtocols: ["aave-v3"] },
    expectPass: false,
    expectBlockedBy: "not in mandate approvedProtocols",
  },
];

// ── Run tests ───────────────────────────────────────────────────
console.log(B("\n╔════════════════════════════════════════════════╗"));
console.log(B("║       DeFi Composer — Fork Verification        ║"));
console.log(B("╚════════════════════════════════════════════════╝\n"));

const env = {
  FORK_RPC_URL:  process.env.FORK_RPC_URL  ?? "(spawn local Anvil)",
  BASE_RPC_URL:  process.env.BASE_RPC_URL  ?? "https://mainnet.base.org",
  FORK_MODE:     process.env.FORK_MODE     ?? "true",
  ANVIL_BIN:     process.env.ANVIL_BIN     ?? "anvil",
};
for (const [k, v] of Object.entries(env)) console.log(D(`  ${k.padEnd(14)}: ${v}`));
console.log();

const results = [];
const startAll = Date.now();

for (const tc of TESTS) {
  const mandate = { ...BASE, ...(tc.mandateOverride ?? {}) };
  const t = Date.now();
  process.stdout.write(`  ${tc.label}... `);

  let r;
  try {
    const req = {
      playbook: tc.playbook,
      mandate,
      params: { amountHuman: tc.amountHuman },
      orgId: "verify-fork",
    };
    if (tc.liquidUsd !== undefined) {
      req.observedState = { liquidUsd: tc.liquidUsd };
    }

    const artifact = await mandateSimulator.run(req);
    const ms = Date.now() - t;
    const gotPass = artifact.status === "passed";

    // Verify the reason substring if we expected a block
    let reasonOk = true;
    if (!tc.expectPass && tc.expectBlockedBy && artifact.failureReason) {
      reasonOk = artifact.failureReason.toLowerCase()
        .includes(tc.expectBlockedBy.toLowerCase());
    }
    const allowedSafetyBlock =
      tc.allowBlockedBy &&
      !gotPass &&
      artifact.failureReason?.toLowerCase().includes(tc.allowBlockedBy.toLowerCase());
    const correct = ((gotPass === tc.expectPass) && reasonOk) || Boolean(allowedSafetyBlock);

    r = { id: tc.id, label: tc.label, correct, ms,
          outcome: gotPass ? "PASS" : "BLOCKED",
          block: artifact.forkBlockNumber || null,
          validUntil: artifact.validUntilBlock || null,
          gas: artifact.gasEstimate || null,
          calldataHash: artifact.calldataHash !== "0x" ? artifact.calldataHash : null,
          deltas: Object.keys(artifact.expectedDeltas).length ? artifact.expectedDeltas : null,
          reason: artifact.failureReason || null };

    if (correct) {
      if (gotPass) {
        process.stdout.write(G("✓ PASS") + D(` ${ms}ms | gas=${r.gas?.toLocaleString()} | block=${r.block}`) + "\n");
        if (r.deltas) {
          for (const [k, v] of Object.entries(r.deltas)) {
            console.log(D(`      ${k}: ${v}`));
          }
        }
      } else if (allowedSafetyBlock) {
        console.log(Y("✓ SAFETY BLOCK") + D(` (accepted) | ${r.reason?.slice(0, 100)}`));
      } else {
        console.log(G("✓ BLOCKED") + D(` (expected) | ${r.reason?.slice(0, 80)}`));
      }
    } else {
      console.log(R("✗ WRONG") + D(` | expected=${tc.expectPass} got=${gotPass} | ${r.reason?.slice(0,80) ?? "no reason"}`));
    }

  } catch (err) {
    const ms = Date.now() - t;
    const msg = err.message ?? String(err);
    r = { id: tc.id, label: tc.label, correct: false, ms, outcome: "ERROR", error: msg.slice(0,300) };

    // Anvil crash — hard exit with instructions
    if (msg.includes("NULL object") || msg.includes("dynamic_store") ||
        msg.includes("SCDynamicStore") || msg.includes("Anvil failed to start")) {
      console.error(R("\n\n  ✗ ANVIL CRASH — process cannot spawn Anvil binary.\n"));
      console.error(Y("  This is a process sandbox issue, not a code bug.\n"));
      console.error(Y("  Fixes (try in order):\n"));
      console.error(Y("    1.  foundryup  &&  pnpm verify:fork\n"));
      console.error(Y("    2.  NO_PROXY='*' HTTP_PROXY='' pnpm verify:fork\n"));
      console.error(Y("    3.  Start a fork externally, then:\n"));
      console.error(Y("        # Terminal 1:\n"));
      console.error(Y("        anvil --fork-url https://mainnet.base.org --port 18100\n"));
      console.error(Y("        # Terminal 2:\n"));
      console.error(Y("        FORK_RPC_URL=http://127.0.0.1:18100 pnpm verify:fork\n"));
      console.error(Y("    4.  npx hardhat node --fork https://mainnet.base.org --port 18100\n"));
      console.error(Y("        FORK_RPC_URL=http://127.0.0.1:18100 pnpm verify:fork\n"));
      writeReport([], env, startAll, true);
      process.exit(2);
    }

    console.log(R("✗ ERROR") + D(` ${ms}ms | ${msg.slice(0, 100)}`));
  }

  results.push(r);
}

// ── Summary ──────────────────────────────────────────────────────
const correct = results.filter(r => r.correct).length;
const total = results.length;
const passed = results.filter(r => r.outcome === "PASS").length;
const blocked = results.filter(r => r.outcome === "BLOCKED" && r.correct).length;
const errors = results.filter(r => r.outcome === "ERROR").length;
const allOk = correct === total;

console.log();
console.log("  " + "─".repeat(48));
const verdict = allOk ? G("ALL CORRECT") : R("FAILURES DETECTED");
console.log(`  ${verdict}  ${correct}/${total} correct  (${passed} passed, ${blocked} blocked-as-expected, ${errors} errors)`);
console.log(`  Total: ${((Date.now() - startAll)/1000).toFixed(1)}s`);

writeReport(results, env, startAll, false);
process.exit(allOk ? 0 : 1);

// ── Report writer ─────────────────────────────────────────────────
function writeReport(results, envSnap, startAll, crashed) {
  const report = {
    timestamp: new Date().toISOString(),
    crashed,
    environment: envSnap,
    summary: {
      total: results.length,
      correct: results.filter(r => r.correct).length,
      allCorrect: !crashed && results.every(r => r.correct),
    },
    results,
  };
  const path = join(__dirname, "verify-fork-report.json");
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(D(`\n  Report → scripts/verify-fork-report.json`));
}
