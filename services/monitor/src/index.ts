// ============================================================
// Monitoring Agent
// Runs continuously. For every org:
//   - Fetches active positions from DB
//   - Checks health factors (critical < 1.2, warning < 1.5)
//   - Detects APY collapse (>50% drop from deployed rate)
//   - Detects idle capital (on-chain USDC balance not deployed)
//   - Triggers rebalance jobs via BullMQ
//   - Notifies via Telegram / Discord / webhook
// ============================================================

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createPublicClient, type Address } from "viem";
import { createFallbackTransport } from "@defi-composer/simulation-engine";
import { base } from "viem/chains";
import { Redis } from "ioredis";
import type { Alert, AlertSeverity } from "@defi-composer/shared";
import { protocolRegistry } from "@defi-composer/protocol-adapters";
import {
  listOrgs,
  listActivePositions,
  updateHealthFactor,
  createAlert,
} from "@defi-composer/db";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const REDIS_ALERT_CHANNEL = "defi-composer:alerts";
const redisPub = new Redis(REDIS_URL);

// Use the exact type returned by listOrgs (Drizzle-typed, includes `wallets` relation)
type DbOrg = Awaited<ReturnType<typeof listOrgs>>[number];

// ─── Config ───────────────────────────────────────────────────────────────────
export interface MonitoringConfig {
  healthFactorWarningThreshold: number;
  healthFactorCriticalThreshold: number;
  apyCollapseThresholdPct: number;
  idleCapitalThresholdUsd: number;
  checkIntervalMs: number;
}

const DEFAULT_CONFIG: MonitoringConfig = {
  healthFactorWarningThreshold: 1.5,
  healthFactorCriticalThreshold: 1.2,
  apyCollapseThresholdPct: 50,
  idleCapitalThresholdUsd: 10_000,
  checkIntervalMs: 60_000,
};

// ERC-20 balanceOf ABI
const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function" as const,
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view" as const,
  },
] as const;

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as Address;
// ETH price in USD — would ideally come from Chainlink in prod
const ETH_PRICE_USD = 3_000;

const publicClient = createPublicClient({
  chain: base,
  transport: createFallbackTransport(),
});

// ─── Monitoring Agent ─────────────────────────────────────────────────────────
export class MonitoringAgent {
  private config: MonitoringConfig;
  private alertHandlers: Array<(alert: Alert) => Promise<void>> = [];
  private rebalanceHandlers: Array<
    (positionId: string, reason: string, emergency: boolean) => Promise<void>
  > = [];
  private isRunning = false;
  private intervalHandle?: ReturnType<typeof setInterval>;

