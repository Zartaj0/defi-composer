// ============================================================
// Simulation Routes
// POST /api/v1/simulations       — run simulation inline (Redis-free)
// GET  /api/v1/simulations/:id   — fetch simulation artifact
// GET  /api/v1/simulations/mandate/:mandateId — list for mandate
// ============================================================

import type { FastifyPluginAsync } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { isAddress, createPublicClient, http } from "viem";
import {
  getMandate,
  getOrg,
  getSimulationArtifact,
  createSimulationArtifact,
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
  mandateSimulator,
  buildSafeTxStruct,
  encodeSafeTxForSigning,
  createFallbackTransport,
  getActiveChainId,
  getActiveContracts,
} from "@defi-composer/simulation-engine";

const VALID_PLAYBOOKS: PlaybookName[] = [
  "aave_supply_usdc",
  "aave_supply_weth",
  "aave_withdraw_usdc",
  "aave_withdraw_weth",
  "uniswap_weth_to_usdc",
];

// ── Chain-aware helpers ────────────────────────────────────────

/** Returns the Safe TX Service URL for the active chain. */
function getSafeTxServiceUrl(chainId: number): string {
  if (chainId === 84532) return "https://api.safe.global/tx-service/basesep";
  if (chainId === 8453)  return "https://api.safe.global/tx-service/base";
  // stagenet (52638) and Ethereum mainnet (1) don't have a public Safe TX Service.
  // Direct PolicyModule execution is used instead.
  return process.env["SAFE_TX_SERVICE_URL"] ?? "https://api.safe.global/tx-service/base";
}

/** Returns the MultiSendCallOnly address for the active chain. */
function getMultiSendAddress(chainId: number): string {
  // v1.4.1 is deployed at the same address via CREATE2 on all chains where Safe is supported
  return "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
}

