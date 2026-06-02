// ============================================================
// @defi-composer/db — public surface
// ============================================================

// Client
export { db, checkDbConnection } from "./client";
export type { Database } from "./client";

// Schema (types only for external consumers)
export * from "./schema/index";

// Query helpers
export * from "./queries/index";
