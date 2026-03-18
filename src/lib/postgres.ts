/**
 * Shared Postgres pool for Supabase DB access.
 * Uses SUPABASE_DB_URL (recommended) or POSTGRES_URL.
 */

import { Pool } from 'pg';

let pool: Pool | null = null;

function getConnectionString(): string {
  const value = process.env.SUPABASE_DB_URL ?? process.env.POSTGRES_URL;
  if (!value) {
    throw new Error('Missing SUPABASE_DB_URL (or POSTGRES_URL) for Postgres repository mode.');
  }
  return value;
}

export function getPgPool(): Pool {
  if (pool) return pool;
  const connectionString = getConnectionString();
  pool = new Pool({
    connectionString,
    // Supabase Postgres requires SSL in hosted environments.
    ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });
  return pool;
}

export async function closePgPool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
