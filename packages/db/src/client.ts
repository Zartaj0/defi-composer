// ============================================================
// DB Client
// Single postgres.js connection + Drizzle ORM instance.
// Import `db` from here everywhere — never create a second client.
// ============================================================

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgres://localhost:5432/defi_composer";

// postgres.js client — handles connection pooling internally
const sql = postgres(DATABASE_URL, {
  max: 10,                    // max pool size
  idle_timeout: 20,           // close idle connections after 20s
  connect_timeout: 10,        // fail fast if DB unreachable
  prepare: false,             // required for PgBouncer compatibility
});

export const db = drizzle(sql, {
  schema,
  logger: process.env["NODE_ENV"] === "development",
});

export type Database = typeof db;

// ─── Connection health check ──────────────────────────────
export async function checkDbConnection(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
