// ============================================================
// Mandates Schema
// Versioned capital rules and execution proof records.
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

export const mandateStatusEnum = pgEnum("mandate_status", [
  "draft",
  "active",
  "superseded",
  "revoked",
]);

export const strategyCellStatusEnum = pgEnum("strategy_cell_status", [
  "active",
  "paused",
  "closed",
]);

export const agentDecisionStatusEnum = pgEnum("agent_decision_status", [
  "proposed",
  "submitted",    // proposal sent to Safe TX Service
  "simulating",
  "blocked",
  "ready",
  "queued",
  "executed",
  "reconciled",
  "failed",
]);

export const simulationStatusEnum = pgEnum("simulation_status", [
  "passed",
  "failed",
  "expired",
]);

export const executionStatusEnum = pgEnum("execution_record_status", [
  "queued",
  "proposed",
  "submitted",    // proposal sent to Safe TX Service
  "executed",
  "reconciled",
  "failed",
]);

export const mandates = pgTable("mandates", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: mandateStatusEnum("status").notNull().default("draft"),
  activeVersionId: text("active_version_id"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const mandateVersions = pgTable("mandate_versions", {
  id: text("id").primaryKey(),
  mandateId: text("mandate_id").notNull().references(() => mandates.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  status: mandateStatusEnum("status").notNull().default("draft"),

  reserveFloorUsd: real("reserve_floor_usd").notNull(),
  spendableFloorUsd: real("spendable_floor_usd").notNull().default(0),
  riskBudgetPct: real("risk_budget_pct").notNull().default(0),
  maxProtocolAllocationPct: real("max_protocol_allocation_pct").notNull(),
  maxSingleActionUsd: real("max_single_action_usd"),
  maxSlippageBps: integer("max_slippage_bps").notNull().default(30),

  approvedAssets: jsonb("approved_assets").notNull().$type<string[]>(),
  approvedProtocols: jsonb("approved_protocols").notNull().$type<string[]>(),
  approvedActions: jsonb("approved_actions").notNull().$type<string[]>(),
  blockedActions: jsonb("blocked_actions").notNull().$type<string[]>().default([]),
  emergencyRules: jsonb("emergency_rules").notNull().$type<Record<string, unknown>>(),

  createdBy: text("created_by").notNull(),
  approvedBy: text("approved_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  activatedAt: timestamp("activated_at"),
  supersededAt: timestamp("superseded_at"),
});

export const strategyCells = pgTable("strategy_cells", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  mandateId: text("mandate_id").notNull().references(() => mandates.id, { onDelete: "cascade" }),
  mandateVersionId: text("mandate_version_id").notNull().references(() => mandateVersions.id),
  name: text("name").notNull(),
  purpose: text("purpose").notNull(),
  accountAddress: text("account_address"),
  capitalLimitUsd: real("capital_limit_usd").notNull(),
  currentAllocationUsd: real("current_allocation_usd").notNull().default(0),
  approvedProtocols: jsonb("approved_protocols").notNull().$type<string[]>(),
  approvedActions: jsonb("approved_actions").notNull().$type<string[]>(),
  status: strategyCellStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const agentDecisions = pgTable("agent_decisions", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  mandateId: text("mandate_id").notNull().references(() => mandates.id, { onDelete: "cascade" }),
  mandateVersionId: text("mandate_version_id").notNull().references(() => mandateVersions.id),
  strategyCellId: text("strategy_cell_id").references(() => strategyCells.id),
  trigger: text("trigger").notNull(),
  observedState: jsonb("observed_state").notNull().$type<Record<string, unknown>>(),
  selectedPlaybook: text("selected_playbook").notNull(),
  playbookParams: jsonb("playbook_params").notNull().$type<Record<string, unknown>>(),
  rejectedAlternatives: jsonb("rejected_alternatives").notNull().$type<Array<Record<string, unknown>>>().default([]),
  explanation: text("explanation").notNull(),
  status: agentDecisionStatusEnum("status").notNull().default("proposed"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const simulationArtifacts = pgTable("simulation_artifacts", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  decisionId: text("decision_id").references(() => agentDecisions.id),
  mandateVersionId: text("mandate_version_id").notNull().references(() => mandateVersions.id),
  chainId: integer("chain_id").notNull().default(8453),
  forkBlockNumber: integer("fork_block_number").notNull(),
  validUntilBlock: integer("valid_until_block").notNull(),
  rpcSource: text("rpc_source").notNull(),
  calldataHash: text("calldata_hash").notNull(),
  inputCalldata: jsonb("input_calldata").notNull().$type<Array<Record<string, unknown>>>(),
  balancesBefore: jsonb("balances_before").notNull().$type<Record<string, unknown>>(),
  balancesAfter: jsonb("balances_after").notNull().$type<Record<string, unknown>>(),
  expectedDeltas: jsonb("expected_deltas").notNull().$type<Record<string, unknown>>(),
  gasEstimate: integer("gas_estimate").notNull(),
  status: simulationStatusEnum("status").notNull(),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const executionRecords = pgTable("execution_records", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  simulationArtifactId: text("simulation_artifact_id").notNull().references(() => simulationArtifacts.id),
  mandateVersionId: text("mandate_version_id").notNull().references(() => mandateVersions.id),
  accountAddress: text("account_address").notNull(),
  safeTxId: text("safe_tx_id"),
  transactionHash: text("transaction_hash"),
  status: executionStatusEnum("status").notNull().default("queued"),
  submittedAt: timestamp("submitted_at"),
  executedAt: timestamp("executed_at"),
  reconciledAt: timestamp("reconciled_at"),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const mandatesRelations = relations(mandates, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [mandates.orgId],
    references: [organizations.id],
  }),
  versions: many(mandateVersions),
  cells: many(strategyCells),
}));

export const mandateVersionsRelations = relations(mandateVersions, ({ one, many }) => ({
  mandate: one(mandates, {
    fields: [mandateVersions.mandateId],
    references: [mandates.id],
  }),
  cells: many(strategyCells),
  decisions: many(agentDecisions),
}));

export const strategyCellsRelations = relations(strategyCells, ({ one, many }) => ({
  mandate: one(mandates, {
    fields: [strategyCells.mandateId],
    references: [mandates.id],
  }),
  mandateVersion: one(mandateVersions, {
    fields: [strategyCells.mandateVersionId],
    references: [mandateVersions.id],
  }),
  decisions: many(agentDecisions),
}));

export const agentDecisionsRelations = relations(agentDecisions, ({ one, many }) => ({
  mandate: one(mandates, {
    fields: [agentDecisions.mandateId],
    references: [mandates.id],
  }),
  mandateVersion: one(mandateVersions, {
    fields: [agentDecisions.mandateVersionId],
    references: [mandateVersions.id],
  }),
  strategyCell: one(strategyCells, {
    fields: [agentDecisions.strategyCellId],
    references: [strategyCells.id],
  }),
  simulations: many(simulationArtifacts),
}));

export const simulationArtifactsRelations = relations(simulationArtifacts, ({ one, many }) => ({
  decision: one(agentDecisions, {
    fields: [simulationArtifacts.decisionId],
    references: [agentDecisions.id],
  }),
  mandateVersion: one(mandateVersions, {
    fields: [simulationArtifacts.mandateVersionId],
    references: [mandateVersions.id],
  }),
  executionRecords: many(executionRecords),
}));

export const executionRecordsRelations = relations(executionRecords, ({ one }) => ({
  simulationArtifact: one(simulationArtifacts, {
    fields: [executionRecords.simulationArtifactId],
    references: [simulationArtifacts.id],
  }),
  mandateVersion: one(mandateVersions, {
    fields: [executionRecords.mandateVersionId],
    references: [mandateVersions.id],
  }),
}));
