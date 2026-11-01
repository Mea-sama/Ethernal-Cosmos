import { db } from '../db/database';
import type { DataVisibility, DataWriteScope, UserDataEntry } from '@ethernal/shared';
import { HubError } from '../errors';
import { getGame } from '../games/game.registry';
import { areFriends, friendIds } from '../social/friends.service';
import { lobbyManager } from '../lobby/lobby.manager';

// ─── Limits ───────────────────────────────────────────────────────────────────

export const DATA_LIMITS = {
  maxValueBytes: 16 * 1024,
  maxKeysPerGame: 200,
  maxTotalBytesPerGame: 512 * 1024,
};

export type DataActor = 'client' | 'server';

/** Zeichnet bei serverseitigen Schreibvorgängen auf, wer geschrieben hat (`written_by`). */
export interface WriteContext {
  writtenBy?: string;
}

export interface DataWrite {
  key: string;
  value?: unknown;
  /** Fehlt sie, bleibt die bestehende Sichtbarkeit erhalten (neu angelegt: 'private'). */
  visibility?: DataVisibility;
  /** Nur für actor='server': Schreibschutz für den Client setzen/aufheben. */
  writeScope?: DataWriteScope;
}

/** Bestenlisten gibt es nur für Spiele mit Game-Server-Unterstützung (Anti-Fälschung). */
export function gameHasLeaderboards(gameId: string): boolean {
  return (getGame(gameId)?.serverSupport ?? 'none') !== 'none';
}

function matchesServerKey(gameId: string, key: string): boolean {
  const patterns = getGame(gameId)?.serverKeys ?? [];
  return patterns.some((p) => new RegExp(`^(?:${p})$`).test(key));
}

/** Eine Operation einer atomaren Transaktion (`transact`) */
export type DataOp =
  | ({ op: 'set' } & DataWrite)
  | { op: 'increment'; key: string; by: number; visibility?: DataVisibility; writeScope?: DataWriteScope }
  | { op: 'setIf'; key: string; value?: unknown; expectedVersion: number; visibility?: DataVisibility; writeScope?: DataWriteScope }
  | { op: 'delete'; key: string };

/** Ergebnis einer Operation: neuer Wert + neue Version (bei `delete` ohne Wert, version 0) */
export interface DataOpResult {
  key: string;
  value?: unknown;
  version: number;
}

// Alle Schreibvorgänge laufen nacheinander (ein Hub-Prozess): keine SQLITE_BUSY-Konflikte, Zähler sind race-frei.
let writeChain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

interface RowState {
  size: number;
  visibility: string;
  write_scope: string;
  version: number;
  /** nur gefüllt, wenn in dieser Transaktion gelesen oder geschrieben */
  json?: string;
}

/**
 * Führt Operationen in einer Transaktion aus (alles oder nichts), Ergebnis je Operation in Reihenfolge.
 * - actor='client': schreibgeschützte Keys (writeScope='server' oder game.serverKeys) → DATA_READ_ONLY
 * - Sichtbarkeit 'public' (Bestenlisten-Key) darf nur ein Server setzen und nur bei serverSupport != none → sonst NOT_ALLOWED
 * - increment: Zahl, |by| und Ergebnis im Safe-Integer-Bereich, Typkonflikt → INVALID_INPUT; fehlender Key zählt als 0
 * - setIf: expectedVersion (0 = Key darf nicht existieren), sonst VERSION_CONFLICT mit aktuellem Wert/Version
 * - Limits für Wertgröße, Key-Anzahl und Gesamtgröße pro User/Spiel
 * - version wird pro Schreibvorgang erhöht
 */
