#!/usr/bin/env node
// ============================================================
// start-services.mjs — Start all DeFi Composer services
//
// Usage:
//   node scripts/start-services.mjs              # Base mainnet
//   node scripts/start-services.mjs --sepolia    # Base Sepolia
//   node scripts/start-services.mjs --sepolia --fork  # Sepolia fork mode
//
// Starts:
//   - Backend API        (port 3001)
//   - Monitor service    (BullMQ worker)
//   - Executor service   (BullMQ worker + reconciler)
//
// Prerequisites: Postgres + Redis running locally
// ============================================================

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

const isSepolia = process.argv.includes("--sepolia");
const isFork    = process.argv.includes("--fork");

const BASE_ENV = {
  ...process.env,
  NODE_ENV: "production",
};

const SEPOLIA_ENV = {
  ...BASE_ENV,
  CHAIN_ID:            "84532",
  BASE_RPC_URL:        process.env["BASE_RPC_URL_SEPOLIA"] ?? "https://sepolia.base.org",
  SAFE_TX_SERVICE_URL: "https://api.safe.global/tx-service/basesep",
  IDLE_THRESHOLD_USD:  "10",   // lower threshold for testnet
  // Fork simulation always runs for calldata proof. FORK_MODE=false means
  // the executor also submits the validated calldata to the Safe TX Service.
  // Pass --fork flag to run in fork-only mode (no Safe TX submission).
  FORK_MODE:           isFork ? "true" : "false",
  // Use separate port range for Sepolia forks to avoid conflicts with mainnet ports
  ANVIL_BASE_PORT:     "19100",
};

const env = isSepolia ? SEPOLIA_ENV : BASE_ENV;
const chain = isSepolia ? "Base Sepolia" : "Base mainnet";

// Kill any stale Anvil processes from previous runs
try {
  const { execSync } = await import("node:child_process");
  execSync("pkill -f '^anvil\\b' 2>/dev/null || true", { stdio: "ignore" });
} catch { /* ignore */ }

console.log(`\n🚀  Starting DeFi Composer services on ${chain}${isFork ? " (fork mode)" : ""}\n`);

const services = [
  {
    name: "backend",
    cmd:  "node",
    args: ["dist/index.js"],
    cwd:  `${ROOT}/apps/backend`,
    color: "\x1b[36m",  // cyan
  },
  {
    name: "monitor",
    cmd:  "node",
    args: ["dist/index.js"],
    cwd:  `${ROOT}/services/monitor`,
    color: "\x1b[35m",  // magenta
  },
  {
    name: "executor",
    cmd:  "node",
    args: ["dist/index.js"],
    cwd:  `${ROOT}/services/executor`,
    color: "\x1b[33m",  // yellow
  },
];

const procs = [];

for (const svc of services) {
  const proc = spawn(svc.cmd, svc.args, {
    cwd: svc.cwd,
    env,
    stdio: "pipe",
  });

  const prefix = `${svc.color}[${svc.name}]\x1b[0m `;

  proc.stdout.on("data", d => process.stdout.write(prefix + d.toString().replace(/\n/g, `\n${prefix}`).trimEnd() + "\n"));
  proc.stderr.on("data", d => process.stderr.write(prefix + d.toString().replace(/\n/g, `\n${prefix}`).trimEnd() + "\n"));

  proc.on("exit", (code) => {
    console.error(`${prefix}exited with code ${code}`);
    // Kill siblings if one dies
    procs.forEach(p => { try { p.kill(); } catch {} });
    process.exit(code ?? 1);
  });

  procs.push(proc);
  console.log(`${svc.color}  ✓ ${svc.name}\x1b[0m started (pid ${proc.pid})`);
}

console.log(`\n  Backend API  : http://localhost:${process.env["PORT"] ?? 3001}`);
console.log(`  Chain        : ${chain}`);
console.log(`  Press Ctrl+C to stop all services\n`);

// Graceful shutdown
process.on("SIGINT",  () => { procs.forEach(p => { try { p.kill(); } catch {} }); process.exit(0); });
process.on("SIGTERM", () => { procs.forEach(p => { try { p.kill(); } catch {} }); process.exit(0); });
