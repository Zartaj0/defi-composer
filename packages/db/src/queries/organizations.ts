// ============================================================
// Organization Queries
// Typed query helpers — use these instead of raw drizzle in routes
// ============================================================

import { eq, isNull, and } from "drizzle-orm";
import { db } from "../client";
import { organizations, treasuryWallets } from "../schema/index";

// ─── Read ─────────────────────────────────────────────────

export async function getOrg(orgId: string) {
  return db.query.organizations.findFirst({
    where: and(eq(organizations.id, orgId), isNull(organizations.deletedAt)),
    with: { wallets: true },
  });
}

export async function listOrgs() {
  return db.query.organizations.findMany({
    where: isNull(organizations.deletedAt),
    with: { wallets: true },
    orderBy: (orgs, { asc }) => [asc(orgs.createdAt)],
  });
}

// ─── Write ────────────────────────────────────────────────

export async function createOrg(
  data: typeof organizations.$inferInsert
): Promise<typeof organizations.$inferSelect> {
  const [org] = await db
    .insert(organizations)
    .values(data)
    .returning();
  return org!;
}

export async function updateOrgRiskParams(
  orgId: string,
  riskParams: typeof organizations.$inferSelect["riskParams"]
) {
  return db
    .update(organizations)
    .set({ riskParams, updatedAt: new Date() })
    .where(eq(organizations.id, orgId))
    .returning();
}

export async function addTreasuryWallet(
  data: typeof treasuryWallets.$inferInsert
) {
  const [wallet] = await db
    .insert(treasuryWallets)
    .values(data)
    .returning();
  return wallet!;
}

export async function softDeleteOrg(orgId: string) {
  return db
    .update(organizations)
    .set({ deletedAt: new Date() })
    .where(eq(organizations.id, orgId));
}
