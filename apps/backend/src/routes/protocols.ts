import type { FastifyPluginAsync } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { protocolRegistry } from "@defi-composer/protocol-adapters";

// ─── Protocol Routes ─────────────────────────────────────────
// Expose live protocol data to the frontend

export const protocolRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/v1/protocols
  // All protocols with metadata
  app.get("/", async (_request, reply) => {
    const protocols = protocolRegistry.getAll().map((a) => ({
      ...a.metadata,
      capabilities: a.getCapabilities(),
    }));

    return reply.send({
      success: true,
      data: protocols,
      requestId: uuidv4(),
      timestamp: new Date(),
    });
  });

  // GET /api/v1/protocols/snapshot
  // Compact APY snapshot used by the MonitorTicker and strategy templates
  app.get("/snapshot", async (_request, reply) => {
    try {
      const apys = await protocolRegistry.fetchLiveApys();
      return reply.send({
        success: true,
        data: apys,
        requestId: uuidv4(),
        timestamp: new Date(),
      });
    } catch (err) {
      app.log.warn({ err }, "Failed to fetch APY snapshot");
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch APY snapshot",
        requestId: uuidv4(),
        timestamp: new Date(),
      });
    }
  });

  // GET /api/v1/protocols/markets
  // Live market data across all protocols
  app.get("/markets", async (_request, reply) => {
    const adapters = protocolRegistry.getAll();
    const markets: Record<string, unknown> = {};

    await Promise.all(
      adapters.map(async (adapter) => {
        try {
          const adapterMarkets = await adapter.getMarkets();
          const pools = adapter.getPools ? await adapter.getPools() : [];
          markets[adapter.protocol] = { markets: adapterMarkets, pools };
        } catch (err) {
          app.log.warn({ protocol: adapter.protocol, err }, "Failed to fetch markets");
          markets[adapter.protocol] = { error: "Failed to fetch" };
        }
      })
    );

    return reply.send({
      success: true,
      data: markets,
      requestId: uuidv4(),
      timestamp: new Date(),
    });
  });
};