  constructor(config: Partial<MonitoringConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  onAlert(handler: (alert: Alert) => Promise<void>): void {
    this.alertHandlers.push(handler);
  }

  onRebalanceTrigger(
    handler: (positionId: string, reason: string, emergency: boolean) => Promise<void>
  ): void {
    this.rebalanceHandlers.push(handler);
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    console.log(
      `[Monitor] Started. Checking every ${this.config.checkIntervalMs / 1000}s`
    );

    this.intervalHandle = setInterval(async () => {
      try {
        // Fetch all orgs from DB on each cycle (picks up new orgs automatically)
        const orgs = await listOrgs();
        await Promise.allSettled(orgs.map((org) => this.checkOrg(org)));
      } catch (err) {
        console.error("[Monitor] Check cycle failed:", err);
      }
    }, this.config.checkIntervalMs);

    // Run immediately on start
    this.runCycle().catch((err) =>
      console.error("[Monitor] Initial cycle failed:", err)
    );
  }

  stop(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.isRunning = false;
    console.log("[Monitor] Stopped.");
  }

  private async runCycle(): Promise<void> {
    const orgs = await listOrgs();
    await Promise.allSettled(orgs.map((org) => this.checkOrg(org)));
  }

  // ─── Per-org check ──────────────────────────────────────────────────────────
  private async checkOrg(org: DbOrg): Promise<void> {
    // Real DB query — replaces the old `positions: Position[] = []` stub
    const dbPositions = await listActivePositions(org.id);

    await Promise.allSettled([
      this.checkHealthFactors(org, dbPositions),
      this.checkApyDrift(org, dbPositions),
      this.checkIdleCapital(org),
    ]);
  }

  // ─── Health Factor Check ────────────────────────────────────────────────────
  private async checkHealthFactors(
    org: DbOrg,
    dbPositions: Awaited<ReturnType<typeof listActivePositions>>
  ): Promise<void> {
    const leveraged = dbPositions.filter(
      (p) => p.healthFactor !== null && p.healthFactor !== undefined
    );

    for (const pos of leveraged) {
      // Refresh health factor from chain for Aave positions
      const primaryNode = pos.graph.nodes.find(
        (n) => n.protocol === "aave-v3"
      );
      if (primaryNode && pos.safeAddress) {
        try {
          const adapter = protocolRegistry.get("aave-v3");
          const liveHf = await adapter.getHealthFactor?.(
            pos.safeAddress as Address
          );
          if (liveHf !== null && liveHf !== undefined) {
            await updateHealthFactor(pos.id, liveHf);
            pos.healthFactor = liveHf;
          }
        } catch {
          // Use stored value if on-chain fetch fails
        }
      }

      const hf = pos.healthFactor!;

      if (hf < this.config.healthFactorCriticalThreshold) {
        await this.fireAlert(org.id, {
          positionId: pos.id,
          type: "health_factor_critical",
          severity: "critical",
          title: "CRITICAL: Position Near Liquidation",
          message:
            `Position ${pos.id} health factor is ${hf.toFixed(3)} — ` +
            `below critical threshold ${this.config.healthFactorCriticalThreshold}. ` +
            `IMMEDIATE ACTION REQUIRED.`,
          actionRequired: true,
          data: {
            healthFactor: hf,
            positionId: pos.id,
            threshold: this.config.healthFactorCriticalThreshold,
          },
        });

        await this.triggerRebalance(
          pos.id,
          `Health factor critical: ${hf.toFixed(3)}`,
          true // emergency
        );
      } else if (hf < this.config.healthFactorWarningThreshold) {
        await this.fireAlert(org.id, {
          positionId: pos.id,
          type: "health_factor_warning",
          severity: "warning",
          title: "Health Factor Warning",
          message:
            `Position ${pos.id} health factor is ${hf.toFixed(3)}. ` +
            `Approaching liquidation threshold.`,
          actionRequired: false,
          data: { healthFactor: hf, positionId: pos.id },
        });
      }
    }
  }

  // ─── APY Drift Detection ────────────────────────────────────────────────────
  private async checkApyDrift(
    org: DbOrg,
    dbPositions: Awaited<ReturnType<typeof listActivePositions>>
  ): Promise<void> {
    for (const pos of dbPositions) {
      const deployedApyBps = pos.graph.estimatedApyBps;
      const primaryNode = pos.graph.nodes[0];
      if (!primaryNode) continue;

      try {
        const adapter = protocolRegistry.get(primaryNode.protocol);
        const market = await adapter.getMarket(primaryNode.inputAsset);
        if (!market) continue;

        const currentApyBps = market.supplyApyBps;
        const dropPct =
          ((deployedApyBps - currentApyBps) / deployedApyBps) * 100;

        if (dropPct >= this.config.apyCollapseThresholdPct) {
          await this.fireAlert(org.id, {
            positionId: pos.id,
            type: "apy_collapse",
            severity: "warning",
            title: "APY Collapsed",
            message:
              `Strategy "${pos.graph.name}" APY dropped from ` +
              `${(deployedApyBps / 100).toFixed(2)}% to ` +
              `${(currentApyBps / 100).toFixed(2)}% ` +
              `(${dropPct.toFixed(0)}% decline). Consider migrating.`,
            actionRequired: false,
            data: { deployedApyBps, currentApyBps, dropPct },
          });

          await this.triggerRebalance(
            pos.id,
            `APY collapsed ${dropPct.toFixed(0)}% from deployed rate`,
            false
          );
        }
      } catch {
        // Protocol adapter failure — not a rebalance signal
      }
    }
  }

  // ─── Idle Capital Detection ──────────────────────────────────────────────────
  // Reads the org's treasury wallet balances on-chain and compares to
  // managed AUM. Flags uninvested capital above threshold.
  private async checkIdleCapital(org: DbOrg): Promise<void> {
    if (!org.wallets || org.wallets.length === 0) return;

    let totalIdleUsd = 0;

    for (const wallet of org.wallets) {
      if (wallet.chainId !== 8453) continue; // Base only

      const address = wallet.address as Address;

      try {
        const [usdcBalance, wethBalance] = await Promise.all([
          publicClient.readContract({
            address: USDC_ADDRESS,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [address],
          }),
          publicClient.readContract({
            address: WETH_ADDRESS,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [address],
          }),
        ]);

        const usdcUsd = Number(usdcBalance) / 1e6;
        const wethUsd = (Number(wethBalance) / 1e18) * ETH_PRICE_USD;

        totalIdleUsd += usdcUsd + wethUsd;
      } catch {
        // Skip if on-chain read fails
      }
    }

    if (totalIdleUsd > this.config.idleCapitalThresholdUsd) {
      await this.fireAlert(org.id, {
        type: "idle_capital_detected",
        severity: "info",
        title: "Idle Capital Detected",
        message:
          `$${totalIdleUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })} ` +
          `is sitting uninvested in treasury wallets. Deploy it to earn yield.`,
        actionRequired: false,
        data: { idleCapitalUsd: totalIdleUsd },
      });
    }
  }

  // ─── Alert Dispatcher ─────────────────────────────────────────────────────
  private async fireAlert(
    orgId: string,
    alertData: Omit<Alert, "id" | "orgId" | "createdAt">
  ): Promise<void> {
    const alertId = `alert_${randomUUID()}`;

    const alert: Alert = {
      ...alertData,
      id: alertId,
      orgId,
      createdAt: new Date(),
    };

    console.log(`[Monitor] [${alert.severity}] ${alert.title} (org: ${orgId})`);

    // Persist alert to DB
    await createAlert({
      id: alertId,
      orgId,
      positionId: alertData.positionId ?? null,
      type: alertData.type,
      severity: alertData.severity,
      title: alertData.title,
      message: alertData.message,
      actionRequired: alertData.actionRequired,
      data: alertData.data ?? {},
      acknowledged: false,
    }).catch((err) =>
      console.error("[Monitor] Failed to persist alert:", err)
    );

    // Publish to Redis for WebSocket broadcast (non-blocking)
    redisPub.publish(REDIS_ALERT_CHANNEL, JSON.stringify({ orgId, alert })).catch(
      (err: unknown) => console.error("[Monitor] Redis publish failed:", err)
    );

    // Dispatch to all registered notification handlers
    await Promise.allSettled(
      this.alertHandlers.map((handler) => handler(alert))
    );
  }

  // ─── Rebalance Trigger ───────────────────────────────────────────────────
  private async triggerRebalance(
    positionId: string,
    reason: string,
    emergency: boolean
  ): Promise<void> {
    console.log(
      `[Monitor] Rebalance trigger: pos=${positionId} emergency=${emergency} reason="${reason}"`
    );
    await Promise.allSettled(
      this.rebalanceHandlers.map((h) => h(positionId, reason, emergency))
    );
  }

  // ─── One-off check (used by API endpoints) ───────────────────────────────
  async checkPositionById(
    orgId: string,
    positionId: string
  ): Promise<{ alerts: Alert[]; needsRebalance: boolean }> {
    const positions = await listActivePositions(orgId);
    const pos = positions.find((p) => p.id === positionId);

    if (!pos) return { alerts: [], needsRebalance: false };

    const alerts: Alert[] = [];
    let needsRebalance = false;

    if (
      pos.healthFactor !== null &&
      pos.healthFactor !== undefined &&
      pos.healthFactor < this.config.healthFactorWarningThreshold
    ) {
      const severity: AlertSeverity =
        pos.healthFactor < this.config.healthFactorCriticalThreshold
          ? "critical"
          : "warning";

      alerts.push({
        id: `check_${Date.now()}`,
        orgId,
        positionId,
        type:
          severity === "critical"
            ? "health_factor_critical"
            : "health_factor_warning",
        severity,
        title: "Health Factor Below Threshold",
        message: `Current HF: ${pos.healthFactor.toFixed(3)}`,
        actionRequired: severity === "critical",
        data: { healthFactor: pos.healthFactor },
        createdAt: new Date(),
      });

      if (severity === "critical") needsRebalance = true;
    }

    return { alerts, needsRebalance };
  }
}

// ─── Notification Dispatchers ─────────────────────────────────────────────────
export function createTelegramNotifier(botToken: string, chatId: string) {
  return async (alert: Alert): Promise<void> => {
    const emoji =
      alert.severity === "critical"
        ? "🚨"
        : alert.severity === "warning"
        ? "⚠️"
        : "ℹ️";

    const text = `${emoji} *${alert.title}*\n${alert.message}`;

    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      }
    );

