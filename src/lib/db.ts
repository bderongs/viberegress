/**
 * SQLite connection and migration runner. Used by repositories for persistence.
 * Migrations are applied on first use; keep SQL portable for future Postgres.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cleanupStaleAnonymousData } from './anonymous-cleanup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database | null = null;

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'viberegress.sqlite');

function getDbPath(): string {
  return process.env.SQLITE_DB_PATH ?? DEFAULT_DB_PATH;
}

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  try {
    const cols = db.prepare("SELECT name FROM pragma_table_info('scenarios')").all() as { name: string }[];
    if (cols.some(c => c.name === 'owner_type')) {
      cleanupStaleAnonymousData(db);
    }
  } catch {
    /* schema may be partial */
  }
  return db;
}

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const migrationsDir = path.join(__dirname, '../../migrations');
  if (fs.existsSync(migrationsDir)) {
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    const applied = database.prepare('SELECT filename FROM _migrations').all() as { filename: string }[];
    const appliedSet = new Set(applied.map(r => r.filename));
    const insert = database.prepare('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)');
    for (const file of files) {
      if (appliedSet.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      database.exec(sql);
      insert.run(file, new Date().toISOString());
      appliedSet.add(file);
    }
  }
  ensureScenarioAuthProfileId(database);
  ensureScenarioStartingWebpage(database);
}

/** Idempotent: add scenarios.auth_profile_id and index if missing (avoids ALTER in migration re-runs). */
function ensureScenarioAuthProfileId(database: Database.Database): void {
  const columns = database.prepare("SELECT name FROM pragma_table_info('scenarios')").all() as { name: string }[];
  if (columns.some(c => c.name === 'auth_profile_id')) return;
  database.exec('ALTER TABLE scenarios ADD COLUMN auth_profile_id TEXT');
  database.exec('CREATE INDEX IF NOT EXISTS idx_scenarios_auth_profile_id ON scenarios(auth_profile_id)');
}

/** Idempotent: add scenarios.starting_webpage if missing. */
function ensureScenarioStartingWebpage(database: Database.Database): void {
  const columns = database.prepare("SELECT name FROM pragma_table_info('scenarios')").all() as { name: string }[];
  if (columns.some(c => c.name === 'starting_webpage')) return;
  database.exec('ALTER TABLE scenarios ADD COLUMN starting_webpage TEXT');
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
