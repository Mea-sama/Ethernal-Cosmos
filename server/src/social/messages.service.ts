import { v4 as uuidv4 } from 'uuid';
import type { DirectMessage, DmConversation, DmConversationUnread, DmHistoryResult, DmReadState, DmUnreadResult } from '@ethernal/shared';
import { db } from '../db/database';
import { HubError } from '../errors';
import { sessionManager } from '../session/session.manager';
import { socialConfig } from './config';
import { emitToUser } from './bus';
import { assertFriends, friendHooks, pair } from './friends.service';
import { dropNotifications, markReadByKey, notify } from './notifications.service';
import { loadSettings } from './settings.service';

export const conversationId = (a: string, b: string): string => pair(a, b).join(':');
const dmKey = (conv: string): string => `dm:${conv}`;

function toMessage(r: Record<string, unknown>): DirectMessage {
  return {
    id: String(r.id),
    seq: Number(r.seq),
    conversationId: String(r.conversation_id),
    from: String(r.from_user),
    to: String(r.to_user),
    text: String(r.text),
    sentAt: Number(r.sent_at),
    ...(r.delivered_at !== null && r.delivered_at !== undefined ? { deliveredAt: Number(r.delivered_at) } : {}),
    ...(r.read_at !== null && r.read_at !== undefined ? { readAt: Number(r.read_at) } : {}),
  };
}

const cutoff = (): number => Date.now() - socialConfig.dmRetentionMs;

