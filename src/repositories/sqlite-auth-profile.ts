/**
 * SQLite implementation of AuthProfileRepository. Encrypts payload at rest.
 */

import type { AuthProfile, AuthProfilePayload, AuthProfileMode } from '../types/index.js';
import type { Owner } from '../types/owner.js';
import type { AuthProfileRepository } from './interfaces.js';
import { getDb } from '../lib/db.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { tryAssignLegacyOwner } from '../lib/legacy-owner.js';

interface Row {
  id: string;
  name: string;
  base_url: string;
  mode: string;
  payload_cipher: string;
  created_at: string;
  updated_at: string;
  owner_type?: string;
  owner_id?: string;
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
  const db = getDb();

  return {
    save(profile: AuthProfile, payload: AuthProfilePayload, owner: Owner): void {
      const { ownerType, ownerId } = ownerDb(owner);
      const cipher = encrypt(JSON.stringify(payload));
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO auth_profiles (
          id, name, base_url, mode, payload_cipher, created_at, updated_at, owner_type, owner_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      stmt.run(
        profile.id,
        profile.name,
        profile.baseUrl,
        profile.mode,
        cipher,
        profile.createdAt || now,
        profile.updatedAt || now,
        ownerType,
        ownerId
      );
    },

    getById(id: string, owner: Owner): AuthProfile | undefined {
      const { ownerType, ownerId } = ownerDb(owner);
      const row = db
        .prepare('SELECT * FROM auth_profiles WHERE id = ? AND owner_type = ? AND owner_id = ?')
        .get(id, ownerType, ownerId) as Row | undefined;
      return row ? rowToProfile(row) : undefined;
    },

    getByIdWithPayload(id: string, owner: Owner): (AuthProfile & { payload: AuthProfilePayload }) | undefined {
      const { ownerType, ownerId } = ownerDb(owner);
      const row = db
        .prepare('SELECT * FROM auth_profiles WHERE id = ? AND owner_type = ? AND owner_id = ?')
        .get(id, ownerType, ownerId) as Row | undefined;
      if (!row) return undefined;
      const payload = JSON.parse(decrypt(row.payload_cipher)) as AuthProfilePayload;
      return { ...rowToProfile(row), payload };
    },

    getAll(owner: Owner): AuthProfile[] {
      if (owner.type === 'user') {
        tryAssignLegacyOwner(db, owner.id);
      }
      const { ownerType, ownerId } = ownerDb(owner);
      const rows = db
        .prepare('SELECT * FROM auth_profiles WHERE owner_type = ? AND owner_id = ? ORDER BY updated_at DESC')
        .all(ownerType, ownerId) as Row[];
      return rows.map(rowToProfile);
    },

    updateById(
      id: string,
      data: { name?: string; baseUrl?: string; mode?: AuthProfileMode; payload?: AuthProfilePayload },
      owner: Owner
    ): void {
      const { ownerType, ownerId } = ownerDb(owner);
      const exists = db
        .prepare('SELECT 1 FROM auth_profiles WHERE id = ? AND owner_type = ? AND owner_id = ?')
        .get(id, ownerType, ownerId);
      if (!exists) return;
      const updatedAt = new Date().toISOString();
      if (data.payload !== undefined) {
        const cipher = encrypt(JSON.stringify(data.payload));
        db.prepare(
          'UPDATE auth_profiles SET name = COALESCE(?, name), base_url = COALESCE(?, base_url), mode = COALESCE(?, mode), payload_cipher = ?, updated_at = ? WHERE id = ? AND owner_type = ? AND owner_id = ?'
        ).run(
          data.name ?? null,
          data.baseUrl ?? null,
          data.mode ?? null,
          cipher,
          updatedAt,
          id,
          ownerType,
          ownerId
        );
      } else {
        db.prepare(
          'UPDATE auth_profiles SET name = COALESCE(?, name), base_url = COALESCE(?, base_url), mode = COALESCE(?, mode), updated_at = ? WHERE id = ? AND owner_type = ? AND owner_id = ?'
        ).run(data.name ?? null, data.baseUrl ?? null, data.mode ?? null, updatedAt, id, ownerType, ownerId);
      }
    },

    deleteById(id: string, owner: Owner): boolean {
      const { ownerType, ownerId } = ownerDb(owner);
      const result = db
        .prepare('DELETE FROM auth_profiles WHERE id = ? AND owner_type = ? AND owner_id = ?')
        .run(id, ownerType, ownerId);
      return result.changes > 0;
    },

    claimAnonymousToUser(sessionId: string, userId: string): number {
      const sid = sessionId.trim().toLowerCase();
      const r = db
        .prepare(
          `UPDATE auth_profiles SET owner_type = 'user', owner_id = ? WHERE owner_type = 'anonymous' AND owner_id = ?`
        )
        .run(userId, sid);
      return r.changes;
    },
  };
}
