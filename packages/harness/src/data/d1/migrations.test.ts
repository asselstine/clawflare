// D1 Migration Validation Tests
// Ensures that D1 schema is correctly set up

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../../migrations");
const MIGRATION_PATH = join(MIGRATIONS_DIR, "0001_initial_data_layer.sql");

function executableMigrationStatements(path = MIGRATION_PATH): string[] {
  return readFileSync(path, "utf-8")
    .replace(/^--.*$/gm, "")
    .replace(/^PRAGMA\s+foreign_keys\s*=\s*ON;$/gim, "")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter(Boolean);
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

test("migration file exists and is readable", () => {
  const content = readFileSync(MIGRATION_PATH, "utf-8");
  assert.ok(content.length > 0, "Migration file should have content");
  assert.ok(content.includes("PRAGMA foreign_keys"), "Should enable foreign keys");
});

test("migration applies and creates expected tables in D1", async () => {
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
      assert.ok(tables.includes(table), `Should create table: ${table}`);
    }
  } finally {
    await mf.dispose();
  }
});

test("all migrations apply in order", async () => {
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
    assert.equal(counterRow?.name, "session_counters");
  } finally {
    await mf.dispose();
  }
});

test("migration creates expected tables", () => {
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
    assert.ok(tables.includes(table), `Should create table: ${table}`);
  }
});

test("migration creates expected indexes", () => {
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
    "idx_stored_code_updated",
    "idx_stored_code_name",
    "idx_egress_handlers_enabled",
    "idx_egress_handlers_name",
    "idx_egress_handlers_updated",
  ];

  for (const index of expectedIndexes) {
    assert.ok(indexes.includes(index), `Should create index: ${index}`);
  }
});

test("migration does not use manual _d1_migrations table", () => {
  const content = readFileSync(MIGRATION_PATH, "utf-8");
  
  // Should not create manual migrations table (Wrangler handles this)
  assert.ok(
    !content.includes("CREATE TABLE IF NOT EXISTS _d1_migrations"),
    "Should not create manual _d1_migrations table"
  );
  
  assert.ok(
    !content.includes("INSERT INTO _d1_migrations"),
    "Should not insert into manual _d1_migrations table"
  );
});

test("sessions table has correct constraints", () => {
  const content = readFileSync(MIGRATION_PATH, "utf-8");
  
  // Should have status check constraint
  assert.ok(
    content.includes("status IN ('idle', 'processing', 'awaiting_input', 'error', 'closed', 'expired')"),
    "Should have status check constraint"
  );
});

test("foreign key constraints are defined", () => {
  const content = readFileSync(MIGRATION_PATH, "utf-8");
  
  // Check for foreign keys on session_events
  assert.ok(
    content.match(/FOREIGN KEY.*session_id.*REFERENCES sessions.*ON DELETE CASCADE/s),
    "Should have FK on session_events referencing sessions"
  );
});

// Export for potential integration with test runner
export {};
