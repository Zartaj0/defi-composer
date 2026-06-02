// ============================================================
// Mandate Queries
// Versioned capital rules used by the agent decision loop.
// ============================================================

import { and, eq, gte, inArray } from "drizzle-orm";
import { db } from "../client";
import {
  mandates,
  mandateVersions,
  strategyCells,
  agentDecisions,
  simulationArtifacts,
  executionRecords,
} from "../schema/index";

export async function createMandateWithVersion(data: {
  mandate: typeof mandates.$inferInsert;
  version: typeof mandateVersions.$inferInsert;
  activate: boolean;
}) {
  return db.transaction(async (tx) => {
    const [mandate] = await tx.insert(mandates).values(data.mandate).returning();
    const [version] = await tx.insert(mandateVersions).values(data.version).returning();

    if (!mandate || !version) {
      throw new Error("Failed to create mandate");
    }

    if (data.activate) {
      const [activeMandate] = await tx
        .update(mandates)
        .set({
          status: "active",
          activeVersionId: version.id,
          updatedAt: new Date(),
        })
        .where(eq(mandates.id, mandate.id))
        .returning();

      const [activeVersion] = await tx
        .update(mandateVersions)
        .set({
          status: "active",
          activatedAt: new Date(),
        })
        .where(eq(mandateVersions.id, version.id))
        .returning();

      return {
        mandate: activeMandate ?? mandate,
        version: activeVersion ?? version,
      };
    }

    return { mandate, version };
  });
}

export async function listMandatesForOrg(orgId: string) {
  return db.query.mandates.findMany({
    where: eq(mandates.orgId, orgId),
    with: {
      versions: true,
      cells: true,
    },
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });
}

export async function getMandate(mandateId: string) {
  return db.query.mandates.findFirst({
    where: eq(mandates.id, mandateId),
    with: {
      versions: true,
      cells: true,
    },
  });
}

export async function getActiveMandateForOrg(orgId: string) {
  return db.query.mandates.findFirst({
    where: and(eq(mandates.orgId, orgId), eq(mandates.status, "active")),
    with: {
      versions: true,
      cells: true,
    },
    orderBy: (table, { desc }) => [desc(table.updatedAt)],
  });
}

export async function createStrategyCell(data: typeof strategyCells.$inferInsert) {
  const [cell] = await db.insert(strategyCells).values(data).returning();
  return cell!;
}

export async function createAgentDecision(data: typeof agentDecisions.$inferInsert) {
  const [decision] = await db.insert(agentDecisions).values(data).returning();
  return decision!;
}

export async function updateAgentDecisionStatus(
  decisionId: string,
  status: typeof agentDecisions.$inferSelect["status"],
) {
  const [updated] = await db
    .update(agentDecisions)
    .set({ status, updatedAt: new Date() })
    .where(eq(agentDecisions.id, decisionId))
    .returning();
  return updated ?? null;
}

export async function createSimulationArtifact(data: typeof simulationArtifacts.$inferInsert) {
  const [artifact] = await db.insert(simulationArtifacts).values(data).returning();
  return artifact!;
}

export async function createExecutionRecord(data: typeof executionRecords.$inferInsert) {
  const [record] = await db.insert(executionRecords).values(data).returning();
  return record!;
}

export async function updateMandateStatus(
  mandateId: string,
  status: "active" | "superseded" | "revoked",
  activeVersionId: string,
) {
  const [updated] = await db
    .update(mandates)
    .set({ status, activeVersionId, updatedAt: new Date() })
    .where(eq(mandates.id, mandateId))
    .returning();
  return updated ?? null;
}

export async function updateMandateVersionActivated(
  versionId: string,
  status: "active" | "superseded" | "revoked",
) {
  const [updated] = await db
    .update(mandateVersions)
    .set({ status, activatedAt: new Date() })
    .where(eq(mandateVersions.id, versionId))
    .returning();
  return updated ?? null;
}

export async function getMandateVersion(versionId: string) {
  return db.query.mandateVersions.findFirst({
    where: eq(mandateVersions.id, versionId),
  });
}

export async function getSimulationArtifact(simulationId: string) {
  return db.query.simulationArtifacts.findFirst({
    where: eq(simulationArtifacts.id, simulationId),
  });
}

// ─── Execution record helpers ──────────────────────────────────

export async function getSubmittedExecutionRecords(limit = 20) {
  return db.query.executionRecords.findMany({
    where: eq(executionRecords.status, "submitted"),
    limit,
  });
}

