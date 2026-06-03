// ============================================================
// Intent Routes
// POST /api/v1/intent/parse   — parse + persist + queue planning job
// GET  /api/v1/intent/:id     — poll intent status + candidates
// GET  /api/v1/intent/:id/candidates — fetch generated candidates
// ============================================================

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { LLMClient, StrategyPlanner } from "@defi-composer/strategy-engine";
import { RiskEngine } from "@defi-composer/risk-engine";
import {
  createIntent,
  getIntent,
  getCandidatesForIntent,
  getOrg,
  createOrg,
  addTreasuryWallet,
  updateIntentStatus,
  storeCandidates,
} from "@defi-composer/db";
import type { UserIntent, ApiResponse, CandidateStrategy } from "@defi-composer/shared";

// Singleton planner + risk engine (warm up once, reuse across requests)
const planner = new StrategyPlanner();
const riskEngine = new RiskEngine();

// ─── Input validation ─────────────────────────────────────────────────────────
const ParseIntentBody = z.object({
  rawInput: z.string().min(5).max(500),
  capitalUsd: z.number().positive(),
  walletAddress: z.string().startsWith("0x"),
  orgId: z.string().optional(),
});

// ─── Intent status response ───────────────────────────────────────────────────
export interface IntentStatusResponse {
  intentId: string;
  status: string;
  candidateCount: number;
  jobId: string | null;
}

export const intentRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /parse — parse intent, persist to DB, queue AI generation ─────────
  app.post<{ Body: z.infer<typeof ParseIntentBody> }>(
    "/parse",
    {
      schema: {
        body: {
          type: "object",
          required: ["rawInput", "capitalUsd", "walletAddress"],
          properties: {
            rawInput: { type: "string" },
            capitalUsd: { type: "number" },
            walletAddress: { type: "string" },
            orgId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { rawInput, capitalUsd, walletAddress, orgId: providedOrgId } =
        request.body;
      const requestId = uuidv4();

      try {
        // ── Step 1: Parse intent with the configured LLM chain ──────────────
        const intent = await parseIntentWithLLM(rawInput, capitalUsd);

        // ── Step 2: Resolve org — create ephemeral org for wallet if none ───
        let orgId = providedOrgId;
        if (!orgId) {
          // Derive a deterministic org ID from wallet address
          orgId = `org_${walletAddress.slice(2, 10).toLowerCase()}`;

          const existing = await getOrg(orgId);
          if (!existing) {
            await createOrg({
              id: orgId,
              name: `Wallet ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`,
              type: "individual",
              riskParams: {
                maxAllocationPerProtocolPct: 100,
                maxDrawdownPct: 50,
                allowLeverage: true,
                allowLiquidationRisk: true,
                allowGovernanceTokenRewards: true,
                minLiquidityReservePct: 0,
                approvedProtocols: [],   // empty = all protocols allowed
                approvedChains: [8453],
                maxSinglePositionPct: 100,
                requireMultisigForNewStrategy: false,
              },
              feeConfig: {
                managementFeeBps: 10,
                performanceFeePct: 10,
                benchmarkRateBps: 530,  // ~5.3% T-bill rate
                curatorFeePct: 0,
                feeRecipient: "0x1111111111111111111111111111111111111111",
                billingCycle: "monthly",
              },
              notificationChannels: [],
            });

            await addTreasuryWallet({
              id: `wallet_${uuidv4().slice(0, 8)}`,
              orgId,
              address: walletAddress,
              chainId: 8453,
              role: "treasury",
              label: "Primary Wallet",
              isManaged: false,
            });
          }
        } else {
          // Verify org exists
          const org = await getOrg(orgId);
          if (!org) {
            return reply.status(404).send({
              success: false,
              error: `Organization ${orgId} not found`,
              requestId,
              timestamp: new Date(),
            });
          }
        }

        // ── Step 3: Persist intent to DB ─────────────────────────────────────
        const intentId = `intent_${uuidv4().slice(0, 12)}`;
        await createIntent({
          id: intentId,
          orgId,
          rawText: rawInput,
          parsed: intent,
          status: "received",
          submittedBy: walletAddress,
        });

        // ── Step 4: Generate strategies inline (no Redis/BullMQ required) ──────
        // Fire-and-forget — frontend polls GET /intent/:id for status updates
        void runPlannerInline(intentId, intent, orgId).catch(async (err) => {
          app.log.error({ err, intentId }, "Inline planner failed");
          // Mark failed so the frontend polling exits cleanly instead of timing out
          try { await updateIntentStatus(intentId, "failed"); } catch { /* ignore */ }
        });

        app.log.info({ intentId, orgId }, "Intent received, planner started");

        const response: ApiResponse<{
          intentId: string;
          jobId: string | undefined;
          orgId: string;
          intent: UserIntent;
          statusUrl: string;
        }> = {
          success: true,
          data: {
            intentId,
            jobId: undefined,
            orgId,
            intent,
            statusUrl: `/api/v1/intent/${intentId}`,
          },
          requestId,
          timestamp: new Date(),
        };

        return reply.status(202).send(response); // 202 Accepted — async processing
      } catch (err) {
        app.log.error({ err, requestId }, "Intent parse/queue failed");
        return reply.status(500).send({
          success: false,
          error: err instanceof Error ? err.message : "Failed to process intent",
          requestId,
          timestamp: new Date(),
        });
      }
    }
  );

  // ── GET /:id — poll intent status ──────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const { id } = request.params;
    const requestId = uuidv4();

    try {
      const intent = await getIntent(id);
      if (!intent) {
        return reply.status(404).send({
          success: false,
          error: "Intent not found",
          requestId,
          timestamp: new Date(),
        });
      }

      const response: ApiResponse<IntentStatusResponse> = {
        success: true,
        data: {
          intentId: intent.id,
          status: intent.status,
          candidateCount: intent.candidateCount ?? 0,
          jobId: intent.jobId,
        },
        requestId,
        timestamp: new Date(),
      };

      return reply.status(200).send(response);
    } catch (err) {
      app.log.error(err);
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch intent status",
        requestId,
        timestamp: new Date(),
      });
    }
  });

  // ── GET /:id/candidates — fetch generated candidates ───────────────────────
  app.get<{ Params: { id: string } }>(
    "/:id/candidates",
    async (request, reply) => {
      const { id } = request.params;
      const requestId = uuidv4();

      try {
        const intent = await getIntent(id);
        if (!intent) {
          return reply.status(404).send({
            success: false,
            error: "Intent not found",
            requestId,
            timestamp: new Date(),
          });
        }

        if (intent.status !== "ready" && intent.status !== "selected") {
          return reply.status(202).send({
            success: true,
            data: {
              status: intent.status,
              message: "Strategies are still being generated",
              candidateCount: 0,
              candidates: [],
            },
            requestId,
            timestamp: new Date(),
          });
        }

        const rows = await getCandidatesForIntent(id);
        const candidates: CandidateStrategy[] = rows.map((r) => r.candidate);

        const response: ApiResponse<{
          status: string;
          candidates: CandidateStrategy[];
        }> = {
          success: true,
          data: { status: intent.status, candidates },
          requestId,
          timestamp: new Date(),
        };

        return reply.status(200).send(response);
      } catch (err) {
        app.log.error(err);
        return reply.status(500).send({
          success: false,
          error: "Failed to fetch candidates",
          requestId,
          timestamp: new Date(),
        });
      }
    }
  );
};

