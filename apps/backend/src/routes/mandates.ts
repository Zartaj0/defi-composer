// ============================================================
// Mandate Routes
// Structured capital rules. V1 creates draft mandates only;
// activation must later be tied to a verified Safe/EOA approval.
// ============================================================

import type { FastifyPluginAsync } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { isAddress, verifyTypedData } from "viem";
import {
  createMandateWithVersion,
  getMandate,
  getMandateVersion,
  getOrg,
  listMandatesForOrg,
  updateMandateStatus,
  updateMandateVersionActivated,
} from "@defi-composer/db";
import type { ApiResponse } from "@defi-composer/shared";

// ── EIP-712 constants ────────────────────────────────────────────────────────

// chainId is NOT hardcoded — the frontend sends the connected wallet's chainId
// in the activate request body, and we use that for verification. This lets the
// same backend work with mainnet (8453), stagenet (52638), and testnets.
const DEFAULT_CHAIN_ID = parseInt(process.env["CHAIN_ID"] ?? "8453", 10);

function buildEip712Domain(chainId: number) {
  return {
    name: "DeFiComposer",
    version: "1",
    chainId,
  } as const;
}

const EIP712_TYPES = {
  MandateActivation: [
    { name: "mandateId", type: "string" },
    { name: "mandateVersionId", type: "string" },
    { name: "reserveFloorUsd", type: "uint256" },
    { name: "riskBudgetPct", type: "uint256" },
    { name: "maxSlippageBps", type: "uint256" },
    { name: "approvedProtocols", type: "string" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

const ALLOWED_ASSETS = new Set(["USDC", "WETH"]);
const ALLOWED_PROTOCOLS = new Set(["aave-v3", "morpho-blue", "uniswap-v3"]);
const ALLOWED_ACTIONS = new Set(["supply", "withdraw", "deposit", "redeem", "swap"]);
const BLOCKED_ACTIONS = [
  "borrow",
  "repay",
  "add_liquidity",
  "remove_liquidity",
  "stake",
  "unstake",
  "leverage",
  "bridge",
];

interface CreateMandateBody {
  orgId: string;
  name: string;
  createdBy: string;
  reserveFloorUsd: number;
  spendableFloorUsd?: number;
  riskBudgetPct: number;
  maxProtocolAllocationPct: number;
  maxSingleActionUsd?: number;
  maxSlippageBps?: number;
  approvedAssets: string[];
  approvedProtocols: string[];
  approvedActions: string[];
  emergencyRules?: Record<string, unknown>;
}

function validateNumber(name: string, value: unknown, min: number, max?: number): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return `${name} must be a finite number`;
  if (value < min) return `${name} must be >= ${min}`;
  if (max !== undefined && value > max) return `${name} must be <= ${max}`;
  return null;
}

function validateSubset(name: string, values: unknown, allowed: Set<string>): string | null {
  if (!Array.isArray(values) || values.length === 0) return `${name} must be a non-empty array`;
  const invalid = values.filter((value) => typeof value !== "string" || !allowed.has(value));
  if (invalid.length > 0) return `${name} contains unsupported values: ${invalid.join(", ")}`;
  return null;
}

function validateMandateInput(body: CreateMandateBody): string[] {
  const errors: string[] = [];

  if (!body.orgId || typeof body.orgId !== "string") errors.push("orgId is required");
  if (!body.name || typeof body.name !== "string") errors.push("name is required");
  if (!isAddress(body.createdBy)) errors.push("createdBy must be a valid EVM address");

  for (const error of [
    validateNumber("reserveFloorUsd", body.reserveFloorUsd, 0),
    validateNumber("spendableFloorUsd", body.spendableFloorUsd ?? 0, 0),
    validateNumber("riskBudgetPct", body.riskBudgetPct, 0, 25),
    validateNumber("maxProtocolAllocationPct", body.maxProtocolAllocationPct, 1, 80),
    validateNumber("maxSingleActionUsd", body.maxSingleActionUsd ?? 1, 1),
    validateNumber("maxSlippageBps", body.maxSlippageBps ?? 30, 1, 100),
    validateSubset("approvedAssets", body.approvedAssets, ALLOWED_ASSETS),
    validateSubset("approvedProtocols", body.approvedProtocols, ALLOWED_PROTOCOLS),
    validateSubset("approvedActions", body.approvedActions, ALLOWED_ACTIONS),
  ]) {
    if (error) errors.push(error);
  }

  if (body.approvedProtocols.includes("uniswap-v3")) {
    const nonSwapActions = body.approvedActions.filter((action) => action !== "swap");
    if (body.approvedProtocols.length === 1 && nonSwapActions.length > 0) {
      errors.push("uniswap-v3 is V1 swap-only and cannot be the sole protocol for yield actions");
    }
  }

  if (body.approvedActions.includes("swap") && !body.approvedProtocols.includes("uniswap-v3")) {
    errors.push("swap action requires uniswap-v3 in approvedProtocols");
  }

  if (body.reserveFloorUsd < (body.spendableFloorUsd ?? 0)) {
    errors.push("reserveFloorUsd must be greater than or equal to spendableFloorUsd");
  }

  return errors;
}

export const mandateRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: CreateMandateBody }>("/", async (request, reply) => {
    const requestId = uuidv4();
    const body = request.body;

    try {
      const inputErrors = validateMandateInput(body);
      if (inputErrors.length > 0) {
        return reply.status(400).send({
          success: false,
          error: inputErrors.join("; "),
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      const org = await getOrg(body.orgId);
      if (!org) {
        return reply.status(404).send({
          success: false,
          error: "Organization not found",
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      if (org.riskParams.requireMultisigForNewStrategy && !org.safeAddress) {
        return reply.status(400).send({
          success: false,
          error: "Organization requires multisig approval but has no Safe address configured",
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      const mandateId = `mandate_${uuidv4()}`;
      const versionId = `mandate_version_${uuidv4()}`;
      const now = new Date();

      const result = await createMandateWithVersion({
        activate: false,
        mandate: {
          id: mandateId,
          orgId: org.id,
          name: body.name.trim(),
          status: "draft",
          activeVersionId: null,
          createdBy: body.createdBy,
          createdAt: now,
          updatedAt: now,
        },
        version: {
          id: versionId,
          mandateId,
          orgId: org.id,
          version: 1,
          status: "draft",
          reserveFloorUsd: body.reserveFloorUsd,
          spendableFloorUsd: body.spendableFloorUsd ?? 0,
          riskBudgetPct: body.riskBudgetPct,
          maxProtocolAllocationPct: body.maxProtocolAllocationPct,
          maxSingleActionUsd: body.maxSingleActionUsd ?? null,
          maxSlippageBps: body.maxSlippageBps ?? 30,
          approvedAssets: body.approvedAssets,
          approvedProtocols: body.approvedProtocols,
          approvedActions: body.approvedActions,
          blockedActions: BLOCKED_ACTIONS,
          emergencyRules: body.emergencyRules ?? {
            pauseOnOracleStale: true,
            pauseOnSimulationExpired: true,
            maxSimulationAgeBlocks: 300,
          },
          createdBy: body.createdBy,
          createdAt: now,
        },
      });

      return reply.status(201).send({
        success: true,
        data: {
          ...result,
          activationRequired: true,
          activationRequirement:
            "Draft mandate stored. Activation must be implemented through verified Safe/EOA approval before the agent can execute against it.",
        },
        requestId,
        timestamp: new Date(),
      });
    } catch (err) {
      app.log.error({ err, requestId }, "Failed to create mandate");
      return reply.status(500).send({
        success: false,
        error: err instanceof Error ? err.message : "Failed to create mandate",
        requestId,
        timestamp: new Date(),
      } satisfies ApiResponse<never>);
    }
  });

  app.get<{ Params: { orgId: string } }>("/org/:orgId", async (request, reply) => {
    const requestId = uuidv4();
    try {
      const mandates = await listMandatesForOrg(request.params.orgId);
      return reply.status(200).send({
        success: true,
        data: mandates,
        requestId,
        timestamp: new Date(),
      });
    } catch (err) {
      app.log.error({ err, requestId }, "Failed to list mandates");
      return reply.status(500).send({
        success: false,
        error: "Failed to list mandates",
        requestId,
        timestamp: new Date(),
      } satisfies ApiResponse<never>);
    }
  });

  app.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const requestId = uuidv4();
    try {
      const mandate = await getMandate(request.params.id);
      if (!mandate) {
        return reply.status(404).send({
          success: false,
          error: "Mandate not found",
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      return reply.status(200).send({
        success: true,
        data: mandate,
        requestId,
        timestamp: new Date(),
      });
    } catch (err) {
      app.log.error({ err, requestId }, "Failed to fetch mandate");
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch mandate",
        requestId,
        timestamp: new Date(),
      } satisfies ApiResponse<never>);
    }
  });

  // ── GET /:id/activation-payload ──────────────────────────────────────────
  // Returns the EIP-712 typed data the frontend should pass to
  // eth_signTypedData_v4 before calling POST /:id/activate.

  app.get<{ Params: { id: string } }>("/:id/activation-payload", async (request, reply) => {
    const requestId = uuidv4();
    try {
      const mandate = await getMandate(request.params.id);
      if (!mandate) {
        return reply.status(404).send({
          success: false,
          error: "Mandate not found",
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      if (mandate.status !== "draft") {
        return reply.status(400).send({
          success: false,
          error: `Mandate is already ${mandate.status} and cannot be activated`,
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      // Use the latest draft version
      const draftVersion = mandate.versions.find((v) => v.status === "draft");
      if (!draftVersion) {
        return reply.status(400).send({
          success: false,
          error: "No draft mandate version found",
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }

      const message = {
        mandateId: mandate.id,
        mandateVersionId: draftVersion.id,
        reserveFloorUsd: BigInt(Math.round(draftVersion.reserveFloorUsd)),
        riskBudgetPct: BigInt(Math.round(draftVersion.riskBudgetPct)),
        maxSlippageBps: BigInt(draftVersion.maxSlippageBps),
        approvedProtocols: draftVersion.approvedProtocols.join(","),
        nonce: BigInt(draftVersion.version),
      };

      // Serialise bigints as strings so they are JSON-safe
      const jsonSafeMessage = {
        mandateId: message.mandateId,
        mandateVersionId: message.mandateVersionId,
        reserveFloorUsd: message.reserveFloorUsd.toString(),
        riskBudgetPct: message.riskBudgetPct.toString(),
        maxSlippageBps: message.maxSlippageBps.toString(),
        approvedProtocols: message.approvedProtocols,
        nonce: message.nonce.toString(),
      };

      return reply.status(200).send({
        success: true,
        data: {
          domain: buildEip712Domain(DEFAULT_CHAIN_ID),
          types: EIP712_TYPES,
          primaryType: "MandateActivation",
          message: jsonSafeMessage,
        },
        requestId,
        timestamp: new Date(),
      });
    } catch (err) {
      app.log.error({ err, requestId }, "Failed to build activation payload");
      return reply.status(500).send({
        success: false,
        error: "Failed to build activation payload",
        requestId,
        timestamp: new Date(),
      } satisfies ApiResponse<never>);
    }
  });

  // ── POST /:id/activate ───────────────────────────────────────────────────
  // Verifies an EIP-712 signature over the mandate parameters and, if valid,
  // transitions the mandate from "draft" → "active".

  interface ActivateMandateBody {
    signature: `0x${string}`;
    signerAddress: `0x${string}`;
    chainId?: number; // connected wallet's chain ID — must match what was signed
  }

  app.post<{ Params: { id: string }; Body: ActivateMandateBody }>(
    "/:id/activate",
    async (request, reply) => {
      const requestId = uuidv4();
      try {
        const { id } = request.params;
        const { signature, signerAddress, chainId: clientChainId } = request.body;
        // Use the chainId the client signed with; fall back to CHAIN_ID env / 8453
        const signingChainId = clientChainId ?? DEFAULT_CHAIN_ID;

        // ── Basic input validation ────────────────────────────────────────
        if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
          return reply.status(400).send({
            success: false,
            error: "signature must be a hex string starting with 0x",
            requestId,
            timestamp: new Date(),
          } satisfies ApiResponse<never>);
        }

        if (!isAddress(signerAddress)) {
          return reply.status(400).send({
            success: false,
            error: "signerAddress must be a valid EVM address",
            requestId,
            timestamp: new Date(),
          } satisfies ApiResponse<never>);
        }

        // ── Fetch mandate ─────────────────────────────────────────────────
        const mandate = await getMandate(id);
        if (!mandate) {
          return reply.status(404).send({
            success: false,
            error: "Mandate not found",
            requestId,
            timestamp: new Date(),
          } satisfies ApiResponse<never>);
        }

        if (mandate.status !== "draft") {
          return reply.status(400).send({
            success: false,
            error: `Mandate is already ${mandate.status} and cannot be activated`,
            requestId,
            timestamp: new Date(),
          } satisfies ApiResponse<never>);
        }

        // ── Ownership check ───────────────────────────────────────────────
        if (signerAddress.toLowerCase() !== mandate.createdBy.toLowerCase()) {
          return reply.status(403).send({
            success: false,
            error: "signerAddress does not match the mandate owner",
            requestId,
            timestamp: new Date(),
          } satisfies ApiResponse<never>);
        }

        // ── Locate the draft version ──────────────────────────────────────
        const draftVersion = mandate.versions.find((v) => v.status === "draft");
        if (!draftVersion) {
          return reply.status(400).send({
            success: false,
            error: "No draft mandate version found to activate",
            requestId,
            timestamp: new Date(),
          } satisfies ApiResponse<never>);
        }

        // ── Build EIP-712 message ─────────────────────────────────────────
        const message = {
          mandateId: mandate.id,
          mandateVersionId: draftVersion.id,
          reserveFloorUsd: BigInt(Math.round(draftVersion.reserveFloorUsd)),
          riskBudgetPct: BigInt(Math.round(draftVersion.riskBudgetPct)),
          maxSlippageBps: BigInt(draftVersion.maxSlippageBps),
          approvedProtocols: draftVersion.approvedProtocols.join(","),
          nonce: BigInt(draftVersion.version),
        } as const;

        // ── Verify signature ──────────────────────────────────────────────
        let isValid: boolean;
        try {
          isValid = await verifyTypedData({
            address: signerAddress,
            domain: buildEip712Domain(signingChainId),
            types: EIP712_TYPES,
            primaryType: "MandateActivation",
            message,
            signature,
          });
        } catch (verifyErr) {
          app.log.warn({ verifyErr, requestId }, "Signature verification threw");
          isValid = false;
        }

        if (!isValid) {
          return reply.status(401).send({
            success: false,
            error: "Signature verification failed",
            requestId,
            timestamp: new Date(),
          } satisfies ApiResponse<never>);
        }

        // ── Persist activation ────────────────────────────────────────────
        const [updatedMandate, updatedVersion] = await Promise.all([
          updateMandateStatus(mandate.id, "active", draftVersion.id),
          updateMandateVersionActivated(draftVersion.id, "active"),
        ]);

        if (!updatedMandate || !updatedVersion) {
          throw new Error("Database update returned no rows");
        }

        // Fetch the full mandate with relations to return consistent shape
        const freshMandate = await getMandate(mandate.id);

        return reply.status(200).send({
          success: true,
          data: freshMandate,
          requestId,
          timestamp: new Date(),
        });
      } catch (err) {
        app.log.error({ err, requestId }, "Failed to activate mandate");
        return reply.status(500).send({
          success: false,
          error: err instanceof Error ? err.message : "Failed to activate mandate",
          requestId,
          timestamp: new Date(),
        } satisfies ApiResponse<never>);
      }
    },
  );
};