export async function markExecutionReconciled(
  executionRecordId: string,
  txHash: string,
  executedAt: Date
) {
  return db
    .update(executionRecords)
    .set({
      status:          "reconciled",
      transactionHash: txHash,
      executedAt,
      reconciledAt:    new Date(),
    })
    .where(eq(executionRecords.id, executionRecordId))
    .returning();
}

// ─── Idempotency guard ────────────────────────────────────────
// Returns true if a mandate already has in-flight work so the monitor
// does not spam duplicate decisions while the last one is still pending.

export async function mandateHasPendingWork(
  mandateId: string,
  recentWindowMs = 15 * 60 * 1000,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - recentWindowMs);

  // Check recent in-flight agent decisions (proposed/simulating/queued within window)
  const activeDecision = await db.query.agentDecisions.findFirst({
    where: and(
      eq(agentDecisions.mandateId, mandateId),
      inArray(agentDecisions.status, ["proposed", "simulating", "queued"]),
      gte(agentDecisions.updatedAt, cutoff)
    ),
    columns: { id: true },
  });
  if (activeDecision !== undefined) return true;

  // Also check for "ready" decisions with un-executed execution records
  // (prevents duplicate proposals while Safe TX is pending multisig approval)
  const readyDecision = await db.query.agentDecisions.findFirst({
    where: and(
      eq(agentDecisions.mandateId, mandateId),
      inArray(agentDecisions.status, ["ready"]),
    ),
    columns: { id: true },
  });
  if (readyDecision !== undefined) return true;

  return false;
}

// ─── History queries for the mandate detail page ───────────────

export async function listDecisionsForMandate(mandateId: string, limit = 20) {
  return db.query.agentDecisions.findMany({
    where: eq(agentDecisions.mandateId, mandateId),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit,
  });
}

export async function listSimulationsForMandate(mandateId: string, limit = 20) {
  // Get simulations via decisions for this mandate
  const decisions = await db.query.agentDecisions.findMany({
    where: eq(agentDecisions.mandateId, mandateId),
    columns: { id: true },
    limit: 50,
  });
  if (decisions.length === 0) return [];
  const decisionIds = decisions.map(d => d.id);
  return db.query.simulationArtifacts.findMany({
    where: inArray(simulationArtifacts.decisionId, decisionIds),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit,
  });
}

export async function listExecutionRecordsForMandate(mandateId: string, limit = 10) {
  const versions = await db.query.mandateVersions.findMany({
    where: eq(mandateVersions.mandateId, mandateId),
    columns: { id: true },
  });

  if (versions.length === 0) return [];

  return db.query.executionRecords.findMany({
    where: inArray(executionRecords.mandateVersionId, versions.map((version) => version.id)),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit,
  });
}

// ─── Joined activity feed ──────────────────────────────────────
// Returns decisions with their linked simulation and execution
// record in a single query — used by the mandate proof-feed UI.
export async function listMandateActivity(mandateId: string, limit = 30) {
  const decisions = await db.query.agentDecisions.findMany({
    where: eq(agentDecisions.mandateId, mandateId),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit,
    with: {
      simulations: {
        orderBy: (t, { desc }) => [desc(t.createdAt)],
        limit: 1,
        with: {
          executionRecords: {
            orderBy: (t, { desc }) => [desc(t.createdAt)],
            limit: 1,
          },
        },
      },
    },
  });

  return decisions.map(d => {
    const sim  = d.simulations[0]   ?? null;
    const exec = sim?.executionRecords[0] ?? null;
    return {
      id:              d.id,
      timestamp:       d.createdAt,
      trigger:         d.trigger,
      explanation:     d.explanation,
      selectedPlaybook: d.selectedPlaybook,
      playbookParams:  d.playbookParams as Record<string, unknown>,
      decisionStatus:  d.status,
      simulation: sim ? {
        id:              sim.id,
        status:          sim.status,
        gasEstimate:     sim.gasEstimate,
        forkBlockNumber: sim.forkBlockNumber,
        balancesBefore:  sim.balancesBefore  as Record<string, string>,
        balancesAfter:   sim.balancesAfter   as Record<string, string>,
        expectedDeltas:  sim.expectedDeltas  as Record<string, string>,
        calldataHash:    sim.calldataHash,
        failureReason:   sim.failureReason,
      } : null,
      execution: exec ? {
        id:              exec.id,
        status:          exec.status,
        transactionHash: exec.transactionHash,
        safeTxId:        exec.safeTxId,
        failureReason:   exec.failureReason,
        submittedAt:     exec.submittedAt,
        executedAt:      exec.executedAt,
        reconciledAt:    exec.reconciledAt,
      } : null,
    };
  });
}

export type MandateActivityRow = Awaited<ReturnType<typeof listMandateActivity>>[number];
