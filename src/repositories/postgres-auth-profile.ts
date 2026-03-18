/**
 * Postgres implementation of AuthProfileRepository. Encrypts payload at rest.
 */

import type { AuthProfile, AuthProfilePayload, AuthProfileMode } from '../types/index.js';
import type { Owner } from '../types/owner.js';
import type { AuthProfileRepository } from './interfaces.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { getPgPool } from '../lib/postgres.js';

interface Row {
  id: string;
  name: string;
  base_url: string;
  mode: string;
  payload_cipher: string;
  created_at: string;
  updated_at: string;
}

function rowToProfile(row: Row): AuthProfile {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    mode: row.mode as AuthProfileMode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ownerDb(owner: Owner): { ownerType: string; ownerId: string } {
  if (owner.type === 'user') return { ownerType: 'user', ownerId: owner.id };
  return { ownerType: 'anonymous', ownerId: owner.id };
}

export function createAuthProfileRepository(): AuthProfileRepository {
  const pool = getPgPool();

  return {
    async save(profile: AuthProfile, payload: AuthProfilePayload, owner: Owner): Promise<void> {
      const { ownerType, ownerId } = ownerDb(owner);
      const cipher = encrypt(JSON.stringify(payload));
      const now = new Date().toISOString();
      await pool.query(
        `INSERT INTO auth_profiles (
          id, name, base_url, mode, payload_cipher, created_at, updated_at, owner_type, owner_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          base_url = EXCLUDED.base_url,
          mode = EXCLUDED.mode,
          payload_cipher = EXCLUDED.payload_cipher,
          updated_at = EXCLUDED.updated_at,
          owner_type = EXCLUDED.owner_type,
          owner_id = EXCLUDED.owner_id`,
        [
          profile.id,
          profile.name,
          profile.baseUrl,
          profile.mode,
          cipher,
          profile.createdAt || now,
          profile.updatedAt || now,
          ownerType,
          ownerId,
        ]
      );
    },

    async getById(id: string, owner: Owner): Promise<AuthProfile | undefined> {
      const { ownerType, ownerId } = ownerDb(owner);
      const result = await pool.query<Row>(
        `SELECT * FROM auth_profiles
         WHERE id = $1 AND owner_type = $2 AND owner_id = $3`,
        [id, ownerType, ownerId]
      );
      return result.rows[0] ? rowToProfile(result.rows[0]) : undefined;
    },

    async getByIdWithPayload(id: string, owner: Owner): Promise<(AuthProfile & { payload: AuthProfilePayload }) | undefined> {
      const { ownerType, ownerId } = ownerDb(owner);
      const result = await pool.query<Row>(
        `SELECT * FROM auth_profiles
         WHERE id = $1 AND owner_type = $2 AND owner_id = $3`,
        [id, ownerType, ownerId]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const payload = JSON.parse(decrypt(row.payload_cipher)) as AuthProfilePayload;
      return { ...rowToProfile(row), payload };
    },

    async getAll(owner: Owner): Promise<AuthProfile[]> {
      const { ownerType, ownerId } = ownerDb(owner);
      const result = await pool.query<Row>(
        `SELECT * FROM auth_profiles
         WHERE owner_type = $1 AND owner_id = $2
         ORDER BY updated_at DESC`,
        [ownerType, ownerId]
      );
      return result.rows.map(rowToProfile);
    },

    async updateById(
      id: string,
      data: { name?: string; baseUrl?: string; mode?: AuthProfileMode; payload?: AuthProfilePayload },
      owner: Owner
    ): Promise<void> {
      const { ownerType, ownerId } = ownerDb(owner);
      const exists = await pool.query(
        `SELECT 1 FROM auth_profiles WHERE id = $1 AND owner_type = $2 AND owner_id = $3`,
        [id, ownerType, ownerId]
      );
      if (!exists.rows[0]) return;

      const updatedAt = new Date().toISOString();
      if (data.payload !== undefined) {
        const cipher = encrypt(JSON.stringify(data.payload));
        await pool.query(
          `UPDATE auth_profiles
           SET name = COALESCE($1, name),
               base_url = COALESCE($2, base_url),
               mode = COALESCE($3, mode),
               payload_cipher = $4,
               updated_at = $5
           WHERE id = $6 AND owner_type = $7 AND owner_id = $8`,
          [data.name ?? null, data.baseUrl ?? null, data.mode ?? null, cipher, updatedAt, id, ownerType, ownerId]
        );
      } else {
        await pool.query(
          `UPDATE auth_profiles
           SET name = COALESCE($1, name),
               base_url = COALESCE($2, base_url),
               mode = COALESCE($3, mode),
               updated_at = $4
           WHERE id = $5 AND owner_type = $6 AND owner_id = $7`,
          [data.name ?? null, data.baseUrl ?? null, data.mode ?? null, updatedAt, id, ownerType, ownerId]
        );
      }
    },

    async deleteById(id: string, owner: Owner): Promise<boolean> {
      const { ownerType, ownerId } = ownerDb(owner);
      const result = await pool.query(
        `DELETE FROM auth_profiles WHERE id = $1 AND owner_type = $2 AND owner_id = $3`,
        [id, ownerType, ownerId]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async claimAnonymousToUser(sessionId: string, userId: string): Promise<number> {
      const sid = sessionId.trim().toLowerCase();
      const result = await pool.query(
        `UPDATE auth_profiles
         SET owner_type = 'user', owner_id = $1
         WHERE owner_type = 'anonymous' AND owner_id = $2`,
        [userId, sid]
      );
      return result.rowCount ?? 0;
    },
  };
}
