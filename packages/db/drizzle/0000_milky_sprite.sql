DO $$ BEGIN
 CREATE TYPE "public"."org_type" AS ENUM('dao', 'startup', 'fund', 'individual');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."wallet_role" AS ENUM('treasury', 'operations', 'payroll', 'reserve');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."position_status" AS ENUM('pending', 'simulating', 'awaiting_approval', 'deploying', 'active', 'rebalancing', 'closing', 'closed', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."intent_status" AS ENUM('received', 'planning', 'ready', 'selected', 'executed', 'cancelled', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."alert_severity" AS ENUM('info', 'warning', 'critical');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."agent_decision_status" AS ENUM('proposed', 'simulating', 'blocked', 'ready', 'queued', 'executed', 'reconciled', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."execution_record_status" AS ENUM('queued', 'proposed', 'executed', 'reconciled', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."mandate_status" AS ENUM('draft', 'active', 'superseded', 'revoked');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."simulation_status" AS ENUM('passed', 'failed', 'expired');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."strategy_cell_status" AS ENUM('active', 'paused', 'closed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" "org_type" NOT NULL,
	"safe_address" text,
	"risk_params" jsonb NOT NULL,
	"fee_config" jsonb NOT NULL,
	"notification_channels" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "treasury_wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"address" text NOT NULL,
	"chain_id" integer NOT NULL,
	"role" "wallet_role" DEFAULT 'treasury' NOT NULL,
	"label" text,
	"is_managed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "positions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"intent_id" text,
	"graph" jsonb NOT NULL,
	"status" "position_status" DEFAULT 'pending' NOT NULL,
	"chain_id" integer DEFAULT 8453 NOT NULL,
	"entry_value_usd" real,
	"current_value_usd" real,
	"yield_earned_usd" real DEFAULT 0,
	"health_factor" real,
	"risk_score" jsonb,
	"deploy_tx_hash" text,
	"safe_address" text,
	"session_key_address" text,
	"mandate_version_id" text,
	"simulation_artifact_id" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp,
	"closed_reason" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "candidate_strategies" (
	"id" text PRIMARY KEY NOT NULL,
	"intent_id" text NOT NULL,
	"org_id" text NOT NULL,
	"candidate" jsonb NOT NULL,
	"rank" integer NOT NULL,
	"estimated_apy_bps" integer NOT NULL,
	"risk_level" text NOT NULL,
	"recommended" integer DEFAULT 0 NOT NULL,
	"model_used" text DEFAULT 'deterministic' NOT NULL,
	"generation_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intents" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"raw_text" text NOT NULL,
	"parsed" jsonb,
	"status" "intent_status" DEFAULT 'received' NOT NULL,
	"candidate_count" integer DEFAULT 0,
	"selected_strategy_id" text,
	"position_id" text,
	"submitted_by" text NOT NULL,
	"job_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"position_id" text,
	"type" text NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"action_required" boolean DEFAULT false NOT NULL,
	"data" jsonb,
	"acknowledged" boolean DEFAULT false NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fee_accruals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"avg_aum_usd" real NOT NULL,
	"management_fee_bps" real NOT NULL,
	"management_fee_accrued_usd" real NOT NULL,
	"gross_yield_usd" real NOT NULL,
	"benchmark_yield_usd" real NOT NULL,
	"yield_above_benchmark_usd" real NOT NULL,
	"performance_fee_pct" real NOT NULL,
	"performance_fee_accrued_usd" real NOT NULL,
	"curator_fees_usd" real DEFAULT 0 NOT NULL,
	"platform_fees_usd" real NOT NULL,
	"total_fees_usd" real NOT NULL,
	"net_yield_to_org_usd" real NOT NULL,
	"settled" boolean DEFAULT false NOT NULL,
	"settlement_tx_hash" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"mandate_id" text NOT NULL,
	"mandate_version_id" text NOT NULL,
	"strategy_cell_id" text,
	"trigger" text NOT NULL,
	"observed_state" jsonb NOT NULL,
	"selected_playbook" text NOT NULL,
	"playbook_params" jsonb NOT NULL,
	"rejected_alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"explanation" text NOT NULL,
	"status" "agent_decision_status" DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "execution_records" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"simulation_artifact_id" text NOT NULL,
	"mandate_version_id" text NOT NULL,
	"account_address" text NOT NULL,
	"safe_tx_id" text,
	"transaction_hash" text,
	"status" "execution_record_status" DEFAULT 'queued' NOT NULL,
	"submitted_at" timestamp,
	"executed_at" timestamp,
	"reconciled_at" timestamp,
	"failure_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mandate_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"mandate_id" text NOT NULL,
	"org_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" "mandate_status" DEFAULT 'draft' NOT NULL,
	"reserve_floor_usd" real NOT NULL,
	"spendable_floor_usd" real DEFAULT 0 NOT NULL,
	"risk_budget_pct" real DEFAULT 0 NOT NULL,
	"max_protocol_allocation_pct" real NOT NULL,
	"max_single_action_usd" real,
	"max_slippage_bps" integer DEFAULT 30 NOT NULL,
	"approved_assets" jsonb NOT NULL,
	"approved_protocols" jsonb NOT NULL,
	"approved_actions" jsonb NOT NULL,
	"blocked_actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"emergency_rules" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"activated_at" timestamp,
	"superseded_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mandates" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"status" "mandate_status" DEFAULT 'draft' NOT NULL,
	"active_version_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "simulation_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"decision_id" text,
	"mandate_version_id" text NOT NULL,
	"chain_id" integer DEFAULT 8453 NOT NULL,
	"fork_block_number" integer NOT NULL,
	"valid_until_block" integer NOT NULL,
	"rpc_source" text NOT NULL,
	"calldata_hash" text NOT NULL,
	"input_calldata" jsonb NOT NULL,
	"balances_before" jsonb NOT NULL,
	"balances_after" jsonb NOT NULL,
	"expected_deltas" jsonb NOT NULL,
	"gas_estimate" integer NOT NULL,
	"status" "simulation_status" NOT NULL,
	"failure_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strategy_cells" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"mandate_id" text NOT NULL,
	"mandate_version_id" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"account_address" text,
	"capital_limit_usd" real NOT NULL,
	"current_allocation_usd" real DEFAULT 0 NOT NULL,
	"approved_protocols" jsonb NOT NULL,
	"approved_actions" jsonb NOT NULL,
	"status" "strategy_cell_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "treasury_wallets" ADD CONSTRAINT "treasury_wallets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "positions" ADD CONSTRAINT "positions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "candidate_strategies" ADD CONSTRAINT "candidate_strategies_intent_id_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intents" ADD CONSTRAINT "intents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alerts" ADD CONSTRAINT "alerts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fee_accruals" ADD CONSTRAINT "fee_accruals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_mandate_version_id_mandate_versions_id_fk" FOREIGN KEY ("mandate_version_id") REFERENCES "public"."mandate_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_decisions" ADD CONSTRAINT "agent_decisions_strategy_cell_id_strategy_cells_id_fk" FOREIGN KEY ("strategy_cell_id") REFERENCES "public"."strategy_cells"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_records" ADD CONSTRAINT "execution_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_records" ADD CONSTRAINT "execution_records_simulation_artifact_id_simulation_artifacts_id_fk" FOREIGN KEY ("simulation_artifact_id") REFERENCES "public"."simulation_artifacts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "execution_records" ADD CONSTRAINT "execution_records_mandate_version_id_mandate_versions_id_fk" FOREIGN KEY ("mandate_version_id") REFERENCES "public"."mandate_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mandate_versions" ADD CONSTRAINT "mandate_versions_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mandate_versions" ADD CONSTRAINT "mandate_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mandates" ADD CONSTRAINT "mandates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "simulation_artifacts" ADD CONSTRAINT "simulation_artifacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "simulation_artifacts" ADD CONSTRAINT "simulation_artifacts_decision_id_agent_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."agent_decisions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "simulation_artifacts" ADD CONSTRAINT "simulation_artifacts_mandate_version_id_mandate_versions_id_fk" FOREIGN KEY ("mandate_version_id") REFERENCES "public"."mandate_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "strategy_cells" ADD CONSTRAINT "strategy_cells_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "strategy_cells" ADD CONSTRAINT "strategy_cells_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "strategy_cells" ADD CONSTRAINT "strategy_cells_mandate_version_id_mandate_versions_id_fk" FOREIGN KEY ("mandate_version_id") REFERENCES "public"."mandate_versions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
