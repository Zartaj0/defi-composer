// ============================================================
// Alerts Schema
// Fired by monitoring agent. Displayed in dashboard.
// Types: health_factor_warning, health_factor_critical,
//        apy_collapse, idle_capital_detected, protocol_incident
// ============================================================

import {
  pgTable,
  text,
  boolean,
  jsonb,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations } from "./organizations";
import type { AlertType, AlertSeverity } from "@defi-composer/shared";

export const alertSeverityEnum = pgEnum("alert_severity", [
  "info",
  "warning",
  "critical",
]);

export const alerts = pgTable("alerts", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  positionId: text("position_id"),                  // nullable — org-level alerts have no position

  type: text("type").notNull().$type<AlertType>(),
  severity: alertSeverityEnum("severity").notNull(),

  title: text("title").notNull(),
  message: text("message").notNull(),
  actionRequired: boolean("action_required").notNull().default(false),

  // Extra context — health factor value, APY drop %, etc.
  data: jsonb("data").$type<Record<string, unknown>>(),

  // Resolution tracking
  acknowledged: boolean("acknowledged").notNull().default(false),
  acknowledgedBy: text("acknowledged_by"),          // wallet address
  acknowledgedAt: timestamp("acknowledged_at"),
  resolvedAt: timestamp("resolved_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const alertsRelations = relations(alerts, ({ one }) => ({
  organization: one(organizations, {
    fields: [alerts.orgId],
    references: [organizations.id],
  }),
}));
