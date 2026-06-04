// ============================================================
// Alerts WebSocket Route
// GET  /api/v1/alerts/ws   — WebSocket stream of real-time alerts
// GET  /api/v1/alerts/:orgId — Recent alerts for org
// ============================================================

import type { FastifyPluginAsync } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { v4 as uuidv4 } from "uuid";
import { listOrgAlerts } from "@defi-composer/db";
import type { Alert } from "@defi-composer/shared";

export const REDIS_ALERT_CHANNEL = "defi-composer:alerts";

// ── In-memory subscriber registry ─────────────────────────────
// Maps orgId → Set of active WebSocket connections
const subscribers = new Map<string, Set<WebSocket>>();

// ── Optional Redis pub/sub (only if REDIS_URL is configured) ──
// The backend is Redis-free by default. Redis is only used here
// for cross-process alert broadcasting (e.g. from external services).
// Without Redis, alerts still work in-process via broadcastAlert().
const REDIS_URL = process.env["REDIS_URL"];

if (REDIS_URL) {
  // Lazy import so ioredis is not imported when Redis is absent
  import("ioredis").then(({ Redis }) => {
    const redisSub = new Redis(REDIS_URL);
    redisSub.subscribe(REDIS_ALERT_CHANNEL).then(() => {
      console.log(`[Alerts] Redis pub/sub active on channel: ${REDIS_ALERT_CHANNEL}`);
    }).catch((err: unknown) => {
      console.error("[Alerts] Redis subscribe error:", err);
    });

    redisSub.on("message", (_channel: string, message: string) => {
      try {
        const payload = JSON.parse(message) as { orgId: string; alert: Alert };
        const orgSubs    = subscribers.get(payload.orgId) ?? new Set<WebSocket>();
        const globalSubs = subscribers.get("*")           ?? new Set<WebSocket>();
        const wsPayload  = JSON.stringify({ type: "alert", ...payload });
        for (const ws of [...orgSubs, ...globalSubs]) {
          if (ws.readyState === 1) ws.send(wsPayload);
        }
      } catch (err) {
        console.error("[Alerts] Failed to parse Redis message:", err);
      }
    });

    redisSub.on("error", (err: Error) => {
      // Log but don't crash — in-process broadcasts still work
      console.warn("[Alerts] Redis connection error (alerts degraded):", err.message);
    });
  }).catch((err: unknown) => {
    console.warn("[Alerts] ioredis not available:", err);
  });
} else {
  console.log("[Alerts] REDIS_URL not set — Redis pub/sub disabled. In-process alerts only.");
}

// Broadcast an alert to all subscribers for an org
export function broadcastAlert(orgId: string, alert: Alert): void {
  const subs = subscribers.get(orgId) ?? subscribers.get("*") ?? new Set();
  const payload = JSON.stringify({ type: "alert", alert });
  for (const ws of subs) {
    try {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(payload);
      }
    } catch {
      // Connection dropped — remove on next cleanup
    }
  }
  // Also broadcast to "*" (global listeners)
  if (orgId !== "*") {
    const global = subscribers.get("*");
    if (global) {
      for (const ws of global) {
        try {
          if (ws.readyState === 1) ws.send(payload);
        } catch { /* ignore */ }
      }
    }
  }
}

// Broadcast a monitor event (health factor update, APY change, etc.)
export function broadcastMonitorEvent(orgId: string, event: {
  type: "health_factor" | "apy_change" | "position_update" | "rebalance_needed";
  data: Record<string, unknown>;
}): void {
  const subs = subscribers.get(orgId) ?? new Set<WebSocket>();
  const payload = JSON.stringify({ orgId, ...event });
  for (const ws of subs) {
    try {
      if (ws.readyState === 1) ws.send(payload);
    } catch { /* ignore */ }
  }
}

export const alertsRoutes: FastifyPluginAsync = async (app) => {

  // ── WebSocket: GET /ws?orgId=xxx ──────────────────────────────
  app.get<{ Querystring: { orgId?: string } }>(
    "/ws",
    { websocket: true },
    (socket, request) => {
      const orgId = request.query.orgId ?? "*";

      // Register this connection
      if (!subscribers.has(orgId)) {
        subscribers.set(orgId, new Set());
      }
      subscribers.get(orgId)!.add(socket);

      app.log.info({ orgId }, `WebSocket client connected (${subscribers.get(orgId)!.size} subs for ${orgId})`);

      // Send a welcome ping
      socket.send(JSON.stringify({
        type: "connected",
        orgId,
        message: "Real-time alert stream active",
        timestamp: new Date().toISOString(),
      }));

      // Heartbeat every 30s to keep connection alive
      const heartbeat = setInterval(() => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: "ping", timestamp: new Date().toISOString() }));
        }
      }, 30_000);

      socket.on("message", (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "pong") return; // client is alive
          if (msg.type === "subscribe" && msg.orgId) {
            // Allow re-subscribing to a different org
            subscribers.get(orgId)?.delete(socket);
            const newOrgId = msg.orgId as string;
            if (!subscribers.has(newOrgId)) subscribers.set(newOrgId, new Set());
            subscribers.get(newOrgId)!.add(socket);
          }
        } catch {
          // Not JSON — ignore
        }
      });

      socket.on("close", () => {
        clearInterval(heartbeat);
        subscribers.get(orgId)?.delete(socket);
        app.log.info({ orgId }, "WebSocket client disconnected");
      });

      socket.on("error", (err: Error) => {
        clearInterval(heartbeat);
        subscribers.get(orgId)?.delete(socket);
        app.log.warn({ err, orgId }, "WebSocket error");
      });
    }
  );

  // ── GET /:orgId — recent alerts from DB ──────────────────────
  app.get<{ Params: { orgId: string }; Querystring: { limit?: string } }>(
    "/:orgId",
    async (request, reply) => {
      const requestId = uuidv4();
      try {
        const limit = Math.min(parseInt(request.query.limit ?? "50"), 200);
        const alerts = await listOrgAlerts(request.params.orgId, { limit });
        return reply.status(200).send({
          success: true,
          data: alerts,
          requestId,
          timestamp: new Date(),
        });
      } catch (err) {
        app.log.error(err);
        return reply.status(500).send({
          success: false,
          error: "Failed to fetch alerts",
          requestId,
          timestamp: new Date(),
        });
      }
    }
  );
};
