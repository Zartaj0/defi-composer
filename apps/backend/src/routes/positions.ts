// ============================================================
// Position Routes
// ============================================================

import type { FastifyPluginAsync } from "fastify";
import { v4 as uuidv4 } from "uuid";
import {
  listOrgPositions,
  getPosition,
  updatePositionStatus,
  closePosition,
  listPositionsForMandate,
} from "@defi-composer/db";

export const positionRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/v1/positions/org/:orgId
  app.get<{ Params: { orgId: string } }>(
    "/org/:orgId",
    async (request, reply) => {
      try {
        const positions = await listOrgPositions(request.params.orgId);
        return reply.send({
          success: true,
          data: positions,
          requestId: uuidv4(),
          timestamp: new Date(),
        });
      } catch (err) {
        app.log.error(err);
        return reply.status(500).send({
          success: false,
          error: "Failed to fetch positions",
          requestId: uuidv4(),
          timestamp: new Date(),
        });
      }
    }
  );

  // GET /api/v1/positions/:positionId
  app.get<{ Params: { positionId: string } }>(
    "/:positionId",
    async (request, reply) => {
      try {
        const position = await getPosition(request.params.positionId);
        if (!position) {
          return reply.status(404).send({
            success: false,
            error: "Position not found",
            requestId: uuidv4(),
            timestamp: new Date(),
          });
        }
        return reply.send({
          success: true,
          data: position,
          requestId: uuidv4(),
          timestamp: new Date(),
        });
      } catch (err) {
        app.log.error(err);
        return reply.status(500).send({
          success: false,
          error: "Failed to fetch position",
          requestId: uuidv4(),
          timestamp: new Date(),
        });
      }
    }
  );

  // GET /api/v1/positions/:positionId/health
  // Live health factor check via protocol adapters
  app.get<{ Params: { positionId: string } }>(
    "/:positionId/health",
    async (request, reply) => {
      try {
        const position = await getPosition(request.params.positionId);
        if (!position) {
          return reply.status(404).send({
            success: false,
            error: "Position not found",
            requestId: uuidv4(),
            timestamp: new Date(),
          });
        }

        // Attempt live health factor refresh from Aave for leveraged positions
        let liveHealthFactor = position.healthFactor;
        const hasAave = position.graph.nodes.some((n) => n.protocol === "aave-v3");
        if (hasAave && position.safeAddress) {
          try {
            const { protocolRegistry } = await import("@defi-composer/protocol-adapters");
            const adapter = protocolRegistry.get("aave-v3");
            const hf = await adapter.getHealthFactor?.(position.safeAddress as `0x${string}`) ?? null;
            if (hf !== null) {
              liveHealthFactor = hf;
              const { updateHealthFactor } = await import("@defi-composer/db");
              await updateHealthFactor(position.id, hf);
            }
          } catch {
            // Fall back to stored value
          }
        }

        return reply.send({
          success: true,
          data: {
            positionId: position.id,
            healthFactor: liveHealthFactor,
            status: position.status,
            currentValueUsd: position.currentValueUsd,
            lastUpdated: position.updatedAt,
          },
          requestId: uuidv4(),
          timestamp: new Date(),
        });
      } catch (err) {
        app.log.error(err);
        return reply.status(500).send({
          success: false,
          error: "Failed to check health",
          requestId: uuidv4(),
          timestamp: new Date(),
        });
      }
    }
  );

  // POST /api/v1/positions/:positionId/close
  app.post<{
    Params: { positionId: string };
    Body: { reason?: string; initiatedBy: string };
  }>(
    "/:positionId/close",
    async (request, reply) => {
      try {
        const { reason = "user_initiated", initiatedBy } = request.body;
        await closePosition(
          request.params.positionId,
          `${reason} — by ${initiatedBy}`
        );
        return reply.send({
          success: true,
          data: { message: "Position closing initiated" },
          requestId: uuidv4(),
          timestamp: new Date(),
        });
      } catch (err) {
        app.log.error(err);
        return reply.status(500).send({
          success: false,
          error: "Failed to close position",
          requestId: uuidv4(),
          timestamp: new Date(),
        });
      }
    }
  );

  // GET /api/v1/positions/mandate/:mandateId
  app.get<{ Params: { mandateId: string } }>(
    "/mandate/:mandateId",
    async (request, reply) => {
      try {
        const positions = await listPositionsForMandate(request.params.mandateId);
        return reply.send({ success: true, data: positions, timestamp: new Date() });
      } catch (err) {
        app.log.error(err);
        return reply.status(500).send({
          success: false,
          error: "Failed to fetch mandate positions",
          requestId: uuidv4(),
          timestamp: new Date(),
        });
      }
    }
  );
};
