// ============================================================
// Position Queries
// ============================================================

import { eq, and, inArray } from "drizzle-orm";
import { db } from "../client";
import { positions } from "../schema/index";

export async function getPosition(positionId: string) {
  return db.query.positions.findFirst({
    where: eq(positions.id, positionId),
    with: { organization: true },
  });
}

export async function listOrgPositions(orgId: string, status?: typeof positions.$inferSelect["status"]) {
  const conditions = status
    ? and(eq(positions.orgId, orgId), eq(positions.status, status))
    : eq(positions.orgId, orgId);

  return db.query.positions.findMany({
    where: conditions,
    orderBy: (pos, { desc }) => [desc(pos.createdAt)],
  });
}

export async function listActivePositions(orgId: string) {
  return db.query.positions.findMany({
    where: and(
      eq(positions.orgId, orgId),
      inArray(positions.status, ["active", "rebalancing"])
    ),
  });
}

export async function createPosition(
  data: typeof positions.$inferInsert
): Promise<typeof positions.$inferSelect> {
  const [pos] = await db
    .insert(positions)
    .values(data)
    .returning();
  return pos!;
}

export async function updatePositionStatus(
  positionId: string,
  status: typeof positions.$inferSelect["status"],
  extra?: Partial<typeof positions.$inferInsert>
) {
  return db
    .update(positions)
    .set({ status, updatedAt: new Date(), ...extra })
    .where(eq(positions.id, positionId))
    .returning();
}

export async function updateHealthFactor(
  positionId: string,
  healthFactor: number,
  currentValueUsd?: number
) {
  return db
    .update(positions)
    .set({
      healthFactor,
      ...(currentValueUsd !== undefined ? { currentValueUsd } : {}),
      updatedAt: new Date(),
    })
    .where(eq(positions.id, positionId));
}

export async function closePosition(
  positionId: string,
  reason: string,
  closeTxHash?: string
) {
  return db
    .update(positions)
    .set({
      status: "closed",
      closedAt: new Date(),
      closedReason: reason,
      deployTxHash: closeTxHash ?? null,
      updatedAt: new Date(),
    })
    .where(eq(positions.id, positionId));
}

export async function listPositionsForMandate(mandateId: string) {
  return db.query.positions.findMany({
    where: eq(positions.mandateVersionId, mandateId),
    orderBy: (pos, { desc }) => [desc(pos.createdAt)],
  });
}

/** Look up an existing position by the on-chain deployment tx hash.
 *  Used by the reconciler to enforce idempotency: if a position already
 *  exists for this tx, skip creating a duplicate. */
export async function getPositionByDeployTxHash(deployTxHash: string) {
  return db.query.positions.findFirst({
    where: eq(positions.deployTxHash, deployTxHash),
    columns: { id: true, deployTxHash: true },
  });
}
