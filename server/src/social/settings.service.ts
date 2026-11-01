import type { NotificationType, OwnPresenceStatus, SocialSettings } from '@ethernal/shared';
import { db } from '../db/database';
import { HubError } from '../errors';

const STATUSES: OwnPresenceStatus[] = ['online', 'away', 'busy', 'invisible'];
const NOTIFICATION_TYPES: NotificationType[] = [
  'friend_request', 'friend_accepted', 'friend_removed', 'dm', 'lobby_invite',
  'lobby_invite_cancelled', 'friend_online', 'kicked', 'system',
];

export interface SettingsRow extends SocialSettings {
  userId: string;
  username: string;
  lastSeen?: number;
}

const cache = new Map<string, SettingsRow>();

function parseMuted(raw: unknown): NotificationType[] {
  try {
    const arr = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(arr) ? arr.filter((t): t is NotificationType => NOTIFICATION_TYPES.includes(t)) : [];
  } catch {
    return [];
  }
}

function toRow(r: Record<string, unknown>): SettingsRow {
  const status = STATUSES.includes(r.status as OwnPresenceStatus) ? (r.status as OwnPresenceStatus) : 'online';
  return {
    userId: String(r.id),
    username: String(r.username),
    status,
    showLastSeen: r.show_last_seen === null || r.show_last_seen === undefined ? true : Number(r.show_last_seen) === 1,
    dmReadReceipts: r.dm_read_receipts === null || r.dm_read_receipts === undefined ? true : Number(r.dm_read_receipts) === 1,
    leaderboardVisible: r.leaderboard_visible === null || r.leaderboard_visible === undefined ? true : Number(r.leaderboard_visible) === 1,
    mutedNotificationTypes: parseMuted(r.muted_types),
    lastSeen: r.last_seen === null || r.last_seen === undefined ? undefined : Number(r.last_seen),
  };
}

const SELECT = `SELECT u.id, u.username, s.status, s.show_last_seen, s.dm_read_receipts, s.leaderboard_visible, s.muted_types, s.last_seen
  FROM users u LEFT JOIN social_settings s ON s.user_id = u.id`;

export async function loadSettings(userId: string, force = false): Promise<SettingsRow | undefined> {
  if (!force) {
    const hit = cache.get(userId);
    if (hit) return hit;
  }
  const res = await db.execute({ sql: `${SELECT} WHERE u.id = ?`, args: [userId] });
  if (res.rows.length === 0) return undefined;
  const row = toRow(res.rows[0] as unknown as Record<string, unknown>);
  cache.set(userId, row);
  return row;
}

/** Lädt mehrere User in einer Abfrage (Cache-Treffer werden nicht erneut gelesen). */
export async function loadSettingsMany(userIds: string[]): Promise<Map<string, SettingsRow>> {
  const out = new Map<string, SettingsRow>();
  const missing: string[] = [];
  for (const id of userIds) {
    const hit = cache.get(id);
    if (hit) out.set(id, hit);
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 200) {
    const chunk = missing.slice(i, i + 200);
    const res = await db.execute({ sql: `${SELECT} WHERE u.id IN (${chunk.map(() => '?').join(',')})`, args: chunk });
    for (const r of res.rows) {
      const row = toRow(r as unknown as Record<string, unknown>);
      out.set(row.userId, row);
    }
  }
  return out;
}

export function publicSettings(row: SettingsRow): SocialSettings {
  return {
    status: row.status,
    showLastSeen: row.showLastSeen,
    dmReadReceipts: row.dmReadReceipts,
    leaderboardVisible: row.leaderboardVisible,
    mutedNotificationTypes: row.mutedNotificationTypes,
  };
}

export async function updateSettings(userId: string, patch: unknown): Promise<SettingsRow> {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const current = await loadSettings(userId, true);
  if (!current) throw new HubError('USER_NOT_FOUND');
  const next = { ...current };
  if (p.status !== undefined) {
    if (!STATUSES.includes(p.status as OwnPresenceStatus)) throw new HubError('INVALID_INPUT', 'Ungültiger Status');
    next.status = p.status as OwnPresenceStatus;
  }
  if (p.showLastSeen !== undefined) {
    if (typeof p.showLastSeen !== 'boolean') throw new HubError('INVALID_INPUT');
    next.showLastSeen = p.showLastSeen;
  }
  if (p.dmReadReceipts !== undefined) {
    if (typeof p.dmReadReceipts !== 'boolean') throw new HubError('INVALID_INPUT');
    next.dmReadReceipts = p.dmReadReceipts;
  }
  if (p.leaderboardVisible !== undefined) {
    if (typeof p.leaderboardVisible !== 'boolean') throw new HubError('INVALID_INPUT');
    next.leaderboardVisible = p.leaderboardVisible;
  }
  if (p.mutedNotificationTypes !== undefined) {
    const m = p.mutedNotificationTypes;
    if (!Array.isArray(m) || m.some((t) => !NOTIFICATION_TYPES.includes(t as NotificationType))) {
      throw new HubError('INVALID_INPUT', 'Ungültige Benachrichtigungstypen');
    }
    next.mutedNotificationTypes = [...new Set(m as NotificationType[])];
  }
  await db.execute({
    sql: `INSERT INTO social_settings (user_id, status, show_last_seen, dm_read_receipts, leaderboard_visible, muted_types, last_seen)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, show_last_seen = excluded.show_last_seen,
            dm_read_receipts = excluded.dm_read_receipts, leaderboard_visible = excluded.leaderboard_visible, muted_types = excluded.muted_types`,
    args: [userId, next.status, next.showLastSeen ? 1 : 0, next.dmReadReceipts ? 1 : 0, next.leaderboardVisible ? 1 : 0, JSON.stringify(next.mutedNotificationTypes), next.lastSeen ?? null],
  });
  cache.set(userId, next);
  return next;
}

export async function setLastSeen(userId: string, at: number): Promise<void> {
  await db.execute({
    sql: `INSERT INTO social_settings (user_id, last_seen) VALUES (?, ?)
          ON CONFLICT(user_id) DO UPDATE SET last_seen = excluded.last_seen`,
    args: [userId, at],
  });
  const hit = cache.get(userId);
  if (hit) hit.lastSeen = at;
}

export async function deleteSettings(userId: string): Promise<void> {
  cache.delete(userId);
  await db.execute({ sql: 'DELETE FROM social_settings WHERE user_id = ?', args: [userId] });
}

export function evictSettings(keep: (userId: string) => boolean): void {
  for (const id of cache.keys()) if (!keep(id)) cache.delete(id);
}
