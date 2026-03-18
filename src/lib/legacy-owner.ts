/**
 * First signed-in user claims pre-auth SQLite rows (legacy-unclaimed).
 */

import type Database from 'better-sqlite3';
import { LEGACY_UNCLAIMED } from '../types/owner.js';

export function tryAssignLegacyOwner(db: Database.Database, userId: string): void {
  const assigned = db.prepare("SELECT 1 FROM app_meta WHERE key = 'legacy_owner_assigned'").get();
  if (assigned) return;

  const sRow = db
    .prepare('SELECT COUNT(*) as c FROM scenarios WHERE owner_id = ?')
    .get(LEGACY_UNCLAIMED) as { c: number };
  const aRow = db
    .prepare('SELECT COUNT(*) as c FROM auth_profiles WHERE owner_id = ?')
    .get(LEGACY_UNCLAIMED) as { c: number };
  if (sRow.c === 0 && aRow.c === 0) {
    db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('legacy_owner_assigned', 'none')").run();
    return;
  }

  db.transaction(() => {
    db.prepare('UPDATE scenarios SET owner_id = ? WHERE owner_id = ?').run(userId, LEGACY_UNCLAIMED);
    db.prepare('UPDATE auth_profiles SET owner_id = ? WHERE owner_id = ?').run(userId, LEGACY_UNCLAIMED);
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('legacy_owner_assigned', ?)").run(userId);
  })();
}