// ─── Inline planner (replaces BullMQ worker — no Redis required) ─────────────
async function runPlannerInline(
  intentId: string,
  intent: UserIntent,
  orgId: string,
  maxCandidates = 3
): Promise<void> {
  await updateIntentStatus(intentId, "planning");

  const org = await getOrg(orgId);
  if (!org) {
    await updateIntentStatus(intentId, "failed");
    return;
  }

  const constrainedIntent: UserIntent = {
    ...intent,
    allowLeverage: intent.allowLeverage && org.riskParams.allowLeverage,
    allowLiquidationRisk: intent.allowLiquidationRisk && org.riskParams.allowLiquidationRisk,
  };

  const rawCandidates = await planner.generateCandidates(constrainedIntent);
  const generationInfo = planner.getLastGenerationInfo();
  const modelUsed = `${generationInfo.provider}:${generationInfo.model}`;
  const startedAt = Date.now();

  const scoredCandidates = await Promise.all(
    rawCandidates.map(async (candidate) => {
      const riskScore = await riskEngine.assess(candidate.graph, constrainedIntent, constrainedIntent.capitalUsd);
      return { ...candidate, riskScore };
    })
  );

  const { approvedProtocols } = org.riskParams;
  const protocolFiltered = approvedProtocols.length > 0
    ? scoredCandidates.filter((c) => c.graph.nodes.every((n) => approvedProtocols.includes(n.protocol)))
    : scoredCandidates;

  const validCandidates = protocolFiltered
    .filter((c) => c.riskScore.blockers.length === 0)
    .slice(0, maxCandidates);

  const generationMs = Date.now() - startedAt;

  if (validCandidates.length > 0) {
    await storeCandidates(
      validCandidates.map((c, i) => ({
        id: c.id,
        intentId,
        orgId,
        candidate: c,
        rank: i + 1,
        estimatedApyBps: c.graph.estimatedApyBps,
        riskLevel: c.riskScore.overallLevel,
        recommended: c.recommended ? 1 : 0,
        modelUsed,
        generationMs,
      }))
    );
  }

  await updateIntentStatus(
    intentId,
    validCandidates.length > 0 ? "ready" : "failed",
    { candidateCount: validCandidates.length }
  );
}

// ─── LLM intent parser with deterministic fallback ───────────────────────────
let parsingClient: LLMClient | null = null;
function tryGetParsingClient(): LLMClient | null {
  try {
    if (!parsingClient) parsingClient = LLMClient.create("parsing");
    return parsingClient;
  } catch {
    return null;
  }
}