/** Returns chain-aware RPC URL. */
function getChainRpcUrl(chainId: number): string {
  if (chainId === 84532) return process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org";
  if (chainId === 52638 || chainId === 1) return process.env["MONITOR_RPC_URL"] ?? process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org";
  return process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org";
}

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

      // Default onBehalfOf to the org's Safe address (or first wallet) so calldata
      // names the correct treasury as beneficiary/recipient.
      const org = await getOrg(mandate.orgId).catch(() => null);
      const walletAddress = (org as { wallets?: Array<{ address: string }> } | null)?.wallets?.[0]?.address;
      const resolvedOnBehalfOf = onBehalfOf ?? org?.safeAddress ?? walletAddress ?? undefined;

      // Resolve active mandate version for policy fields
      const activeVersion =
        mandate.versions.find(v => v.id === mandate.activeVersionId) ??
        mandate.versions[0];

      if (!activeVersion) {
        return reply.status(422).send({
          success: false,
          error: "Mandate has no active version",
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      // ── Run simulation inline (Redis-free) ────────────────────
      // The agent loop handles autonomous simulation. This route is for
      // manual / on-demand simulation (testing, dashboard triggers).
      app.log.info({ mandateId, playbook, amountHuman }, "Running inline simulation");

      let artifact;
      try {
        artifact = await mandateSimulator.run({
          playbook,
          mandate: {
            mandateVersionId: activeVersion.id,
            approvedAssets:    activeVersion.approvedAssets    as string[],
            approvedProtocols: activeVersion.approvedProtocols as string[],
            approvedActions:   activeVersion.approvedActions   as string[],
            blockedActions:    activeVersion.blockedActions    as string[],
            maxSlippageBps:    activeVersion.maxSlippageBps    as number,
            ...(activeVersion.maxSingleActionUsd != null ? { maxSingleActionUsd: activeVersion.maxSingleActionUsd as number } : {}),
            reserveFloorUsd:   activeVersion.reserveFloorUsd   as number,
          },
          params: {
            amountHuman,
            ...(resolvedOnBehalfOf ? { onBehalfOf: resolvedOnBehalfOf as `0x${string}` } : {}),
          },
          observedState: { liquidUsd: observedLiquidUsd },
          orgId: mandate.orgId,
        });
      } catch (simErr) {
        app.log.error({ simErr, mandateId, playbook }, "Simulation failed");
        return reply.status(500).send({
          success: false,
          error: `Simulation failed: ${simErr instanceof Error ? simErr.message : String(simErr)}`,
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      // Persist the artifact
      await createSimulationArtifact({
        id: artifact.id,
        orgId: artifact.orgId,
        decisionId: artifact.decisionId,
        mandateVersionId: artifact.mandateVersionId,
        chainId: artifact.chainId,
        forkBlockNumber: artifact.forkBlockNumber,
        validUntilBlock: artifact.validUntilBlock,
        rpcSource: artifact.rpcSource,
        calldataHash: artifact.calldataHash,
        inputCalldata: artifact.inputCalldata,
        balancesBefore: artifact.balancesBefore,
        balancesAfter: artifact.balancesAfter,
        expectedDeltas: artifact.expectedDeltas,
        gasEstimate: artifact.gasEstimate,
        status: artifact.status,
        ...(artifact.failureReason ? { failureReason: artifact.failureReason } : {}),
      });

      app.log.info(
        { simulationId: artifact.id, status: artifact.status, mandateId, playbook },
        "Simulation complete"
      );

      return reply.status(201).send({
        success: true,
        data: {
          simulationId:   artifact.id,
          status:         artifact.status,
          mandateId,
          playbook,
          amountHuman,
          gasEstimate:    artifact.gasEstimate,
          forkBlockNumber: artifact.forkBlockNumber,
          calldataHash:   artifact.calldataHash,
          failureReason:  artifact.failureReason ?? null,
          message: artifact.status === "passed"
            ? `Simulation passed at block ${artifact.forkBlockNumber}. Fetch /${artifact.id}/safe-proposal for the Safe tx payload.`
            : `Simulation failed: ${artifact.failureReason}`,
        },
        requestId,
        timestamp: new Date(),
      });
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

      // EIP-712 payload — chainId comes from the artifact (where the simulation ran),
      // not hardcoded. Stagenet is 52638, Base mainnet is 8453, etc.
      const artifactChainId = artifact.chainId;
      const effectiveSafeAddress = safeAddress ?? "0x0000000000000000000000000000000000000000";
      const eip712Payload = encodeSafeTxForSigning(safeTxStruct, effectiveSafeAddress, artifactChainId);

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
            safeTransactionServiceUrl: getSafeTxServiceUrl(artifactChainId),
            multiSendCallOnly: getMultiSendAddress(artifactChainId),
            chainId: artifactChainId,
            isBatch: rawCalldata.length > 1,
            txCount: rawCalldata.length,
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
        // Fall back to the first registered wallet address when there's no Safe
        const walletAddress = (org as { wallets?: Array<{ address: string }> } | null)
          ?.wallets?.[0]?.address ?? null;
        const treasuryAddress = safeAddress ?? walletAddress;

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
          chainId: parseInt(process.env["CHAIN_ID"] ?? "8453", 10),
          moduleAddress: process.env["MODULE_ADDRESS"] ?? null,
          moduleEnabled: false,
          usdcBalance: null,
          ausdcBalance: null,
          policy: null,
        };

        if (treasuryAddress) {
          try {
            const chainId = parseInt(process.env["CHAIN_ID"] ?? "8453", 10);
            const rpcUrl  = getChainRpcUrl(chainId);
            const moduleAddr = process.env["MODULE_ADDRESS"] ?? "";

            // Use the explicitly computed rpcUrl (chain-aware), NOT createFallbackTransport()
            // which may resolve to a different URL depending on env var names.
            const client = createPublicClient({
              transport: http(rpcUrl, { timeout: 10_000 }),
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
              // stagenet (52638) + Ethereum mainnet (1) — same addresses
              52638: {
                usdc:  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                ausdc: "0x98C23E9d8f34FEFb1B7BD6a91B7AF122a1f5cE47",
              },
              1: {
                usdc:  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                ausdc: "0x98C23E9d8f34FEFb1B7BD6a91B7AF122a1f5cE47",
              },
            };
            // Fall back to mainnet addresses if chain not recognized (not Base Sepolia)
            const addrs = TOKEN_ADDRESSES[chainId] ?? (chainId !== 84532 ? TOKEN_ADDRESSES[1]! : TOKEN_ADDRESSES[84532]!);
            const USDC_ADDR  = addrs.usdc;
            const AUSDC_ADDR = addrs.ausdc;

            app.log.info({ rpcUrl, chainId, treasuryAddress }, "Fetching onchain balances");

            const [usdcRaw, ausdcRaw, enabled, policyRaw] = await Promise.allSettled([
              client.readContract({ address: USDC_ADDR,  abi: ERC20_ABI, functionName: "balanceOf", args: [treasuryAddress as `0x${string}`] }),
              client.readContract({ address: AUSDC_ADDR, abi: ERC20_ABI, functionName: "balanceOf", args: [treasuryAddress as `0x${string}`] }),
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
            app.log.warn({ onchainErr, treasuryAddress, rpcUrl: process.env["BASE_RPC_URL"] }, "Failed to fetch onchain balance — returning DB data only");
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