    if (!res.ok) {
      console.error(`[Monitor] Telegram notify failed: ${res.status}`);
    }
  };
}

export function createDiscordNotifier(webhookUrl: string) {
  return async (alert: Alert): Promise<void> => {
    const color =
      alert.severity === "critical"
        ? 0xff0000
        : alert.severity === "warning"
        ? 0xffa500
        : 0x0099ff;

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: alert.title,
            description: alert.message,
            color,
            timestamp: alert.createdAt.toISOString(),
            footer: { text: "DeFi Composer Monitor" },
          },
        ],
      }),
    });

    if (!res.ok) {
      console.error(`[Monitor] Discord notify failed: ${res.status}`);
    }
  };
}

// ─── Singleton + main ─────────────────────────────────────────────────────────
export const monitoringAgent = new MonitoringAgent();

if (process.env["NODE_ENV"] !== "test") {
  // Wire rebalance handler — push to executor's BullMQ queue directly
  const { Queue: BullQueue } = await import("bullmq");
  const rebalanceQueue = new BullQueue("strategy-rebalance", {
    connection: {
      host: new URL(REDIS_URL).hostname,
      port: parseInt(new URL(REDIS_URL).port || "6379"),
    },
  });

  monitoringAgent.onRebalanceTrigger(async (positionId, reason, emergency) => {
    await rebalanceQueue.add("rebalance", {
      positionId,
      reason,
      emergencyUnwind: emergency,
      triggeredBy: "monitor",
      orgId: "",
    });
  });

  // Wire Telegram if configured
  const tgToken = process.env["TELEGRAM_BOT_TOKEN"];
  const tgChat = process.env["TELEGRAM_CHAT_ID"];
  if (tgToken && tgChat) {
    monitoringAgent.onAlert(createTelegramNotifier(tgToken, tgChat));
    console.log("[Monitor] Telegram notifications enabled");
  }

  // Wire Discord if configured
  const discordWebhook = process.env["DISCORD_WEBHOOK_URL"];
  if (discordWebhook) {
    monitoringAgent.onAlert(createDiscordNotifier(discordWebhook));
    console.log("[Monitor] Discord notifications enabled");
  }

  // Legacy MonitoringAgent uses Base-mainnet-specific contract addresses and
  // the `base` viem chain. Skip it when running on any non-mainnet chain to
  // avoid error spam from Aave V3 data provider calls that don't exist on Sepolia.
  const activeChainId = parseInt(process.env["CHAIN_ID"] ?? "8453");
  if (activeChainId === 8453) {
    console.log("[Monitor Service] Starting...");
    monitoringAgent.start();
  } else {
    console.log(`[Monitor Service] Legacy MonitoringAgent skipped on chain ${activeChainId} (mainnet-only contracts).`);
  }

  // Mandate monitor — autonomous agent decision loop (runs every 5 minutes)
  import("./mandate-monitor.js").then(({ startMandateMonitor }) => {
    startMandateMonitor();
    console.log("[Monitor Service] Mandate monitor started (5-min scan interval).");
  }).catch((err: Error) => {
    console.error("[Monitor Service] Failed to start mandate monitor:", err.message);
  });
}
