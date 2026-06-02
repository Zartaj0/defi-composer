// ============================================================
// Positions Schema
// An active deployed strategy — the lifecycle of capital
// status: pending → active → rebalancing → closed
// ============================================================

import {
  pgTable,
  text,
  integer,
  real,
  jsonb,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "./organizations";
import type { StrategyGraph, RiskScore } from "@defi-composer/shared";

export const positionStatusEnum = pgEnum("position_status", [
  "pending",
  "simulating",
  "awaiting_approval",
  "deploying",
  "active",
  "rebalancing",
  "closing",
  "closed",
  "failed",
]);

export const positions = pgTable("positions", {
  id: text("id").primaryKey(),                      // e.g. "pos_abc123"
  orgId: text("org_id").notNull().references(() => organizations.id),
  intentId: text("intent_id"),                      // originating intent

  // Strategy graph snapshot (immutable after deploy)
  graph: jsonb("graph").notNull().$type<StrategyGraph>(),

  // Live state
  status: positionStatusEnum("status").notNull().default("pending"),
  chainId: integer("chain_id").notNull().default(8453),

  // Financial
  entryValueUsd: real("entry_value_usd"),
  currentValueUsd: real("current_value_usd"),
  yieldEarnedUsd: real("yield_earned_usd").default(0),

  // Risk tracking
  healthFactor: real("health_factor"),              // null if no leverage
  riskScore: jsonb("risk_score").$type<RiskScore>(),

  // On-chain refs
  deployTxHash: text("deploy_tx_hash"),             // `0x${string}`
  safeAddress: text("safe_address"),                // `0x${string}`
  sessionKeyAddress: text("session_key_address"),   // `0x${string}` ERC-4337
  mandateVersionId: text("mandate_version_id"),
  simulationArtifactId: text("simulation_artifact_id"),

  // Metadata
  tags: jsonb("tags").$type<string[]>().default([]),
  notes: text("notes"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  closedAt: timestamp("closed_at"),
  closedReason: text("closed_reason"),
});

export const positionsRelations = relations(positions, ({ one }) => ({
  organization: one(organizations, {
    fields: [positions.orgId],
    references: [organizations.id],
  }),
}));