export async function sendMessage(fromId: string, toId: string, text: unknown): Promise<DirectMessage> {
  if (typeof text !== 'string' || text.trim().length === 0) throw new HubError('INVALID_INPUT', 'Nachricht fehlt');
  if ([...text].length > socialConfig.dmMaxLength) {
    throw new HubError('MESSAGE_TOO_LONG', `Nachricht zu lang (max ${socialConfig.dmMaxLength} Zeichen)`);
  }
  await assertFriends(fromId, toId);

  const conv = conversationId(fromId, toId);
  const id = uuidv4();
  const now = Date.now();
  const live = sessionManager.isConnected(toId);
  await db.execute({
    sql: `INSERT INTO direct_messages (id, conversation_id, from_user, to_user, text, sent_at, delivered_at, read_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    args: [id, conv, fromId, toId, text, now, live ? now : null],
  });
  await db.execute({
    sql: `DELETE FROM direct_messages WHERE conversation_id = ? AND rowid NOT IN
          (SELECT rowid FROM direct_messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT ?)`,
    args: [conv, conv, socialConfig.dmConversationCap],
  });
  const row = await db.execute({ sql: 'SELECT rowid AS seq, * FROM direct_messages WHERE id = ?', args: [id] });
  const message = toMessage(row.rows[0] as unknown as Record<string, unknown>);

  if (live) {
    emitToUser(toId, 'dm:received', message);
  } else {
    const sender = await loadSettings(fromId);
    await notify(
      toId,
      'dm',
      { fromUserId: fromId, fromUsername: sender?.username ?? '', conversationId: conv, preview: [...text].slice(0, 80).join('') },
      { key: dmKey(conv), collapse: true },
    );
  }
  return message;
}

/** Markiert an `userId` adressierte, noch nicht zugestellte Nachrichten als zugestellt und informiert die Absender. */
export async function markDelivered(userId: string, fromId?: string): Promise<void> {
  const where = fromId ? 'to_user = ? AND from_user = ? AND delivered_at IS NULL' : 'to_user = ? AND delivered_at IS NULL';
  const args = fromId ? [userId, fromId] : [userId];
  const pending = await db.execute({ sql: `SELECT id, from_user FROM direct_messages WHERE ${where}`, args });
  if (pending.rows.length === 0) return;
  await db.execute({ sql: `UPDATE direct_messages SET delivered_at = ? WHERE ${where}`, args: [Date.now(), ...args] });
  const bySender = new Map<string, string[]>();
  for (const r of pending.rows) {
    const list = bySender.get(String(r.from_user)) ?? [];
    list.push(String(r.id));
    bySender.set(String(r.from_user), list);
  }
  for (const [sender, messageIds] of bySender) emitToUser(sender, 'dm:delivered', { byUserId: userId, messageIds });
}

async function readCursor(userId: string, withId: string): Promise<{ lastReadSeq: number; unreadCount: number; firstUnreadSeq?: number }> {
  const res = await db.execute({
    sql: `SELECT COALESCE(MAX(CASE WHEN read_at IS NOT NULL THEN rowid END), 0) AS last_read,
                 SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END) AS unread,
                 MIN(CASE WHEN read_at IS NULL THEN rowid END) AS first_unread
          FROM direct_messages WHERE to_user = ? AND from_user = ? AND sent_at > ?`,
    args: [userId, withId, cutoff()],
  });
  const r = res.rows[0];
  return {
    lastReadSeq: Number(r.last_read),
    unreadCount: Number(r.unread ?? 0),
    ...(r.first_unread !== null && r.first_unread !== undefined ? { firstUnreadSeq: Number(r.first_unread) } : {}),
  };
}

async function peerCursor(userId: string, withId: string): Promise<number | undefined> {
  if (!(await loadSettings(withId))?.dmReadReceipts) return undefined;
  const res = await db.execute({
    sql: 'SELECT MAX(rowid) AS seq FROM direct_messages WHERE from_user = ? AND to_user = ? AND read_at IS NOT NULL',
    args: [userId, withId],
  });
  return Number(res.rows[0].seq ?? 0);
}

export async function history(userId: string, withId: string, opts: { before?: number; limit?: number } = {}): Promise<DmHistoryResult> {
  await assertFriends(userId, withId);
  const limit = Math.min(Math.max(Math.trunc(Number(opts.limit) || 50), 1), 100);
  await markDelivered(userId, withId);
  const args: Array<string | number> = [conversationId(userId, withId), cutoff()];
  let beforeSql = '';
  if (opts.before !== undefined) {
    if (!Number.isFinite(Number(opts.before))) throw new HubError('INVALID_INPUT');
    beforeSql = ' AND rowid < ?';
    args.push(Number(opts.before));
  }
  const res = await db.execute({
    sql: `SELECT rowid AS seq, * FROM direct_messages WHERE conversation_id = ? AND sent_at > ?${beforeSql}
          ORDER BY rowid DESC LIMIT ?`,
    args: [...args, limit + 1],
  });
  const rows = res.rows.map((r) => toMessage(r as unknown as Record<string, unknown>));
  const page = rows.slice(0, limit);
  const more = rows.length > limit;
  page.reverse();
  const cursor = await readCursor(userId, withId);
  const peer = await peerCursor(userId, withId);
  return {
    messages: page,
    ...(more && page[0] ? { nextBefore: page[0].seq } : {}),
    ...cursor,
    ...(peer !== undefined ? { peerLastReadSeq: peer } : {}),
  };
}

/** Chat öffnen: letzte Nachrichten + Lesestand von *vor* dem Öffnen, danach wird alles als gelesen markiert. */
export async function openConversation(userId: string, withId: string, limit?: number): Promise<DmHistoryResult> {
  const result = await history(userId, withId, { limit: limit ?? 10 });
  await markConversationRead(userId, withId);
  return result;
}

export async function conversations(userId: string): Promise<DmConversation[]> {
  const res = await db.execute({
    sql: `SELECT MAX(rowid) AS last_seq,
                 SUM(CASE WHEN to_user = ? AND read_at IS NULL THEN 1 ELSE 0 END) AS unread
          FROM direct_messages WHERE (from_user = ? OR to_user = ?) AND sent_at > ?
          GROUP BY conversation_id ORDER BY last_seq DESC`,
    args: [userId, userId, userId, cutoff()],
  });
  const out: DmConversation[] = [];
  for (const r of res.rows) {
    const msg = await db.execute({
      sql: `SELECT m.rowid AS seq, m.*, u.username AS other_name FROM direct_messages m
            JOIN users u ON u.id = CASE WHEN m.from_user = ? THEN m.to_user ELSE m.from_user END
            WHERE m.rowid = ?`,
      args: [userId, Number(r.last_seq)],
    });
    if (msg.rows.length === 0) continue;
    const last = toMessage(msg.rows[0] as unknown as Record<string, unknown>);
    out.push({
      withUserId: last.from === userId ? last.to : last.from,
      username: String(msg.rows[0].other_name),
      lastMessage: last,
      unreadCount: Number(r.unread),
      lastReadSeq: (await readCursor(userId, last.from === userId ? last.to : last.from)).lastReadSeq,
    });
  }
  return out;
}

export async function unreadByConversation(userId: string): Promise<DmConversationUnread[]> {
  const res = await db.execute({
    sql: `SELECT from_user, COUNT(*) AS n, MIN(rowid) AS first_seq, MAX(rowid) AS last_seq, MAX(sent_at) AS last_at
          FROM direct_messages
          WHERE to_user = ? AND read_at IS NULL AND sent_at > ? GROUP BY from_user ORDER BY last_seq DESC`,
    args: [userId, cutoff()],
  });
  return res.rows.map((r) => ({
    withUserId: String(r.from_user),
    unreadCount: Number(r.n),
    firstUnreadSeq: Number(r.first_seq),
    lastSeq: Number(r.last_seq),
    lastMessageAt: Number(r.last_at),
  }));
}

export async function unread(userId: string): Promise<DmUnreadResult> {
  const list = await unreadByConversation(userId);
  return { conversations: list, totalUnread: list.reduce((n, c) => n + c.unreadCount, 0) };
}

async function readState(userId: string, withId: string, marked: number): Promise<DmReadState> {
  const cursor = await readCursor(userId, withId);
  return {
    withUserId: withId,
    marked,
    lastReadSeq: cursor.lastReadSeq,
    unreadCount: cursor.unreadCount,
    totalUnread: (await unread(userId)).totalUnread,
  };
}

/** Setzt den Lesestand: alles bis `upToSeq` (Standard: alles) gilt als gelesen. */
export async function markConversationRead(userId: string, withId: string, upToSeq?: number): Promise<DmReadState> {
  await assertFriends(userId, withId);
  const now = Date.now();
  const limitSql = upToSeq !== undefined ? ' AND rowid <= ?' : '';
  const base: Array<string | number> = [userId, withId, ...(upToSeq !== undefined ? [upToSeq] : [])];
  const last = await db.execute({
    sql: `SELECT MAX(rowid) AS seq FROM direct_messages WHERE to_user = ? AND from_user = ? AND read_at IS NULL${limitSql}`,
    args: base,
  });
  const res = await db.execute({
    sql: `UPDATE direct_messages SET read_at = ?, delivered_at = COALESCE(delivered_at, ?)
          WHERE to_user = ? AND from_user = ? AND read_at IS NULL${limitSql}`,
    args: [now, now, ...base],
  });
  const state = await readState(userId, withId, res.rowsAffected);
  if (state.unreadCount === 0) await markReadByKey(userId, dmKey(conversationId(userId, withId)));
  if (res.rowsAffected > 0) {
    emitToUser(userId, 'dm:readState', state);
    if ((await loadSettings(userId))?.dmReadReceipts) {
      emitToUser(withId, 'dm:read', { byUserId: userId, upToSeq: Number(last.rows[0].seq) });
    }
  }
  return state;
}

export async function typing(userId: string, toId: string): Promise<void> {
  await assertFriends(userId, toId);
  if (sessionManager.isConnected(toId)) emitToUser(toId, 'dm:typing', { fromUserId: userId });
}

async function purgeConversation(a: string, b: string): Promise<void> {
  const conv = conversationId(a, b);
  await db.execute({ sql: 'DELETE FROM direct_messages WHERE conversation_id = ?', args: [conv] });
  await dropNotifications(a, dmKey(conv));
  await dropNotifications(b, dmKey(conv));
}

friendHooks.onRemoved.push(purgeConversation);

export async function purgeExpiredMessages(): Promise<number> {
  const res = await db.execute({ sql: 'DELETE FROM direct_messages WHERE sent_at < ?', args: [cutoff()] });
  return res.rowsAffected;
}

export async function purgeUserMessages(userId: string): Promise<void> {
  await db.execute({ sql: 'DELETE FROM direct_messages WHERE from_user = ? OR to_user = ?', args: [userId, userId] });
}
