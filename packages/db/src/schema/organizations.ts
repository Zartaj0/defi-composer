// ============================================================
// Organizations Schema
// Represents DAOs, crypto companies, funds — the B2B tenant unit
// ============================================================

import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { positions } from "./positions";
import { alerts } from "./alerts";
import { intents } from "./intents";
import { feeAccruals } from "./fee-accruals";

export const orgTypeEnum = pgEnum("org_type", [
  "dao",
  "startup",
  "fund",
  "individual",
]);

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),                    // e.g. "org_uniswap"
  name: text("name").notNull(),
  type: orgTypeEnum("type").notNull(),

  // Safe smart account
  safeAddress: text("safe_address"),              // `0x${string}` | null

  // Risk governance parameters (JSON)
  riskParams: jsonb("risk_params").notNull().$type<{
    maxAllocationPerProtocolPct: number;
    maxDrawdownPct: number;
    allowLeverage: boolean;
    allowLiquidationRisk: boolean;
    allowGovernanceTokenRewards: boolean;
    minLiquidityReservePct: number;
    approvedProtocols: string[];
    approvedChains: number[];
    maxSinglePositionPct: number;
    requireMultisigForNewStrategy: boolean;
  }>(),

  // Fee config
  feeConfig: jsonb("fee_config").notNull().$type<{
    managementFeeBps: number;
    performanceFeePct: number;
    benchmarkRateBps: number;
    curatorFeePct: number;
    feeRecipient?: `0x${string}`;
    billingCycle?: "monthly" | "quarterly" | "annual";
  }>(),

  // Notification channels
  notificationChannels: jsonb("notification_channels").notNull().$type<
    Array<{
      type: "telegram" | "discord" | "email" | "webhook";
      destination: string;
      enabled: boolean;
    }>
  >(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),             // soft delete
});

// ─── Treasury Wallets ─────────────────────────────────────
export const walletRoleEnum = pgEnum("wallet_role", [
  "treasury",
  "operations",
  "payroll",
  "reserve",
]);

export const treasuryWallets = pgTable("treasury_wallets", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  address: text("address").notNull(),             // `0x${string}`
  chainId: integer("chain_id").notNull(),
  role: walletRoleEnum("role").notNull().default("treasury"),
  label: text("label"),
  isManaged: boolean("is_managed").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Relations ────────────────────────────────────────────
export const organizationsRelations = relations(organizations, ({ many }) => ({
  wallets: many(treasuryWallets),
  positions: many(positions),
  alerts: many(alerts),
  intents: many(intents),
  feeAccruals: many(feeAccruals),
}));

export const treasuryWalletsRelations = relations(treasuryWallets, ({ one }) => ({
  organization: one(organizations, {
    fields: [treasuryWallets.orgId],
    references: [organizations.id],
  }),
}));
