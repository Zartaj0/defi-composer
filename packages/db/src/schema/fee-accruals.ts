// ============================================================
// Fee Accruals Schema
// Management fee + performance fee records.
// Computed by fee-engine, stored for audit + settlement.
// ============================================================

import {
  pgTable,
  text,
  real,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "./organizations";

export const feeAccruals = pgTable("fee_accruals", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),

  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),

  // AUM snapshot
  avgAumUsd: real("avg_aum_usd").notNull(),
  managementFeeBps: real("management_fee_bps").notNull(),
  managementFeeAccruedUsd: real("management_fee_accrued_usd").notNull(),

  // Performance
  grossYieldUsd: real("gross_yield_usd").notNull(),
  benchmarkYieldUsd: real("benchmark_yield_usd").notNull(),
  yieldAboveBenchmarkUsd: real("yield_above_benchmark_usd").notNull(),
  performanceFeePct: real("performance_fee_pct").notNull(),
  performanceFeeAccruedUsd: real("performance_fee_accrued_usd").notNull(),

  // Split
  curatorFeesUsd: real("curator_fees_usd").notNull().default(0),
  platformFeesUsd: real("platform_fees_usd").notNull(),
  totalFeesUsd: real("total_fees_usd").notNull(),
  netYieldToOrgUsd: real("net_yield_to_org_usd").notNull(),

  // Settlement
  settled: boolean("settled").notNull().default(false),
  settlementTxHash: text("settlement_tx_hash"),     // `0x${string}`

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const feeAccrualsRelations = relations(feeAccruals, ({ one }) => ({
  organization: one(organizations, {
    fields: [feeAccruals.orgId],
    references: [organizations.id],
  }),
}));