export function applyOps(
  userId: string,
  gameId: string,
  ops: DataOp[],
  actor: DataActor = 'client',
  ctx: WriteContext = {}
): Promise<DataOpResult[]> {
  if (!getGame(gameId)) return Promise.reject(new HubError('UNKNOWN_GAME'));
  if (ops.length === 0) return Promise.resolve([]);
  if (ops.length > 100) return Promise.reject(new HubError('INVALID_INPUT'));
  for (const o of ops) {
    if (o.op !== 'delete' && o.visibility === 'public' && (actor === 'client' || !gameHasLeaderboards(gameId))) {
      return Promise.reject(new HubError('NOT_ALLOWED'));
    }
    if (o.op === 'increment' && !(typeof o.by === 'number' && Number.isFinite(o.by) && Math.abs(o.by) <= Number.MAX_SAFE_INTEGER)) {
      return Promise.reject(new HubError('INVALID_INPUT', 'by muss eine endliche Zahl im Safe-Integer-Bereich sein'));
    }
    if (o.op === 'setIf' && !(Number.isInteger(o.expectedVersion) && o.expectedVersion >= 0)) {
      return Promise.reject(new HubError('INVALID_INPUT', 'expectedVersion muss eine ganze Zahl >= 0 sein'));
    }
  }
  return exclusive(() => runOps(userId, gameId, ops, actor, ctx));
}

async function runOps(userId: string, gameId: string, ops: DataOp[], actor: DataActor, ctx: WriteContext): Promise<DataOpResult[]> {
  const tx = await db.transaction('write');
  try {
    const existing = await tx.execute({
      sql: 'SELECT key, length(value) AS size, visibility, write_scope, version FROM user_data WHERE user_id = ? AND game_id = ?',
      args: [userId, gameId],
    });
    const byKey = new Map<string, RowState>(
      existing.rows.map((r) => [
        r.key as string,
        { size: Number(r.size), visibility: r.visibility as string, write_scope: r.write_scope as string, version: Number(r.version) },
      ])
    );
    let totalBytes = [...byKey.values()].reduce((sum, r) => sum + r.size, 0);
    let keyCount = byKey.size;
    const now = Date.now();
    const results: DataOpResult[] = [];

    const currentJson = async (key: string, row: RowState): Promise<string> => {
      if (row.json === undefined) {
        const r = await tx.execute({ sql: 'SELECT value FROM user_data WHERE user_id = ? AND game_id = ? AND key = ?', args: [userId, gameId, key] });
        row.json = r.rows[0].value as string;
      }
      return row.json;
    };
    const readOnlyForClient = (key: string, row?: RowState): boolean =>
      actor === 'client' && (row?.write_scope === 'server' || matchesServerKey(gameId, key));

    for (const o of ops) {
      const row = byKey.get(o.key);

      if (o.op === 'delete') {
        if (readOnlyForClient(o.key, row)) throw new HubError('DATA_READ_ONLY');
        if (row) {
          await tx.execute({ sql: 'DELETE FROM user_data WHERE user_id = ? AND game_id = ? AND key = ?', args: [userId, gameId, o.key] });
          byKey.delete(o.key);
          totalBytes -= row.size;
          keyCount -= 1;
        }
        results.push({ key: o.key, version: 0 });
        continue;
      }

      if (readOnlyForClient(o.key, row)) throw new HubError('DATA_READ_ONLY');

      let value: unknown;
      if (o.op === 'set') {
        value = o.value;
      } else if (o.op === 'setIf') {
        if ((row?.version ?? 0) !== o.expectedVersion) {
          const current = row ? { value: JSON.parse(await currentJson(o.key, row)), version: row.version } : null;
          throw new HubError('VERSION_CONFLICT', undefined, undefined, { current });
        }
        value = o.value;
      } else {
        const base = row ? JSON.parse(await currentJson(o.key, row)) : 0;
        if (typeof base !== 'number' || !Number.isFinite(base)) throw new HubError('INVALID_INPUT', 'Wert ist keine Zahl');
        const next = base + o.by;
        if (!Number.isFinite(next) || Math.abs(next) > Number.MAX_SAFE_INTEGER) throw new HubError('INVALID_INPUT', 'Ergebnis außerhalb des Safe-Integer-Bereichs');
        value = next;
      }

      const json = JSON.stringify(value ?? null);
      const size = Buffer.byteLength(json);
      if (size > DATA_LIMITS.maxValueBytes) throw new HubError('DATA_VALUE_TOO_LARGE');

      const visibility = o.visibility ?? (row?.visibility as DataVisibility | undefined) ?? 'private';
      const writeScope = 'writeScope' in o ? o.writeScope : undefined;
      const scope: DataWriteScope =
        actor === 'server' && visibility === 'public'
          ? 'server'
          : actor === 'server'
          ? writeScope ?? (row?.write_scope as DataWriteScope | undefined) ?? (matchesServerKey(gameId, o.key) ? 'server' : 'client')
          : 'client';
      const writtenBy = actor === 'server' ? ctx.writtenBy ?? 'subprocess' : null;

      if (!row) keyCount += 1;
      totalBytes += size - (row?.size ?? 0);
      if (keyCount > DATA_LIMITS.maxKeysPerGame || totalBytes > DATA_LIMITS.maxTotalBytesPerGame) {
        throw new HubError('DATA_QUOTA_EXCEEDED');
      }
      const version = (row?.version ?? 0) + 1;
      byKey.set(o.key, { size, visibility, write_scope: scope, version, json });

      await tx.execute({
        sql: `
          INSERT INTO user_data (user_id, game_id, key, value, visibility, updated_at, write_scope, version, written_by, num_value)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(user_id, game_id, key)
          DO UPDATE SET value = excluded.value, visibility = excluded.visibility,
                        updated_at = excluded.updated_at, write_scope = excluded.write_scope,
                        version = user_data.version + 1, written_by = excluded.written_by,
                        num_value = excluded.num_value
        `,
        args: [userId, gameId, o.key, json, visibility, now, scope, writtenBy, typeof value === 'number' && Number.isFinite(value) ? value : null],
      });
      results.push({ key: o.key, value, version });
    }
    await tx.commit();
    return results;
  } catch (err) {
    await tx.rollback().catch(() => undefined);
    throw err;
  } finally {
    tx.close();
  }
}

