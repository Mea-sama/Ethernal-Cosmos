import { v4 as uuidv4 } from 'uuid';
import type {
  HubNotification,
  NotificationBacklog,
  NotificationCounts,
  NotificationListResult,
  NotificationType,
} from '@ethernal/shared';
import { db } from '../db/database';
import { HubError } from '../errors';
import { socialConfig } from './config';
import { emitToUser } from './bus';
import { loadSettings } from './settings.service';

function toNotification(r: Record<string, unknown>): HubNotification {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(String(r.payload));
  } catch {
    /* defekte Payload → leer */
  }
  return {
    id: String(r.id),
    type: r.type as NotificationType,
    payload,
    createdAt: Number(r.created_at),
    ...(r.read_at !== null && r.read_at !== undefined ? { readAt: Number(r.read_at) } : {}),
    expiresAt: Number(r.expires_at),
  };
}

export interface NotifyOptions {
  /** Schlüssel zum gezielten Entfernen/Lesen (z.B. `friend_request:<id>`) */
  key?: string;
  /** DM-Collapse: ungelesene Notification mit gleichem Key wird fortgeschrieben (`count`) */
  collapse?: boolean;
  /** Absoluter Ablaufzeitpunkt; Default: Retention für Ungelesene */
  expiresAt?: number;
  /** Live-Event unterdrücken (nur persistieren) */
  silent?: boolean;
}

/** Legt eine Notification an (respektiert Mute-Einstellung) und pusht sie live an alle Sessions des Users. */
export async function notify(
  userId: string,
  type: NotificationType,
  payload: Record<string, unknown>,
  opts: NotifyOptions = {},
): Promise<HubNotification | null> {
  const settings = await loadSettings(userId);
  if (!settings || settings.mutedNotificationTypes.includes(type)) return null;

  const now = Date.now();
  const expiresAt = opts.expiresAt ?? now + socialConfig.notificationUnreadRetentionMs;
  let result: HubNotification | undefined;

  if (opts.collapse && opts.key) {
    const existing = await db.execute({
      sql: 'SELECT * FROM notifications WHERE user_id = ? AND collapse_key = ? AND read_at IS NULL',
      args: [userId, opts.key],
    });
    if (existing.rows.length > 0) {
      const old = toNotification(existing.rows[0] as unknown as Record<string, unknown>);
      const count = (Number(old.payload.count) || 1) + 1;
      const merged = { ...payload, count };
      await db.execute({
        sql: 'UPDATE notifications SET payload = ?, created_at = ?, expires_at = ? WHERE id = ?',
        args: [JSON.stringify(merged), now, expiresAt, old.id],
      });
      result = { ...old, payload: merged, createdAt: now, expiresAt };
    }
  }

  if (!result) {
    const id = uuidv4();
    const body = opts.collapse ? { ...payload, count: 1 } : payload;
    await db.execute({
      sql: `INSERT INTO notifications (id, user_id, type, payload, created_at, read_at, expires_at, collapse_key)
            VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      args: [id, userId, type, JSON.stringify(body), now, expiresAt, opts.key ?? null],
    });
    result = { id, type, payload: body, createdAt: now, expiresAt };
    await db.execute({
      sql: `DELETE FROM notifications WHERE user_id = ? AND id NOT IN
            (SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
      args: [userId, userId, socialConfig.notificationCap],
    });
  }

  if (!opts.silent) emitToUser(userId, 'notification', result);
  return result;
}

/** Entfernt Notifications eines Users anhand ihres Schlüssels (z.B. beantwortete Anfrage, zurückgezogene Einladung). */
export async function dropNotifications(userId: string, key: string): Promise<void> {
  await db.execute({ sql: 'DELETE FROM notifications WHERE user_id = ? AND collapse_key = ?', args: [userId, key] });
}

export async function markReadByKey(userId: string, key: string): Promise<void> {
  const now = Date.now();
  await db.execute({
    sql: `UPDATE notifications SET read_at = ?, expires_at = MIN(expires_at, ?)
          WHERE user_id = ? AND collapse_key = ? AND read_at IS NULL`,
    args: [now, now + socialConfig.notificationReadRetentionMs, userId, key],
  });
}

export async function unreadCount(userId: string): Promise<number> {
  const res = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL AND expires_at > ?',
    args: [userId, Date.now()],
  });
  return Number(res.rows[0].n);
}

