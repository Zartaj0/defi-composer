// ============================================================
// Agent Routes
// Manual trigger endpoints for the autonomous agent decision loop.
// Primarily used for testing and operational overrides.
// ============================================================

import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { getOrg, listMandatesForOrg } from "@defi-composer/db";
import type { ApiResponse } from "@defi-composer/shared";
import { Queue } from "bullmq";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

function redisConnection() {
  const url = new URL(REDIS_URL);
  return {
    host: url.hostname,
    port: parseInt(url.port || "6379", 10),
  };
}

// Lazy-initialised queue — avoids requiring Redis at import time
let _mandateScanQueue: Queue | null = null;
function getMandateScanQueue(): Queue {
  if (!_mandateScanQueue) {
    _mandateScanQueue = new Queue("mandate-scan", {
      connection: redisConnection(),
    });
  }
  return _mandateScanQueue;
}

export const agentRoutes: FastifyPluginAsync = async (app) => {
  // ── POST /api/v1/agent/trigger-scan/:orgId ───────────────────────────────
  // Manually enqueue a single-org mandate scan — useful for testing without
  // waiting for the 5-minute repeating schedule.
  //
  // The MandateMonitor worker picks up the job and runs scanOrgMandates().
  // Decisions are written to DB + forwarded to the mandate-simulation queue.

  app.post<{ Params: { orgId: string } }>(
    "/trigger-scan/:orgId",
    async (request, reply) => {
      const requestId = randomUUID();
      const { orgId } = request.params;

      try {
        // Validate org exists
        const org = await getOrg(orgId);
        if (!org) {
          return reply.status(404).send({
            success: false,
            error: `Organization '${orgId}' not found`,
            requestId,
            timestamp: new Date(),
          } satisfies ApiResponse<never>);
        }

        // Validate it has at least one mandate (active or draft)
        const mandates = await listMandatesForOrg(orgId);
        const activeMandates = mandates.filter((m) => m.status === "active");

        if (activeMandates.length === 0) {
          return reply.status(422).send({
            success: false,
            error:
              `Organization '${orgId}' has no active mandate. ` +
              `Create and activate a mandate before triggering a scan.`,
            requestId,
            timestamp: new Date(),
          } satisfies ApiResponse<never>);
        }

        // Enqueue a one-off scan job
        const jobId = `manual-scan-${orgId}-${randomUUID()}`;
        const queue = getMandateScanQueue();

        await queue.add(
          "scan-org-manual",
          { orgId, triggeredBy: "api", requestId },
          {
            jobId,
            attempts: 2,
            backoff: { type: "fixed", delay: 3_000 },
          }
        );

        app.log.info(
          { orgId, jobId, requestId },
          "Manual mandate scan enqueued"
        );

        return reply.status(202).send({
          success: true,
          data: {
            jobId,
            orgId,
            orgName: org.name,
            activeMandateCount: activeMandates.length,
            message:
              "Mandate scan enqueued. The agent will analyse live balances " +
              "and create AgentDecision records for any idle capital or " +
              "reserve breaches. Check the mandate-simulation queue for " +
              "simulation jobs.",
          },
          requestId,
          timestamp: new Date(),
        });
      } catch (err) {
        app.log.error({ err, orgId, requestId }, "Failed to trigger mandate scan");
        return reply.status(500).send({
          success: false,
          error:
            err instanceof Error ? err.message : "Failed to enqueue scan job",
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }
    }
  );

  // ── GET /api/v1/agent/status ─────────────────────────────────────────────
  // Returns the current job counts on the mandate-scan and
  // mandate-simulation queues — useful for health dashboards.

  app.get("/status", async (_request, reply) => {
    const requestId = randomUUID();
    try {
      const scanQueue = getMandateScanQueue();
      const [waiting, active, completed, failed] = await Promise.all([
        scanQueue.getWaitingCount(),
        scanQueue.getActiveCount(),
        scanQueue.getCompletedCount(),
        scanQueue.getFailedCount(),
      ]);

      return reply.status(200).send({
        success: true,
        data: {
          mandateScanQueue: { waiting, active, completed, failed },
          agentVersion: "1.0.0",
          description:
            "Autonomous capital mandate monitor. " +
            "Runs every 5 minutes. Proposes supply/withdraw decisions " +
            "for idle capital and reserve breaches. Never executes directly.",
        },
        requestId,
        timestamp: new Date(),
      });
    } catch (err) {
      app.log.error({ err, requestId }, "Failed to fetch agent status");
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch agent status",
        requestId,
        timestamp: new Date(),
      } satisfies ApiResponse<never>);
    }
  });
};