/** Mehrere Keys atomar schreiben (alles oder nichts). */
export async function writeEntries(
  userId: string,
  gameId: string,
  entries: DataWrite[],
  actor: DataActor = 'client',
  ctx: WriteContext = {}
): Promise<void> {
  await applyOps(userId, gameId, entries.map((e) => ({ op: 'set' as const, ...e })), actor, ctx);
}

export async function setKey(
  userId: string,
  gameId: string,
  key: string,
  value: unknown,
  visibility?: DataVisibility,
  actor: DataActor = 'client',
  ctx: WriteContext = {}
): Promise<void> {
  await writeEntries(userId, gameId, [{ key, value, visibility }], actor, ctx);
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
  await applyOps(userId, gameId, [{ op: 'delete', key }], actor);
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
  actor: DataActor = 'client',
  ctx: WriteContext = {}
): Promise<void> {
  await writeEntries(userId, gameId, entries, actor, ctx);
}

// ─── Fremde Daten (sichtbare Keys) ────────────────────────────────────────────

/**
 * Daten eines Spielers für einen Betrachter (#42):
 *  - selbst: private + lobby + friends
 *  - Freund: friends, dazu lobby wenn beide in derselben Lobby dieses Spiels sind
 *  - Lobby-Mitglied (kein Freund): lobby
 *  - sonst (auch unbekannte User): NOT_ALLOWED – nicht von „existiert nicht" unterscheidbar
 * `public` (Bestenlistenschlüssel) ist nie über diesen Weg lesbar.
 */
export async function getPlayerData(requesterId: string, targetId: string, gameId: string): Promise<UserDataEntry[]> {
  const visibilities: DataVisibility[] = [];
  if (requesterId === targetId) {
    visibilities.push('private', 'lobby', 'friends');
  } else {
    const a = lobbyManager.getLobbyByUserId(requesterId);
    const b = lobbyManager.getLobbyByUserId(targetId);
    const sameLobby = !!(a && b && a.id === b.id && a.gameId === gameId);
    const friends = await areFriends(requesterId, targetId);
    if (friends) visibilities.push('friends');
    if (sameLobby) visibilities.push('lobby');
    if (visibilities.length === 0) throw new HubError('NOT_ALLOWED');
  }
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
  rank: number;
  userId: string;
  username: string;
  value: unknown;
  updatedAt: number;
}

