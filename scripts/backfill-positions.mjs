#!/usr/bin/env node
// ============================================================
// backfill-positions.mjs
// Creates DB position records for already-executed Safe TXs
// that predate the executor service (e.g. Phase 1 manual tx).
//
// Usage:
//   node scripts/backfill-positions.mjs
// ============================================================

import "dotenv/config";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { randomUUID } from "node:crypto";

const SAFE     = "0xead39d939A83A8e57a61b9ebf4209142Df8ED690";
const ORG_ID   = "org_88e49a1b-976";
const EXEC_TX  = "0x66826fea5ae1b741c5452214664629604b71cfd1e34cc5bcf6d6b6e81769f80c"; // Phase 1 Aave supply tx
// aUSDC and USDC on Base Sepolia
const AUSDC    = "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC";
const USDC     = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";

let db;
try {
  db = await import("../packages/db/dist/index.js");
} catch {
  console.error("Run pnpm build first.");
  process.exit(1);
}

const { createPosition, getActiveMandateForOrg, listActivePositions } = db;

// Check if already backfilled
const existing = await listActivePositions(ORG_ID);
if (existing.length > 0) {
  console.log(`\nPositions already exist for ${ORG_ID}:`);
  existing.forEach(p => console.log(`  - ${p.id} ${p.protocol}/${p.asset} $${p.currentValueUsd}`));
  process.exit(0);
}

// Read live balances
const client = createPublicClient({
  chain: baseSepolia,
  transport: http("https://sepolia.base.org"),
});

const ERC20_ABI = [{
  name: "balanceOf", type: "function",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ type: "uint256" }],
  stateMutability: "view",
}];

const [aUsdcRaw, usdcRaw] = await Promise.all([
  client.readContract({ address: AUSDC, abi: ERC20_ABI, functionName: "balanceOf", args: [SAFE] }),
  client.readContract({ address: USDC,  abi: ERC20_ABI, functionName: "balanceOf", args: [SAFE] }),
]);

const aUsdcUsd = Number(aUsdcRaw) / 1e6;
const usdcUsd  = Number(usdcRaw)  / 1e6;

console.log(`\nLive Safe balances:`);
console.log(`  USDC  : $${usdcUsd.toFixed(6)}`);
console.log(`  aUSDC : $${aUsdcUsd.toFixed(6)}`);

if (aUsdcUsd === 0) {
  console.log("\nNo aUSDC balance found — nothing to backfill.");
  process.exit(0);
}

const mandate = await getActiveMandateForOrg(ORG_ID);
if (!mandate) { console.error("No active mandate found for org."); process.exit(1); }

const positionId = `pos_${randomUUID().slice(0, 12)}`;

await createPosition({
  id:          positionId,
  orgId:       ORG_ID,
  status:      "active",
  chainId:     84532,
  entryValueUsd:   aUsdcUsd,
  currentValueUsd: aUsdcUsd,
  deployTxHash:    EXEC_TX,
  safeAddress:     SAFE,
  mandateVersionId: mandate.versions?.[0]?.id ?? "e2e-test",
  simulationArtifactId: "phase1-backfill",
  graph: {
    id:          `graph_${positionId}`,
    name:        "Aave V3 USDC Supply",
    description: "USDC supplied to Aave V3 on Base Sepolia",
    entryAsset:  "USDC",
    exitAsset:   "USDC",
    nodes: [{
      id:              "n1",
      protocol:        "aave-v3",
      action:          "supply",
      inputAsset:      "USDC",
      outputAsset:     "USDC",
      expectedApyBps:  450,
      gasCostUsd:      0,
      risks:           [],
      metadata:        {},
    }],
    edges:           [],
    estimatedApyBps: 450,
    totalGasCostUsd: 0,
    createdAt:       new Date(),
  },
});

console.log(`\n✅  Backfilled position ${positionId}`);
console.log(`    aUSDC deployed: $${aUsdcUsd.toFixed(6)}`);
console.log(`    deploy tx:      ${EXEC_TX}`);
console.log(`\n    Dashboard: http://localhost:3001/api/v1/treasury/orgs/${ORG_ID}`);
