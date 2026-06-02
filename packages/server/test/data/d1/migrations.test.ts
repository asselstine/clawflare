// D1 Migration Validation Tests
// Ensures that D1 schema is correctly set up

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../../migrations");
const MIGRATION_PATH = join(MIGRATIONS_DIR, "0001_initial_schema.sql");

/**
 * Parse SQL migration file into executable statements.
 * Handles inline comments and multi-line statements.
 */
function executableMigrationStatements(path = MIGRATION_PATH): string[] {
  let content = readFileSync(path, "utf-8");
  
  // Remove PRAGMA statements (D1 handles these separately)
  content = content.replace(/^PRAGMA\s+foreign_keys\s*=\s*ON;$/gim, "");
  
  // Remove all SQL comments (-- style)
  content = content.replace(/--[^\n]*/g, "");
  
  // Split on semicolons to get statements
  const rawStatements = content.split(';');
  
  // Clean up each statement
  return rawStatements
    .map(stmt => stmt.trim())
    .filter(stmt => stmt.length > 0)
    // Normalize whitespace
    .map(stmt => stmt.replace(/\s+/g, ' '));
}

/**
 * Parse CREATE TABLE statements from SQL
 */
function parseTables(sql: string): string[] {
  const tables: string[] = [];
  const regex = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)\s*\(/gi;
  let match;
  while ((match = regex.exec(sql)) !== null) {
    tables.push(match[1]!);
  }
  return tables;
}

/**
 * Parse CREATE INDEX statements from SQL
 */
function parseIndexes(sql: string): string[] {
  const indexes: string[] = [];
  const regex = /CREATE INDEX\s+(?:IF NOT EXISTS\s+)?(\w+)\s+ON/gi;
  let match;
  while ((match = regex.exec(sql)) !== null) {
    indexes.push(match[1]!);
  }
  return indexes;
}

describe("migrations", () => {
  it("migration file exists and is readable", () => {
    const content = readFileSync(MIGRATION_PATH, "utf-8");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("PRAGMA foreign_keys");
  });

  it("migration applies and creates expected tables in D1", async () => {
    const mf = new Miniflare({
      script: "export default { fetch() { return new Response('ok'); } }",
      modules: true,
      d1Databases: ["DB"],
    });

    try {
      const db = await mf.getD1Database("DB");
      for (const statement of executableMigrationStatements()) {
        await db.exec(`${statement};`);
      }
      const result = await db
        .prepare(
          `SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`
        )
        .all<{ name: string }>();
      const tables = result.results.map((row) => row.name);

      for (const table of [
        "sessions",
        "session_counters",
        "session_events",
        "session_input_queue",
        "session_runtime",
        "stored_code",
        "egress_handlers",
      ]) {
        expect(tables).toContain(table);
      }
    } finally {
      await mf.dispose();
    }
  });

  it("all migrations apply in order", async () => {
    const mf = new Miniflare({
      script: "export default { fetch() { return new Response('ok'); } }",
      modules: true,
      d1Databases: ["DB"],
    });

    try {
      const db = await mf.getD1Database("DB");
      const migrationFiles = readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith(".sql"))
        .sort();

      for (const file of migrationFiles) {
        for (const statement of executableMigrationStatements(join(MIGRATIONS_DIR, file))) {
          await db.exec(`${statement};`);
        }
      }

      const counterRow = await db
        .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'session_counters'`)
        .first<{ name: string }>();
      expect(counterRow?.name).toBe("session_counters");
    } finally {
      await mf.dispose();
    }
  });

  it("migration creates expected tables", () => {
    const content = readFileSync(MIGRATION_PATH, "utf-8");
    const tables = parseTables(content);

    const expectedTables = [
      "sessions",
      "session_events",
      "session_counters",
      "session_input_queue",
      "session_runtime",
      "stored_code",
      "egress_handlers",
    ];

    for (const table of expectedTables) {
      expect(tables).toContain(table);
    }
  });

  it("migration creates expected indexes", () => {
    const content = readFileSync(MIGRATION_PATH, "utf-8");
    const indexes = parseIndexes(content);

    const expectedIndexes = [
      "idx_sessions_status_updated",
      "idx_sessions_updated",
      "idx_sessions_workflow",
      "idx_session_events_session_sequence",
      "idx_session_events_type",
      "idx_session_events_timestamp",
      "idx_session_input_queue_session_sequence",
      "idx_session_runtime_active",
      "idx_stored_code_workspace_updated",
      "idx_stored_code_workspace_name",
      "idx_egress_handlers_enabled",
      "idx_egress_handlers_id",
      "idx_egress_handlers_name",
      "idx_egress_handlers_updated",
    ];

    for (const index of expectedIndexes) {
      expect(indexes).toContain(index);
    }
  });

  it("migration does not use manual _d1_migrations table", () => {
    const content = readFileSync(MIGRATION_PATH, "utf-8");
    
    // Should not create manual migrations table (Wrangler handles this)
    expect(
      content.includes("CREATE TABLE IF NOT EXISTS _d1_migrations")
    ).toBe(false);
    
    expect(
      content.includes("INSERT INTO _d1_migrations")
    ).toBe(false);
  });

  it("sessions table has correct constraints", () => {
    const content = readFileSync(MIGRATION_PATH, "utf-8");
    
    // Should have status check constraint
    expect(
      content.includes("status IN ('idle', 'processing', 'awaiting_input', 'error', 'closed', 'expired')")
    ).toBe(true);
  });

  it("foreign key constraints are defined", () => {
    const content = readFileSync(MIGRATION_PATH, "utf-8");
    
    // Check for foreign keys on session_events
    expect(
      content.match(/FOREIGN KEY.*session_id.*REFERENCES sessions.*ON DELETE CASCADE/s)
    ).toBeTruthy();
  });
});
