// ============================================================
// Simulation Routes
// POST /api/v1/simulations       — enqueue fork simulation job
// GET  /api/v1/simulations/:id   — poll simulation artifact
// GET  /api/v1/simulations/mandate/:mandateId — list for mandate
// ============================================================

import type { FastifyPluginAsync } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { isAddress, createPublicClient } from "viem";
import { Queue } from "bullmq";
import {
  getMandate,
  getOrg,
  getSimulationArtifact,
  createExecutionRecord,
  listSimulationsForMandate,
  listDecisionsForMandate,
  listMandateActivity,
} from "@defi-composer/db";
import {
  submitSafeProposal,
  getSafeInfo,
  listPendingSafeProposals,
} from "@defi-composer/execution-engine";
import type { ApiResponse } from "@defi-composer/shared";
import type { PlaybookName } from "@defi-composer/simulation-engine";
import {
  buildSafeTxStruct,
  encodeSafeTxForSigning,
  createFallbackTransport,
} from "@defi-composer/simulation-engine";

// Inline job payload — mirrors mandate-executor.ts, avoids cross-service import
interface MandateSimulationJobPayload {
  orgId: string;
  mandateId: string;
  playbook: PlaybookName;
  amountHuman: string;
  trigger: string;
  explanation: string;
  observedLiquidUsd: number;
  existingDecisionId?: string;
}

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

const VALID_PLAYBOOKS: PlaybookName[] = [
  "aave_supply_usdc",
  "aave_supply_weth",
  "aave_withdraw_usdc",
  "aave_withdraw_weth",
  "uniswap_weth_to_usdc",
];

const simulationQueue = new Queue<MandateSimulationJobPayload>("mandate-simulation", {
  connection: {
    host: new URL(REDIS_URL).hostname,
    port: parseInt(new URL(REDIS_URL).port || "6379"),
  },
});

interface RunSimulationBody {
  mandateId: string;
  playbook: PlaybookName;
  amountHuman: string;
  observedLiquidUsd: number;
  trigger?: string;
  explanation?: string;
}