export async function listNotifications(
  userId: string,
  opts: { since?: number; unreadOnly?: boolean; limit?: number; cursor?: string } = {},
): Promise<NotificationListResult> {
  const limit = Math.min(Math.max(Math.trunc(Number(opts.limit) || 50), 1), 100);
  const where = ['user_id = ?', 'expires_at > ?'];
  const args: (string | number)[] = [userId, Date.now()];
  if (opts.unreadOnly) where.push('read_at IS NULL');
  if (opts.since !== undefined) {
    if (!Number.isFinite(Number(opts.since))) throw new HubError('INVALID_INPUT');
    where.push('created_at > ?');
    args.push(Number(opts.since));
  }
  if (opts.cursor) {
    const idx = String(opts.cursor).indexOf(':');
    const at = Number(String(opts.cursor).slice(0, idx));
    if (idx < 0 || !Number.isFinite(at)) throw new HubError('INVALID_INPUT', 'Ungültiger Cursor');
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    args.push(at, at, String(opts.cursor).slice(idx + 1));
  }
  const res = await db.execute({
    sql: `SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
    args: [...args, limit + 1],
  });
  const rows = res.rows.map((r) => toNotification(r as unknown as Record<string, unknown>));
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { notifications: page, ...(rows.length > limit && last ? { nextCursor: `${last.createdAt}:${last.id}` } : {}) };
}

export async function markRead(userId: string, input: { ids?: string[]; upTo?: number }): Promise<{ marked: number; unread: number }> {
  const hasIds = Array.isArray(input?.ids) && input.ids.length > 0;
  const hasUpTo = input?.upTo !== undefined;
  if (!hasIds && !hasUpTo) throw new HubError('INVALID_INPUT', 'ids oder upTo erforderlich');
  const conds: string[] = [];
  const args: (string | number)[] = [];
  if (hasIds) {
    const ids = input.ids!.slice(0, 200).map(String);
    conds.push(`id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }
  if (hasUpTo) {
    const upTo = Number(input.upTo);
    if (!Number.isFinite(upTo)) throw new HubError('INVALID_INPUT');
    conds.push('created_at <= ?');
    args.push(upTo);
  }
  const now = Date.now();
  const res = await db.execute({
    sql: `UPDATE notifications SET read_at = ?, expires_at = MIN(expires_at, ?)
          WHERE user_id = ? AND read_at IS NULL AND (${conds.join(' OR ')})`,
    args: [now, now + socialConfig.notificationReadRetentionMs, userId, ...args],
  });
  return { marked: res.rowsAffected, unread: await unreadCount(userId) };
}

export async function notificationCounts(userId: string): Promise<NotificationCounts> {
  const res = await db.execute({
    sql: `SELECT type, read_at IS NULL AS unread, COUNT(*) AS n FROM notifications
          WHERE user_id = ? AND expires_at > ? GROUP BY type, unread`,
    args: [userId, Date.now()],
  });
  const counts: NotificationCounts = { unread: 0, total: 0, byType: {} };
  for (const r of res.rows) {
    const n = Number(r.n);
    counts.total += n;
    if (Number(r.unread) === 1) {
      counts.unread += n;
      const t = r.type as NotificationType;
      counts.byType[t] = (counts.byType[t] ?? 0) + n;
    }
  }
  return counts;
}

export async function backlog(userId: string): Promise<NotificationBacklog> {
  const unread = await unreadCount(userId);
  const latest = (await listNotifications(userId, { unreadOnly: true, limit: socialConfig.notificationBacklogSize })).notifications;
  return { unreadCount: unread, latest };
}

export async function purgeExpiredNotifications(): Promise<number> {
  const res = await db.execute({ sql: 'DELETE FROM notifications WHERE expires_at < ?', args: [Date.now()] });
  return res.rowsAffected;
}

export async function deleteUserNotifications(userId: string): Promise<void> {
  await db.execute({ sql: 'DELETE FROM notifications WHERE user_id = ?', args: [userId] });
}
