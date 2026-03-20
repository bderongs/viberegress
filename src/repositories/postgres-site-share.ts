/**
 * Postgres persistence for magic-link site sharing.
 */

import { randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import type { SiteShareLinkRecord, SiteShareLinkRepository } from './interfaces.js';
import { getPgPool } from '../lib/postgres.js';

interface Row {
  id: string;
  token: string;
  owner_user_id: string;
  site_url: string;
  created_at: string;
  revoked_at: string | null;
  expires_at: string | null;
  allow_public_read: boolean;
}

function rowToRecord(row: Row): SiteShareLinkRecord {
  return {
    id: row.id,
    token: row.token,
    ownerUserId: row.owner_user_id,
    siteUrl: row.site_url,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    allowPublicRead: row.allow_public_read,
  };
}

export function createSiteShareLinkRepository(): SiteShareLinkRepository {
  const pool = getPgPool();

  return {
    async create(ownerUserId: string, siteUrlNormalized: string): Promise<SiteShareLinkRecord> {
      const id = uuidv4();
      const token = randomBytes(32).toString('base64url');
      const createdAt = new Date().toISOString();
      const siteUrl = siteUrlNormalized.replace(/\/$/, '');
      await pool.query(
        `INSERT INTO site_share_links (id, token, owner_user_id, site_url, created_at, revoked_at, expires_at, allow_public_read)
         VALUES ($1,$2,$3,$4,$5,NULL,NULL,true)`,
        [id, token, ownerUserId, siteUrl, createdAt]
      );
      return {
        id,
        token,
        ownerUserId,
        siteUrl,
        createdAt,
        revokedAt: null,
        expiresAt: null,
        allowPublicRead: true,
      };
    },

    async listByOwnerAndSite(ownerUserId: string, siteUrlNormalized: string): Promise<SiteShareLinkRecord[]> {
      const site = siteUrlNormalized.replace(/\/$/, '');
      const result = await pool.query<Row>(
        `SELECT * FROM site_share_links
         WHERE owner_user_id = $1 AND site_url = $2
         ORDER BY created_at DESC`,
        [ownerUserId, site]
      );
      return result.rows.map(rowToRecord);
    },

    async listRecentByOwner(ownerUserId: string, limit: number): Promise<SiteShareLinkRecord[]> {
      const result = await pool.query<Row>(
        `SELECT * FROM site_share_links
         WHERE owner_user_id = $1 AND revoked_at IS NULL
         ORDER BY created_at DESC
         LIMIT $2`,
        [ownerUserId, Math.min(100, Math.max(1, limit))]
      );
      return result.rows.map(rowToRecord);
    },

    async revoke(ownerUserId: string, linkId: string): Promise<boolean> {
      const now = new Date().toISOString();
      const result = await pool.query(
        `UPDATE site_share_links SET revoked_at = $1
         WHERE id = $2 AND owner_user_id = $3 AND revoked_at IS NULL`,
        [now, linkId, ownerUserId]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async getActiveByToken(token: string): Promise<SiteShareLinkRecord | undefined> {
      const t = token.trim();
      if (!t || t.length < 16) return undefined;
      const result = await pool.query<Row>(
        `SELECT * FROM site_share_links WHERE token = $1 AND revoked_at IS NULL`,
        [t]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      if (!row.allow_public_read) return undefined;
      if (row.expires_at) {
        const exp = new Date(row.expires_at).getTime();
        if (Number.isFinite(exp) && exp <= Date.now()) return undefined;
      }
      return rowToRecord(row);
    },
  };
}