async function parseIntentWithLLM(
  rawInput: string,
  capitalUsd: number
): Promise<UserIntent> {
  const client = tryGetParsingClient();

  if (client) {
    try {
      // 8-second hard timeout so a hung provider doesn't stall the HTTP response
      const llmResult = await Promise.race([
        (async () => {
      const systemPrompt = `
You are an intent parser for an institutional DeFi treasury management system.
Parse the user's investment intent into structured JSON. Be conservative:
- Default allowLeverage/allowLiquidationRisk to false unless explicitly requested
- "safe" or "stable" → conservative, no leverage, no liquidation risk
- "maximize" or "aggressive" → aggressive
- "USDC" or "stablecoins" → primaryAsset = USDC
- Infer maxDrawdownPct from risk tolerance (conservative=5, moderate=15, aggressive=30)

Return ONLY valid JSON with no markdown:
{
  "goal": "yield_generation" | "capital_preservation" | "leveraged_yield" | "delta_neutral" | "lp_farming",
  "primaryAsset": "ETH" | "USDC" | "WETH" | "cbETH" | "wstETH",
  "riskTolerance": "conservative" | "moderate" | "aggressive",
  "liquidityPreference": "instant" | "daily" | "weekly" | "locked",
  "maxDrawdownPct": number,
  "allowLeverage": boolean,
  "allowLiquidationRisk": boolean,
  "allowGovernanceTokens": boolean,
  "constraints": string[]
}`.trim();

      const response = await client.complete(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Parse this DeFi intent: "${rawInput}"` },
        ],
        {
          maxTokens: 512,
          validate: (text) => {
            const match = text.match(/\{[\s\S]*\}/);
            if (!match?.[0]) {
              throw new Error(`Failed to parse intent JSON. Raw: ${text.slice(0, 200)}`);
            }
            JSON.parse(match[0]);
          },
        }
      );

      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (jsonMatch?.[0]) {
        const parsed = JSON.parse(jsonMatch[0]);
        return { id: uuidv4(), rawInput, capitalUsd, preferredChain: 8453, createdAt: new Date(), ...parsed } as UserIntent;
      }
      return null;
        })(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      if (llmResult) return llmResult;
    } catch (err) {
      console.warn("[Intent] LLM parse failed, falling back to rule-based parser:", err instanceof Error ? err.message : err);
    }
  }

  // Deterministic rule-based fallback — no LLM required
  return parseIntentRuleBased(rawInput, capitalUsd);
}

function parseIntentRuleBased(rawInput: string, capitalUsd: number): UserIntent {
  const text = rawInput.toLowerCase();

  const isConservative = /\b(conserv|safe|stable|low.?risk|capital.?preserv|no.?risk)\b/.test(text);
  const isAggressive = /\b(aggress|maxim|high.?yield|risky|leverag)\b/.test(text);
  const riskTolerance = isAggressive ? "aggressive" : isConservative ? "conservative" : "moderate";

  const isStable = /\b(usdc|stable|stablecoin|dollar)\b/.test(text);
  const isEth = /\b(eth|weth|ethereum)\b/.test(text);
  const primaryAsset = isEth && !isStable ? "WETH" : "USDC";

  const allowLeverage = /\b(lever|borrow|collateral|delta)\b/.test(text) && !isConservative;
  const allowLiquidationRisk = allowLeverage;
  const allowGovernanceTokens = !/\b(no.?gov|no.?token|no.?aero|no.?reward)\b/.test(text);

  const isLP = /\b(lp|liquidity.?prov|farm|pool)\b/.test(text);
  const isDelta = /\b(delta.?neutral|hedge)\b/.test(text);
  const isPreserve = /\b(preserv|protect|safe)\b/.test(text);
  const goal = isDelta ? "delta_neutral" : isLP ? "lp_farming" : isPreserve ? "capital_preservation" : "yield_generation";

  const liquidityPreference = /\b(instant|immediate|liquid)\b/.test(text)
    ? "instant" : /\b(week)\b/.test(text) ? "weekly" : "daily";

  const maxDrawdownPct = riskTolerance === "conservative" ? 5 : riskTolerance === "moderate" ? 15 : 30;

  const constraints: string[] = [];
  if (!allowLeverage) constraints.push("no leverage");
  if (!allowGovernanceTokens) constraints.push("no governance tokens");

  console.log(`[Intent] Rule-based parse: goal=${goal}, asset=${primaryAsset}, risk=${riskTolerance}`);

  return {
    id: uuidv4(),
    rawInput,
    capitalUsd,
    preferredChain: 8453,
    createdAt: new Date(),
    goal,
    primaryAsset,
    riskTolerance,
    liquidityPreference,
    maxDrawdownPct,
    allowLeverage,
    allowLiquidationRisk,
    allowGovernanceTokens,
    constraints,
  } as UserIntent;
}
