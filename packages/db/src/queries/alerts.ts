// ============================================================
// Alert Queries
// ============================================================

import { eq, and, isNull, desc } from "drizzle-orm";
import { db } from "../client";
import { alerts } from "../schema/index";

export async function listOrgAlerts(
  orgId: string,
  opts: { limit?: number; unacknowledgedOnly?: boolean } = {}
) {
  const { limit = 50, unacknowledgedOnly = false } = opts;

  const conditions = unacknowledgedOnly
    ? and(eq(alerts.orgId, orgId), eq(alerts.acknowledged, false))
    : eq(alerts.orgId, orgId);

  return db.query.alerts.findMany({
    where: conditions,
    orderBy: [desc(alerts.createdAt)],
    limit,
  });
}

export async function createAlert(
  data: typeof alerts.$inferInsert
) {
  const [alert] = await db
    .insert(alerts)
    .values(data)
    .returning();
  return alert!;
}

export async function acknowledgeAlert(
  alertId: string,
  acknowledgedBy: string
) {
  return db
    .update(alerts)
    .set({
      acknowledged: true,
      acknowledgedBy,
      acknowledgedAt: new Date(),
    })
    .where(eq(alerts.id, alertId))
    .returning();
}

export async function resolveAlert(alertId: string) {
  return db
    .update(alerts)
    .set({ resolvedAt: new Date() })
    .where(eq(alerts.id, alertId));
}

export async function countUnresolvedCritical(orgId: string): Promise<number> {
  const result = await db.query.alerts.findMany({
    where: and(
      eq(alerts.orgId, orgId),
      eq(alerts.severity, "critical"),
      isNull(alerts.resolvedAt)
    ),
  });
  return result.length;
}