export interface LeaderboardQuery {
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  /** Eigener Rang (auch wenn man selbst ausgeblendet ist) */
  me?: boolean;
  /** Fenster um den eigenen Rang statt Top-N */
  around?: boolean;
  range?: number;
  /** `friends`: nur Freunde + man selbst */
  scope?: 'all' | 'friends';
  userId?: string;
}

export interface LeaderboardResult {
  entries: LeaderboardEntry[];
  me?: LeaderboardEntry | null;
  total: number;
}

/** Ganze Zahlen sind exakt; Ordnung: Wert, früherer Erfolg (updated_at), user_id */
const ORDER = (dir: string): string => `d.num_value ${dir}, d.updated_at ASC, d.user_id ASC`;

/** Spiele ohne Server-Support haben keine Bestenlisten (NOT_FOUND). */
export async function getLeaderboard(gameId: string, key: string, q: LeaderboardQuery = {}): Promise<LeaderboardResult> {
  if (!gameHasLeaderboards(gameId)) throw new HubError('NOT_FOUND');
  const dir = (q.order ?? 'desc') === 'desc' ? 'DESC' : 'ASC';
  const limit = q.limit ?? 10;
  let scopeSql = '';
  const scopeArgs: string[] = [];
  if (q.scope === 'friends') {
    const ids = [...(await friendIds(q.userId!)), q.userId!];
    scopeSql = ` AND d.user_id IN (${ids.map(() => '?').join(',')})`;
    scopeArgs.push(...ids);
  }
  const base = `FROM user_data d JOIN users u ON u.id = d.user_id
    LEFT JOIN social_settings s ON s.user_id = d.user_id
    WHERE d.game_id = ? AND d.key = ? AND d.visibility = 'public' AND d.num_value IS NOT NULL${scopeSql}`;
  const baseArgs = [gameId, key, ...scopeArgs];
  const visible = `${base} AND COALESCE(s.leaderboard_visible, 1) = 1`;
  const cols = 'd.user_id, u.username, d.value, d.updated_at, d.num_value';
  const map = (rows: ArrayLike<{ [k: string]: unknown }>, from: number): LeaderboardEntry[] =>
    Array.from(rows).map((row, i) => ({
      rank: from + i + 1,
      userId: row.user_id as string,
      username: row.username as string,
      value: JSON.parse(row.value as string),
      updatedAt: row.updated_at as number,
    }));

  const total = Number((await db.execute({ sql: `SELECT COUNT(*) AS n ${visible}`, args: baseArgs })).rows[0].n);
  let me: LeaderboardEntry | null | undefined;
  let myRank = 0;
  if ((q.me || q.around) && q.userId) {
    const mine = (await db.execute({ sql: `SELECT ${cols} ${base} AND d.user_id = ?`, args: [...baseArgs, q.userId] })).rows[0];
    if (mine) {
      const cmp = dir === 'DESC' ? '>' : '<';
      const ahead = Number((await db.execute({
        sql: `SELECT COUNT(*) AS n ${visible} AND (d.num_value ${cmp} ? OR (d.num_value = ? AND (d.updated_at < ? OR (d.updated_at = ? AND d.user_id < ?))))`,
        args: [...baseArgs, mine.num_value as number, mine.num_value as number, mine.updated_at as number, mine.updated_at as number, q.userId],
      })).rows[0].n);
      myRank = ahead + 1;
      me = map([mine], ahead)[0];
    } else {
      me = null;
    }
  }

  let offset = q.offset ?? 0;
  let size = limit;
  if (q.around) {
    const range = q.range ?? 5;
    const start = Math.max(0, (myRank || 1) - 1 - range);
    offset = start;
    size = (myRank ? myRank - 1 - start : 0) + range + 1;
    if (!myRank) size = limit;
  }
  const rows = (await db.execute({ sql: `SELECT ${cols} ${visible} ORDER BY ${ORDER(dir)} LIMIT ? OFFSET ?`, args: [...baseArgs, size, offset] })).rows;
  return { entries: map(rows as never, offset), ...(me !== undefined ? { me } : {}), total };
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
