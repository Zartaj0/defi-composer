#!/usr/bin/env node
// ============================================================
// seed-sepolia.mjs — Bootstrap org + mandate for Base Sepolia E2E test
//
// Creates (idempotently):
//   1. Org "Sepolia Test Treasury" with the Sepolia Safe address
//   2. A treasury wallet entry pointing to the Safe on chain 84532
//   3. An active mandate version with Aave-only policy
//
// Usage:
//   node scripts/seed-sepolia.mjs
//
// Re-runnable: if the org already exists (same safeAddress) it prints the
// existing IDs and exits without creating duplicates.
//
// After seeding, run:
//   CHAIN_ID=84532 BASE_RPC_URL=https://sepolia.base.org \
//   SAFE_TX_SERVICE_URL=https://api.safe.global/tx-service/basesep \
//   MONITOR_RPC_URL=http://127.0.0.1:18100 \
//   node services/monitor/dist/index.js
// ============================================================

import "dotenv/config";
import { randomUUID } from "node:crypto";

const SAFE_ADDRESS = "0xead39d939A83A8e57a61b9ebf4209142Df8ED690";
const CHAIN_ID     = 84532;
const ORG_NAME     = "Sepolia Test Treasury";

// ── Lazy-load the compiled DB package ──────────────────────────
let db;
try {
  const pkg = await import("../packages/db/dist/index.js");
  db = pkg;
} catch (err) {
  console.error("ERROR: Could not load @defi-composer/db dist.");
  console.error("Run `pnpm build` first, then retry.");
  console.error(err.message);
  process.exit(1);
}

const {
  listOrgs,
  createOrg,
  addTreasuryWallet,
  createMandateWithVersion,
  getActiveMandateForOrg,
} = db;

// ── Check for existing org with this Safe ─────────────────────
console.log(`\n🔍  Checking for existing org (Safe=${SAFE_ADDRESS})...`);
const orgs = await listOrgs();
const existing = orgs.find(
  o => o.safeAddress?.toLowerCase() === SAFE_ADDRESS.toLowerCase()
);

if (existing) {
  const mandate = await getActiveMandateForOrg(existing.id);
  console.log(`\n✅  Already seeded:`);
  console.log(`    org.id          = ${existing.id}`);
  console.log(`    org.name        = ${existing.name}`);
  console.log(`    mandate.id      = ${mandate?.id ?? "(none)"}`);
  console.log(`    mandate.status  = ${mandate?.status ?? "(none)"}`);
  process.exit(0);
}

// ── Create org ─────────────────────────────────────────────────
console.log(`\n🏗   Creating org "${ORG_NAME}"...`);
const orgId = `org_${randomUUID().slice(0, 12)}`;
const org = await createOrg({
  id:          orgId,
  name:        ORG_NAME,
  type:        "fund",
  safeAddress: SAFE_ADDRESS,
  riskParams: {
    maxAllocationPerProtocolPct:   100,
    maxDrawdownPct:                10,
    allowLeverage:                 false,
    allowLiquidationRisk:          false,
    allowGovernanceTokenRewards:   false,
    minLiquidityReservePct:        0,
    approvedProtocols:             ["aave-v3"],
    approvedChains:                [84532],
    maxSinglePositionPct:          100,
    requireMultisigForNewStrategy: false,
  },
  feeConfig: {
    managementFeeBps:  0,
    performanceFeePct: 0,
    benchmarkRateBps:  0,
    curatorFeePct:     0,
  },
  notificationChannels: [],
  createdAt:   new Date(),
  updatedAt:   new Date(),
});
console.log(`    org.id = ${org.id}`);

// ── Add treasury wallet ────────────────────────────────────────
console.log(`\n🏦  Adding treasury wallet (chainId=${CHAIN_ID})...`);
const wallet = await addTreasuryWallet({
  id:        `wallet_${randomUUID().slice(0, 12)}`,
  orgId:     org.id,
  address:   SAFE_ADDRESS,
  chainId:   CHAIN_ID,
  role:      "treasury",
  createdAt: new Date(),
  updatedAt: new Date(),
});
console.log(`    wallet.id = ${wallet.id}`);

// ── Create mandate + version ───────────────────────────────────
// Policy:
//   - Only Aave V3 supply/withdraw of USDC (Morpho/Uniswap not on Sepolia)
//   - Reserve floor: $0 (test treasury has test USDC from faucet, no real risk)
//   - maxSingleActionUsd: $50 (the wallet has ~$60 USDC)
console.log(`\n📜  Creating active mandate (Aave-only, USDC, Sepolia)...`);
const mandateId  = `mandate_${randomUUID().slice(0, 12)}`;
const versionId  = `ver_${randomUUID().slice(0, 12)}`;
const now        = new Date();

const result = await createMandateWithVersion({
  mandate: {
    id:        mandateId,
    orgId:     org.id,
    name:      "Sepolia Aave V3 — USDC Supply",
    status:    "draft",
    createdBy: "seed-sepolia",
    createdAt: now,
    updatedAt: now,
  },
  version: {
    id:                        versionId,
    mandateId,
    orgId:                     org.id,
    version:                   1,
    approvedAssets:            ["USDC"],
    approvedProtocols:         ["aave-v3"],
    approvedActions:           ["supply", "withdraw"],
    blockedActions:            ["borrow", "leverage", "swap"],
    maxSlippageBps:            50,
    maxSingleActionUsd:        50,
    maxProtocolAllocationPct:  100,   // 100% to Aave is fine for a test
    reserveFloorUsd:           0,     // test treasury, no real risk
    spendableFloorUsd:         0,
    riskBudgetPct:             0,
    emergencyRules:            {},
    status:                    "draft",
    createdBy:                 "seed-sepolia",
    createdAt:                 now,
  },
  activate: true,   // sets mandate.status=active and mandateVersions.status=active
});

console.log(`\n✅  Seeded successfully:`);
console.log(`    org.id              = ${result.mandate.orgId ?? org.id}`);
console.log(`    mandate.id          = ${mandateId}`);
console.log(`    mandate.status      = ${result.mandate.status}`);
console.log(`    mandateVersion.id   = ${result.version.id}`);
console.log(`    mandateVersion.status = ${result.version.status}`);
console.log(`\n💡  Next steps:`);
console.log(`    1. Fund the Safe with test USDC from Aave Sepolia faucet:`);
console.log(`       https://app.aave.com/faucet/?marketName=proto_base_sepolia_v3`);
console.log(`    2. Start services with Sepolia env:`);
console.log(`\n       CHAIN_ID=84532 \\`);
console.log(`       BASE_RPC_URL=https://sepolia.base.org \\`);
console.log(`       SAFE_TX_SERVICE_URL=https://api.safe.global/tx-service/basesep \\`);
console.log(`       FORK_MODE=false \\`);
console.log(`       pnpm start:services`);
console.log(`\n    3. Watch for a Safe proposal in:`);
console.log(`       https://app.safe.global/base-sep:${SAFE_ADDRESS}`);
