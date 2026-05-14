import { db } from '../db/database';
import type { DataVisibility, UserDataEntry } from '@ethernal/shared';

// ─── Einzelner Key ────────────────────────────────────────────────────────────

export async function setKey(
  userId: string,
  gameId: string,
  key: string,
  value: unknown,
  visibility: DataVisibility = 'private'
): Promise<void> {
  await db.execute({
    sql: `
      INSERT INTO user_data (user_id, game_id, key, value, visibility, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, game_id, key)
      DO UPDATE SET value = excluded.value, visibility = excluded.visibility, updated_at = excluded.updated_at
    `,
    args: [userId, gameId, key, JSON.stringify(value), visibility, Date.now()],
  });
}

export async function getKey(
  userId: string,
  gameId: string,
  key: string
): Promise<UserDataEntry | null> {
  const result = await db.execute({
    sql: 'SELECT key, value, visibility, updated_at FROM user_data WHERE user_id = ? AND game_id = ? AND key = ?',
    args: [userId, gameId, key],
  });
  if (result.rows.length === 0) return null;
  return rowToEntry(result.rows[0]);
}

export async function deleteKey(
  userId: string,
  gameId: string,
  key: string
): Promise<void> {
  await db.execute({
    sql: 'DELETE FROM user_data WHERE user_id = ? AND game_id = ? AND key = ?',
    args: [userId, gameId, key],
  });
}

// ─── Eigene Daten (alle Keys) ─────────────────────────────────────────────────

export async function getAllOwn(
  userId: string,
  gameId: string
): Promise<UserDataEntry[]> {
  const result = await db.execute({
    sql: 'SELECT key, value, visibility, updated_at FROM user_data WHERE user_id = ? AND game_id = ? ORDER BY key',
    args: [userId, gameId],
  });
  return result.rows.map(rowToEntry);
}

// ─── Bulk-Set ─────────────────────────────────────────────────────────────────

export async function bulkSet(
  userId: string,
  gameId: string,
  entries: Array<{ key: string; value: unknown; visibility?: DataVisibility }>
): Promise<void> {
  if (entries.length === 0) return;
  const now = Date.now();
  await db.batch(
    entries.map((e) => ({
      sql: `
        INSERT INTO user_data (user_id, game_id, key, value, visibility, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, game_id, key)
        DO UPDATE SET value = excluded.value, visibility = excluded.visibility, updated_at = excluded.updated_at
      `,
      args: [userId, gameId, e.key, JSON.stringify(e.value), e.visibility ?? 'private', now],
    })),
    'write'
  );
}

// ─── Fremde Daten (sichtbare Keys) ────────────────────────────────────────────

/**
 * Gibt die sichtbaren Keys eines anderen Spielers zurück.
 * - inSameLobby=true  → public + lobby
 * - inSameLobby=false → nur public
 */
export async function getVisibleData(
  targetId: string,
  gameId: string,
  inSameLobby: boolean
): Promise<UserDataEntry[]> {
  const visibilities = inSameLobby ? ['public', 'lobby'] : ['public'];
  const placeholders = visibilities.map(() => '?').join(', ');
  const result = await db.execute({
    sql: `SELECT key, value, visibility, updated_at FROM user_data
          WHERE user_id = ? AND game_id = ? AND visibility IN (${placeholders})
          ORDER BY key`,
    args: [targetId, gameId, ...visibilities],
  });
  return result.rows.map(rowToEntry);
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  userId: string;
  username: string;
  value: unknown;
  updatedAt: number;
}

/**
 * Top-N Spieler nach einem numerischen Key (nur public-Daten).
 * Sortierung via CAST(value AS REAL) – nicht-numerische Werte landen am Ende.
 */
export async function getLeaderboard(
  gameId: string,
  key: string,
  order: 'asc' | 'desc' = 'desc',
  limit: number = 10
): Promise<LeaderboardEntry[]> {
  const orderSql = order === 'desc' ? 'DESC' : 'ASC';
  const result = await db.execute({
    sql: `
      SELECT d.user_id, u.username, d.value, d.updated_at
      FROM user_data d
      JOIN users u ON u.id = d.user_id
      WHERE d.game_id = ? AND d.key = ? AND d.visibility = 'public'
      ORDER BY CAST(d.value AS REAL) ${orderSql}
      LIMIT ?
    `,
    args: [gameId, key, limit],
  });
  return result.rows.map((row) => ({
    userId: row.user_id as string,
    username: row.username as string,
    value: JSON.parse(row.value as string),
    updatedAt: row.updated_at as number,
  }));
}

// ─── IPC-Kompatibilität ───────────────────────────────────────────────────────

/** Alle eigenen Keys als flaches Record — für IPC USER_DATA_RESPONSE an Subprocess */
export async function getAllOwnAsRecord(
  userId: string,
  gameId: string
): Promise<Record<string, unknown>> {
  const entries = await getAllOwn(userId, gameId);
  return Object.fromEntries(entries.map((e) => [e.key, e.value]));
}

// ─── Hilfsfunktion ────────────────────────────────────────────────────────────

function rowToEntry(row: { [key: string]: unknown }): UserDataEntry {
  return {
    key: row['key'] as string,
    value: JSON.parse(row['value'] as string),
    visibility: row['visibility'] as DataVisibility,
    updatedAt: row['updated_at'] as number,
  };
}
