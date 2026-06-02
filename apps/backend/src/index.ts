import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { intentRoutes } from "./routes/intent.js";
import { strategyRoutes } from "./routes/strategy.js";
import { positionRoutes } from "./routes/positions.js";
import { protocolRoutes } from "./routes/protocols.js";
import { treasuryRoutes } from "./routes/treasury.js";
import { alertsRoutes } from "./routes/alerts.js";
import { mandateRoutes } from "./routes/mandates.js";
import { simulationRoutes } from "./routes/simulations.js";
import { agentRoutes } from "./routes/agent.js";
import { checkDbConnection } from "@defi-composer/db";

const isDev = process.env["NODE_ENV"] !== "production";
const app = Fastify({
  logger: isDev
    ? { level: "info", transport: { target: "pino-pretty" } }
    : { level: "warn" },
});

// ─── Plugins ─────────────────────────────────────────────────
// CORS_ORIGIN accepts a comma-separated list, a wildcard "*", or a single URL.
// In production, set CORS_ORIGIN to your Vercel frontend URL.
const corsOriginEnv = process.env["CORS_ORIGIN"] ?? process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";
const corsOrigin: string | string[] | boolean =
  corsOriginEnv === "*"
    ? true
    : corsOriginEnv.includes(",")
    ? corsOriginEnv.split(",").map((s) => s.trim())
    : corsOriginEnv;

await app.register(cors, {
  origin: corsOrigin,
  credentials: true,
});

await app.register(websocket);

// ─── Health Check ────────────────────────────────────────────
app.get("/health", async () => {
  const dbOk = await checkDbConnection();
  return {
    status: dbOk ? "ok" : "degraded",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
    services: {
      db: dbOk ? "connected" : "unreachable",
    },
  };
});

// ─── Routes ──────────────────────────────────────────────────
await app.register(intentRoutes, { prefix: "/api/v1/intent" });
await app.register(strategyRoutes, { prefix: "/api/v1/strategy" });
await app.register(positionRoutes, { prefix: "/api/v1/positions" });
await app.register(protocolRoutes, { prefix: "/api/v1/protocols" });
await app.register(treasuryRoutes, { prefix: "/api/v1/treasury" });
await app.register(alertsRoutes, { prefix: "/api/v1/alerts" });
await app.register(mandateRoutes, { prefix: "/api/v1/mandates" });
await app.register(simulationRoutes, { prefix: "/api/v1/simulations" });
await app.register(agentRoutes, { prefix: "/api/v1/agent" });

// ─── Start ───────────────────────────────────────────────────
const port = Number(process.env["PORT"] ?? 3001);

try {
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`\n🚀 DeFi Composer API running on http://localhost:${port}`);
  console.log(`   Health: http://localhost:${port}/health`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