export const simulationRoutes: FastifyPluginAsync = async (app) => {

  // ── POST / — enqueue simulation job ──────────────────────────
  app.post<{ Body: RunSimulationBody }>(
    "/",
    {
      schema: {
        body: {
          type: "object",
          required: ["mandateId", "playbook", "amountHuman", "observedLiquidUsd"],
          properties: {
            mandateId: { type: "string" },
            playbook: { type: "string" },
            amountHuman: { type: "string" },
            observedLiquidUsd: { type: "number" },
            trigger: { type: "string" },
            explanation: { type: "string" },
            onBehalfOf: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const requestId = uuidv4();
      const {
        mandateId,
        playbook,
        amountHuman,
        observedLiquidUsd,
        trigger = "api_request",
        explanation = "Manual simulation request",
        onBehalfOf,
      } = request.body as typeof request.body & { onBehalfOf?: string };

      // Validate playbook
      if (!VALID_PLAYBOOKS.includes(playbook)) {
        return reply.status(400).send({
          success: false,
          error: `Invalid playbook '${playbook}'. Valid playbooks: ${VALID_PLAYBOOKS.join(", ")}`,
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      // Validate amountHuman
      const amount = parseFloat(amountHuman);
      if (!Number.isFinite(amount) || amount <= 0) {
        return reply.status(400).send({
          success: false,
          error: "amountHuman must be a positive number string",
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      // Validate mandate exists and is active
      const mandate = await getMandate(mandateId);
      if (!mandate) {
        return reply.status(404).send({
          success: false,
          error: `Mandate ${mandateId} not found`,
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }
      if (mandate.status !== "active") {
        return reply.status(400).send({
          success: false,
          error: `Mandate ${mandateId} is not active (status: ${mandate.status}). Activate it first.`,
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      // If no onBehalfOf provided, default to the org's Safe address so generated
      // calldata correctly names the Safe as beneficiary/recipient.
      const org = await getOrg(mandate.orgId).catch(() => null);
      const resolvedOnBehalfOf = onBehalfOf ?? org?.safeAddress ?? undefined;

      // Enqueue simulation job
      const job = await simulationQueue.add(
        "run-simulation",
        {
          orgId: mandate.orgId,
          mandateId,
          playbook,
          amountHuman,
          trigger,
          explanation,
          observedLiquidUsd,
          ...(resolvedOnBehalfOf ? { onBehalfOf: resolvedOnBehalfOf } : {}),
        },
        {
          attempts: 2,
          backoff: { type: "fixed", delay: 5_000 },
        }
      );

      app.log.info(
        { jobId: job.id, mandateId, playbook, amountHuman },
        "Simulation job enqueued"
      );

      return reply.status(202).send({
        success: true,
        data: {
          jobId: job.id,
          mandateId,
          playbook,
          amountHuman,
          observedLiquidUsd,
          statusMessage: "Simulation queued. Poll /api/v1/simulations/job/:jobId for result.",
        },
        requestId,
        timestamp: new Date(),
      } satisfies ApiResponse<{
        jobId: string | undefined;
        mandateId: string;
        playbook: PlaybookName;
        amountHuman: string;
        observedLiquidUsd: number;
        statusMessage: string;
      }>);
    }
  );

  // ── GET /:simulationId/safe-proposal ─────────────────────────
  //
  // Returns a Safe transaction struct + EIP-712 payload built from
  // a fork-proven simulation artifact.
  //
  // FORK_MODE=true (V1): no external Safe API calls are made here.
  // The caller must:
  //   1. Fetch the Safe nonce from the Safe Transaction Service
  //   2. Replace `safeTxStruct.nonce` with the real value
  //   3. Sign the eip712Payload with each Safe owner
  //   4. POST to https://safe-transaction-base.safe.global
  //
  // Query params:
  //   safeAddress  — the Safe multisig address (required)
  app.get<{
    Params: { simulationId: string };
    Querystring: { safeAddress?: string };
  }>(
    "/:simulationId/safe-proposal",
    {
      schema: {
        params: {
          type: "object",
          required: ["simulationId"],
          properties: {
            simulationId: { type: "string" },
          },
        },
        querystring: {
          type: "object",
          properties: {
            safeAddress: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const requestId = uuidv4();
      const { simulationId } = request.params;
      const { safeAddress } = request.query;

      // Validate safeAddress if provided
      if (safeAddress !== undefined && !isAddress(safeAddress)) {
        return reply.status(400).send({
          success: false,
          error: "safeAddress must be a valid EVM address",
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      // Load artifact from DB
      const artifact = await getSimulationArtifact(simulationId);
      if (!artifact) {
        return reply.status(404).send({
          success: false,
          error: `Simulation artifact ${simulationId} not found`,
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      // Only passed simulations can be proposed
      if (artifact.status !== "passed") {
        return reply.status(422).send({
          success: false,
          error: `Simulation ${simulationId} has status '${artifact.status}' — only 'passed' artifacts can be proposed`,
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      // Stale check — uses fallback transport so KEY_1 rate limits fall over to KEY_2
      const publicClient = createPublicClient({ transport: createFallbackTransport() });

      let currentBlock: bigint;
      try {
        currentBlock = await publicClient.getBlockNumber();
      } catch {
        // If RPC is unreachable, warn but don't block — let the caller decide
        currentBlock = BigInt(artifact.validUntilBlock);
      }

      const isStale = currentBlock > BigInt(artifact.validUntilBlock);
      const blocksRemaining = isStale
        ? 0
        : Number(BigInt(artifact.validUntilBlock) - currentBlock);

      // Build Safe TX struct from artifact calldata
      const rawCalldata = artifact.inputCalldata as Array<{
        to: string;
        data: string;
        value?: string;
      }>;

      if (!Array.isArray(rawCalldata) || rawCalldata.length === 0) {
        return reply.status(422).send({
          success: false,
          error: "Simulation artifact has no executable calldata",
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      const safeTxStruct = buildSafeTxStruct(rawCalldata, artifact.gasEstimate);

      // EIP-712 payload — use safeAddress from query or a placeholder if not given
      const effectiveSafeAddress = safeAddress ?? "0x0000000000000000000000000000000000000000";
      const eip712Payload = encodeSafeTxForSigning(safeTxStruct, effectiveSafeAddress, 8453);

      return reply.status(200).send({
        success: true,
        data: {
          simulationId,
          isStale,
          blocksRemaining,
          currentBlock: currentBlock.toString(),
          validUntilBlock: artifact.validUntilBlock,
          gasEstimate: artifact.gasEstimate,
          calldataHash: artifact.calldataHash,
          safeTxStruct,
          eip712Payload,
          // Helpful metadata for the frontend
          meta: {
            safeTransactionServiceUrl: "https://safe-transaction-base.safe.global",
            multiSendCallOnly: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
            chainId: 8453,
            isBatch: rawCalldata.length > 1,
            txCount: rawCalldata.length,
            forkMode: true,
            note: safeAddress === undefined
              ? "safeAddress not provided — eip712Payload.domain.verifyingContract is address(0). " +
                "Pass ?safeAddress=0x... to get a signable payload."
              : "Replace safeTxStruct.nonce with the real Safe nonce before signing.",
          },
        },
        requestId,
        timestamp: new Date(),
      });
    }
  );

  // ── GET /job/:jobId — poll job status and result ──────────────
  app.get<{ Params: { jobId: string } }>(
    "/job/:jobId",
    async (request, reply) => {
      const requestId = uuidv4();
      const { jobId } = request.params;

      const job = await simulationQueue.getJob(jobId);
      if (!job) {
        return reply.status(404).send({
          success: false,
          error: `Simulation job ${jobId} not found`,
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      const state = await job.getState();
      const progress = job.progress;
      const result = job.returnvalue;
      const failedReason = job.failedReason;

      return reply.status(200).send({
        success: true,
        data: {
          jobId,
          state,
          progress,
          result: result ?? null,
          failedReason: failedReason ?? null,
        },
        requestId,
        timestamp: new Date(),
      });
    }
  );

  // ── POST /:simulationId/submit — submit Safe proposal ─────────
  //
  // Submits a fork-proven simulation to the Safe Transaction Service.
  // Creates an ExecutionRecord with status "submitted" and the safeTxHash.
  //
  // Body: { safeAddress: string }
  // - If EXECUTOR_PRIVATE_KEY is set, signs and submits automatically.
  // - Returns the safeTxHash for tracking and the Safe UI deep link.
  app.post<{
    Params: { simulationId: string };
    Body: { safeAddress: string; orgId: string };
  }>(
    "/:simulationId/submit",
    {
      schema: {
        params: {
          type: "object",
          required: ["simulationId"],
          properties: { simulationId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["safeAddress", "orgId"],
          properties: {
            safeAddress: { type: "string" },
            orgId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const requestId = uuidv4();
      const { simulationId } = request.params;
      const { safeAddress, orgId } = request.body;

      if (!isAddress(safeAddress)) {
        return reply.status(400).send({
          success: false,
          error: "safeAddress must be a valid EVM address",
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      // Load artifact
      const artifact = await getSimulationArtifact(simulationId);
      if (!artifact) {
        return reply.status(404).send({
          success: false,
          error: `Simulation ${simulationId} not found`,
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }
      if (artifact.status !== "passed") {
        return reply.status(422).send({
          success: false,
          error: `Simulation ${simulationId} has status "${artifact.status}" — only passed simulations can be submitted`,
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      // Stale check
      const publicClient = createPublicClient({ transport: createFallbackTransport() });
      let currentBlock = BigInt(artifact.validUntilBlock);
      try { currentBlock = await publicClient.getBlockNumber(); } catch { /* use validUntilBlock */ }
      if (currentBlock > BigInt(artifact.validUntilBlock)) {
        return reply.status(422).send({
          success: false,
          error: `Simulation is stale (expired at block ${artifact.validUntilBlock}, current=${currentBlock}). Re-simulate first.`,
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      // Validate Safe exists on Base
      const safeInfo = await getSafeInfo(safeAddress as `0x${string}`);
      if (!safeInfo) {
        return reply.status(400).send({
          success: false,
          error: `${safeAddress} is not a deployed Safe on Base mainnet`,
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      // Build and submit
      const calldata = artifact.inputCalldata as Array<{ to: string; data: string; value?: string }>;
      const safeTxStruct = buildSafeTxStruct(calldata, artifact.gasEstimate);

      const submitResult = await submitSafeProposal({
        safeAddress: safeAddress as `0x${string}`,
        safeTxStruct,
        simulationId,
      });

      // Create ExecutionRecord
      const execId = `exec_${uuidv4().slice(0, 12)}`;
      await createExecutionRecord({
        id: execId,
        orgId,
        simulationArtifactId: simulationId,
        mandateVersionId: artifact.mandateVersionId,
        accountAddress: safeAddress,
        safeTxId: submitResult.safeTxHash,
        status: "submitted",
        submittedAt: new Date(),
      });

      app.log.info(
        { execId, safeTxHash: submitResult.safeTxHash, safeAddress },
        "Safe proposal submitted"
      );

      return reply.status(201).send({
        success: true,
        data: {
          executionRecordId: execId,
          safeTxHash:        submitResult.safeTxHash,
          nonce:             submitResult.nonce,
          proposerAddress:   submitResult.proposerAddress,
          submittedAt:       submitResult.submittedAt,
          safeUiUrl:         `https://app.safe.global/transactions/queue?safe=base:${safeAddress}`,
          message: `Proposal submitted to Safe. The ${safeInfo.threshold}/${safeInfo.owners.length} owners must sign to execute.`,
        },
        requestId,
        timestamp: new Date(),
      });
    }
  );

  // ── GET /safe/:safeAddress/pending — list pending proposals ──
  app.get<{ Params: { safeAddress: string } }>(
    "/safe/:safeAddress/pending",
    async (request, reply) => {
      const requestId = uuidv4();
      const { safeAddress } = request.params;

      if (!isAddress(safeAddress)) {
        return reply.status(400).send({
          success: false,
          error: "Invalid safeAddress",
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      const proposals = await listPendingSafeProposals(safeAddress as `0x${string}`);
      return reply.status(200).send({
        success: true,
        data: { proposals, count: proposals.length },
        requestId,
        timestamp: new Date(),
      });
    }
  );

  // ── GET /mandate/:mandateId/history — decisions + simulations ─
  // Legacy endpoint kept for backwards compatibility.
  app.get<{ Params: { mandateId: string } }>(
    "/mandate/:mandateId/history",
    async (request, reply) => {
      const requestId = uuidv4();
      const { mandateId } = request.params;
      try {
        const [decisions, simulations] = await Promise.all([
          listDecisionsForMandate(mandateId, 20),
          listSimulationsForMandate(mandateId, 20),
        ]);
        return reply.status(200).send({
          success: true,
          data: { decisions, simulations },
          requestId,
          timestamp: new Date(),
        });
      } catch (err) {
        app.log.error(err);
        return reply.status(500).send({
          success: false,
          error: "Failed to fetch mandate history",
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }
    }
  );

  // ── GET /mandate/:mandateId/activity — joined proof feed ──────
  // Returns decision → simulation → execution in one response,
  // plus live onchain Safe status (balances, module, policy).
  app.get<{ Params: { mandateId: string } }>(
    "/mandate/:mandateId/activity",
    async (request, reply) => {
      const requestId = uuidv4();
      const { mandateId } = request.params;
      try {
        const mandate = await getMandate(mandateId);
        if (!mandate) {
          return reply.status(404).send({
            success: false,
            error: `Mandate ${mandateId} not found`,
            requestId,
            timestamp: new Date(),
          } satisfies ApiResponse<never>);
        }

        const org = await getOrg(mandate.orgId).catch(() => null);
        const safeAddress = org?.safeAddress ?? null;

        // ── Fetch activity rows (DB join) ─────────────────────────
        const activity = await listMandateActivity(mandateId, 30);

        // ── Fetch onchain Safe status ─────────────────────────────
        let safeStatus: {
          safeAddress: string | null;
          chainId: number;
          moduleAddress: string | null;
          moduleEnabled: boolean;
          usdcBalance: string | null;
          ausdcBalance: string | null;
          policy: { maxSingleActionUsdc: string; dailyLimitUsdc: string; reserveFloorUsdc: string } | null;
        } = {
          safeAddress,
          chainId: parseInt(process.env["CHAIN_ID"] ?? "84532", 10),
          moduleAddress: process.env["MODULE_ADDRESS"] ?? null,
          moduleEnabled: false,
          usdcBalance: null,
          ausdcBalance: null,
          policy: null,
        };

        if (safeAddress) {
          try {
            const chainId = parseInt(process.env["CHAIN_ID"] ?? "84532", 10);
            const rpcUrl  = chainId === 84532
              ? (process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org")
              : (process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org");
            const moduleAddr = process.env["MODULE_ADDRESS"] ?? "";

            const client = createPublicClient({
              transport: createFallbackTransport(),
            });

            // Parallel onchain reads
            const ERC20_ABI = [{
              name: "balanceOf",
              type: "function",
              inputs: [{ name: "account", type: "address" }],
              outputs: [{ name: "", type: "uint256" }],
              stateMutability: "view",
            }] as const;

            const MODULE_ABI = [
              {
                name: "isModuleEnabled",
                type: "function",
                inputs: [{ name: "module", type: "address" }],
                outputs: [{ name: "", type: "bool" }],
                stateMutability: "view",
              },
              {
                // Public struct getter — Solidity auto-generates:
                // function policy() returns (bool active, uint256 maxSingleActionUsdc, uint256 dailyLimitUsdc, uint256 reserveFloorUsdc)
                name: "policy",
                type: "function",
                inputs: [],
                outputs: [
                  { name: "active",              type: "bool"    },
                  { name: "maxSingleActionUsdc", type: "uint256" },
                  { name: "dailyLimitUsdc",      type: "uint256" },
                  { name: "reserveFloorUsdc",    type: "uint256" },
                ],
                stateMutability: "view",
              },
            ] as const;

            // Token addresses — branched by chain
            // Base Sepolia (84532): protocol-team testnet USDC + Aave aUSDC
            // Base mainnet  (8453): Circle USDC + Aave aUSDC
            const TOKEN_ADDRESSES: Record<number, { usdc: `0x${string}`; ausdc: `0x${string}` }> = {
              84532: {
                usdc:  "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
                ausdc: "0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC",
              },
              8453: {
                usdc:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                ausdc: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
              },
            };
            const addrs = TOKEN_ADDRESSES[chainId] ?? TOKEN_ADDRESSES[84532]!;
            const USDC_ADDR  = addrs.usdc;
            const AUSDC_ADDR = addrs.ausdc;

            void rpcUrl; // used for context; client uses createFallbackTransport()

            const [usdcRaw, ausdcRaw, enabled, policyRaw] = await Promise.allSettled([
              client.readContract({ address: USDC_ADDR,  abi: ERC20_ABI, functionName: "balanceOf", args: [safeAddress as `0x${string}`] }),
              client.readContract({ address: AUSDC_ADDR, abi: ERC20_ABI, functionName: "balanceOf", args: [safeAddress as `0x${string}`] }),
              moduleAddr ? client.readContract({ address: safeAddress as `0x${string}`, abi: MODULE_ABI, functionName: "isModuleEnabled", args: [moduleAddr as `0x${string}`] }) : Promise.resolve(false),
              moduleAddr ? client.readContract({ address: moduleAddr as `0x${string}`, abi: MODULE_ABI, functionName: "policy" }) : Promise.resolve(null),
            ]);

            const fmt6 = (raw: bigint) => (Number(raw) / 1e6).toFixed(6);

            safeStatus = {
              safeAddress,
              chainId,
              moduleAddress: moduleAddr || null,
              moduleEnabled: enabled.status === "fulfilled" ? (enabled.value as boolean) : false,
              usdcBalance:   usdcRaw.status  === "fulfilled" ? fmt6(usdcRaw.value  as bigint) : null,
              ausdcBalance:  ausdcRaw.status === "fulfilled" ? fmt6(ausdcRaw.value as bigint) : null,
              policy: policyRaw.status === "fulfilled" && policyRaw.value ? (() => {
                // Destructure: [active, maxSingleActionUsdc, dailyLimitUsdc, reserveFloorUsdc]
                const [, max, daily, floor] = policyRaw.value as [boolean, bigint, bigint, bigint];
                return {
                  maxSingleActionUsdc: fmt6(max),
                  dailyLimitUsdc:      fmt6(daily),
                  reserveFloorUsdc:    fmt6(floor),
                };
              })() : null,
            };
          } catch (onchainErr) {
            app.log.warn({ onchainErr }, "Failed to fetch onchain Safe status — returning DB data only");
          }
        }

        return reply.status(200).send({
          success: true,
          data: { activity, safeStatus },
          requestId,
          timestamp: new Date(),
        });
      } catch (err) {
        app.log.error(err);
        return reply.status(500).send({
          success: false,
          error: "Failed to fetch mandate activity",
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }
    }
  );
};
