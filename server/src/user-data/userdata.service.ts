import { db } from '../db/database';
import type { DataVisibility, DataWriteScope, UserDataEntry } from '@ethernal/shared';
import { HubError } from '../errors';
import { getGame } from '../games/game.registry';

// ─── Limits ───────────────────────────────────────────────────────────────────

export const DATA_LIMITS = {
  maxValueBytes: 16 * 1024,
  maxKeysPerGame: 200,
  maxTotalBytesPerGame: 512 * 1024,
};

export type DataActor = 'client' | 'server';

export interface DataWrite {
  key: string;
  value?: unknown;
  /** Fehlt sie, bleibt die bestehende Sichtbarkeit erhalten (neu angelegt: 'private'). */
  visibility?: DataVisibility;
  /** Nur für actor='server': Schreibschutz für den Client setzen/aufheben. */
  writeScope?: DataWriteScope;
}

function matchesServerKey(gameId: string, key: string): boolean {
  const patterns = getGame(gameId)?.serverKeys ?? [];
  return patterns.some((p) => new RegExp(`^(?:${p})$`).test(key));
}

/**
 * Schreibt einen oder mehrere Keys in einer Transaktion (alles oder nichts).
 * - actor='client': schreibgeschützte Keys (writeScope='server' oder game.serverKeys) → DATA_READ_ONLY
 * - Limits für Wertgröße, Key-Anzahl und Gesamtgröße pro User/Spiel
 * - version wird pro Schreibvorgang erhöht
 */
export async function writeEntries(
  userId: string,
  gameId: string,
  entries: DataWrite[],
  actor: DataActor = 'client'
): Promise<void> {
  if (!getGame(gameId)) throw new HubError('UNKNOWN_GAME');
  if (entries.length === 0) return;

  const serialized = entries.map((e) => {
    const json = JSON.stringify(e.value ?? null);
    if (Buffer.byteLength(json) > DATA_LIMITS.maxValueBytes) throw new HubError('DATA_VALUE_TOO_LARGE');
    return { ...e, json };
  });

  const tx = await db.transaction('write');
  try {
    const existing = await tx.execute({
      sql: 'SELECT key, length(value) AS size, visibility, write_scope FROM user_data WHERE user_id = ? AND game_id = ?',
      args: [userId, gameId],
    });
    const byKey = new Map<string, { size: number; visibility: string; write_scope: string }>(
      existing.rows.map((r) => [
        r.key as string,
        { size: Number(r.size), visibility: r.visibility as string, write_scope: r.write_scope as string },
      ])
    );
    let totalBytes = [...byKey.values()].reduce((sum, r) => sum + r.size, 0);
    let keyCount = byKey.size;

    const now = Date.now();
    for (const e of serialized) {
      const row = byKey.get(e.key);
      if (actor === 'client' && (row?.write_scope === 'server' || matchesServerKey(gameId, e.key))) {
        throw new HubError('DATA_READ_ONLY');
      }
      const scope: DataWriteScope =
        actor === 'server'
          ? e.writeScope ?? (row?.write_scope as DataWriteScope | undefined) ?? (matchesServerKey(gameId, e.key) ? 'server' : 'client')
          : 'client';
      const visibility = e.visibility ?? (row?.visibility as DataVisibility | undefined) ?? 'private';

      if (!row) keyCount += 1;
      totalBytes += Buffer.byteLength(e.json) - (row?.size ?? 0);
      if (keyCount > DATA_LIMITS.maxKeysPerGame || totalBytes > DATA_LIMITS.maxTotalBytesPerGame) {
        throw new HubError('DATA_QUOTA_EXCEEDED');
      }
      byKey.set(e.key, { size: Buffer.byteLength(e.json), visibility, write_scope: scope });

      await tx.execute({
        sql: `
          INSERT INTO user_data (user_id, game_id, key, value, visibility, updated_at, write_scope, version)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(user_id, game_id, key)
          DO UPDATE SET value = excluded.value, visibility = excluded.visibility,
                        updated_at = excluded.updated_at, write_scope = excluded.write_scope,
                        version = user_data.version + 1
        `,
        args: [userId, gameId, e.key, e.json, visibility, now, scope],
      });
    }
    await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => undefined);
    throw err;
  } finally {
    tx.close();
  }
}

export async function setKey(
  userId: string,
  gameId: string,
  key: string,
  value: unknown,
  visibility?: DataVisibility,
  actor: DataActor = 'client'
): Promise<void> {
  await writeEntries(userId, gameId, [{ key, value, visibility }], actor);
}

export async function getKey(
  userId: string,
  gameId: string,
  key: string
): Promise<UserDataEntry | null> {
  const result = await db.execute({
    sql: 'SELECT key, value, visibility, updated_at, write_scope, version FROM user_data WHERE user_id = ? AND game_id = ? AND key = ?',
    args: [userId, gameId, key],
  });
  if (result.rows.length === 0) return null;
  return rowToEntry(result.rows[0]);
}

export async function deleteKey(
  userId: string,
  gameId: string,
  key: string,
  actor: DataActor = 'client'
): Promise<void> {
  if (!getGame(gameId)) throw new HubError('UNKNOWN_GAME');
  if (actor === 'client') {
    const existing = await getKey(userId, gameId, key);
    if (existing?.writeScope === 'server' || matchesServerKey(gameId, key)) throw new HubError('DATA_READ_ONLY');
  }
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
    sql: 'SELECT key, value, visibility, updated_at, write_scope, version FROM user_data WHERE user_id = ? AND game_id = ? ORDER BY key',
    args: [userId, gameId],
  });
  return result.rows.map(rowToEntry);
}

// ─── Bulk-Set ─────────────────────────────────────────────────────────────────

export async function bulkSet(
  userId: string,
  gameId: string,
  entries: DataWrite[],
  actor: DataActor = 'client'
): Promise<void> {
  await writeEntries(userId, gameId, entries, actor);
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
    sql: `SELECT key, value, visibility, updated_at, write_scope, version FROM user_data
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
    writeScope: (row['write_scope'] as DataWriteScope) ?? 'client',
    version: Number(row['version'] ?? 1),
  };
}
