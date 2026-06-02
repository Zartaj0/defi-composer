// ============================================================
// Intent + Candidate Strategy Queries
// ============================================================

import { eq, and, desc } from "drizzle-orm";
import { db } from "../client";
import { intents, candidateStrategies } from "../schema/index";

export async function createIntent(
  data: typeof intents.$inferInsert
): Promise<typeof intents.$inferSelect> {
  const [intent] = await db
    .insert(intents)
    .values(data)
    .returning();
  return intent!;
}

export async function getIntent(intentId: string) {
  return db.query.intents.findFirst({
    where: eq(intents.id, intentId),
    with: { organization: true },
  });
}

export async function updateIntentStatus(
  intentId: string,
  status: typeof intents.$inferSelect["status"],
  extra?: Partial<typeof intents.$inferInsert>
) {
  return db
    .update(intents)
    .set({ status, updatedAt: new Date(), ...extra })
    .where(eq(intents.id, intentId))
    .returning();
}

export async function listOrgIntents(orgId: string, limit = 20) {
  return db.query.intents.findMany({
    where: eq(intents.orgId, orgId),
    orderBy: [desc(intents.createdAt)],
    limit,
  });
}

// ─── Candidate Strategies ─────────────────────────────────

export async function storeCandidates(
  data: Array<typeof candidateStrategies.$inferInsert>
) {
  return db
    .insert(candidateStrategies)
    .values(data)
    .returning();
}

export async function getCandidatesForIntent(intentId: string) {
  return db.query.candidateStrategies.findMany({
    where: eq(candidateStrategies.intentId, intentId),
    orderBy: (cs, { asc }) => [asc(cs.rank)],
  });
}

export async function getCandidate(candidateId: string) {
  return db.query.candidateStrategies.findFirst({
    where: eq(candidateStrategies.id, candidateId),
  });
}
