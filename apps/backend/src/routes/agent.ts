// ============================================================
// Agent Routes
// Manual trigger + status endpoints for the autonomous agent.
// Uses the inline agent-loop (no Redis/BullMQ required).
// ============================================================

import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { getOrg, listMandatesForOrg } from "@defi-composer/db";
import type { ApiResponse } from "@defi-composer/shared";
import { getAgentStatus, forceScanOrg } from "../agent/agent-loop.js";

export const agentRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /api/v1/agent/trigger-scan/:orgId ───────────────────────────────
  // Immediately triggers a scan for one org — useful for testing.
  // The inline agent loop handles it directly (no queue needed).

  app.post<{ Params: { orgId: string } }>(
    "/trigger-scan/:orgId",
    async (request, reply) => {
      const requestId = randomUUID();
      const { orgId } = request.params;

      try {
        const org = await getOrg(orgId);
        if (!org) {
          return reply.status(404).send({
            success: false,
            error: `Organization '${orgId}' not found`,
            requestId,
            timestamp: new Date(),
          } satisfies ApiResponse<never>);
        }

        const mandates = await listMandatesForOrg(orgId);
        const activeMandates = mandates.filter(m => m.status === "active");

        if (activeMandates.length === 0) {
          return reply.status(422).send({
            success: false,
            error: `Organization '${orgId}' has no active mandate.`,
            requestId,
            timestamp: new Date(),
          } satisfies ApiResponse<never>);
        }

        // Fire the scan immediately in the background — don't await so the HTTP
        // response returns right away while the simulation runs async.
        app.log.info({ orgId, requestId }, "Triggering immediate scan for org");
        void forceScanOrg(orgId).catch(err =>
          app.log.error({ err, orgId }, "Force scan failed")
        );

        return reply.status(202).send({
          success: true,
          data: {
            orgId,
            orgName: org.name,
            activeMandateCount: activeMandates.length,
            message: "Scan started immediately. Check /mandate/:id activity in ~30s.",
            agentStatus: getAgentStatus(),
          },
          requestId,
          timestamp: new Date(),
        });
      } catch (err) {
        app.log.error({ err, orgId, requestId }, "Failed to trigger scan");
        return reply.status(500).send({
          success: false,
          error: err instanceof Error ? err.message : "Failed",
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }
    }
  );

  // ── GET /api/v1/agent/status ─────────────────────────────────────────────

  app.get("/status", async (_request, reply) => {
    const requestId = randomUUID();
    return reply.status(200).send({
      success: true,
      data: {
        ...getAgentStatus(),
        agentVersion: "2.0.0",
        description:
          "Autonomous mandate agent. No Redis. Scans every 5 min, " +
          "reconciles every 60s. Fork-proves every action before execution.",
      },
      requestId,
      timestamp: new Date(),
    });
  });
};
