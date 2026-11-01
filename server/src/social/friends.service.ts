import { v4 as uuidv4 } from 'uuid';
import type {
  FriendInfo,
  FriendRequestInfo,
  FriendRequestResult,
  FriendRequestSource,
  FriendRequestsResult,
} from '@ethernal/shared';
import { db } from '../db/database';
import { HubError } from '../errors';
import { lobbyManager } from '../lobby/lobby.manager';
import { socialConfig } from './config';
import { emitToUser } from './bus';
import { isBlockedEither } from './blocks.service';
import { dropNotifications, notify } from './notifications.service';

/** Hooks, die andere Social-Module bei Freundschafts-Ende registrieren (vermeidet Import-Zyklen). */
export const friendHooks = {
  onRemoved: [] as Array<(a: string, b: string) => Promise<void> | void>,
  onAdded: [] as Array<(a: string, b: string) => Promise<void> | void>,
};

export const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

export async function userInfo(userId: string): Promise<FriendInfo | null> {
  const res = await db.execute({ sql: 'SELECT id, username FROM users WHERE id = ?', args: [userId] });
  return res.rows.length ? { userId: String(res.rows[0].id), username: String(res.rows[0].username) } : null;
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const [x, y] = pair(a, b);
  const res = await db.execute({ sql: 'SELECT 1 FROM friendships WHERE user_a = ? AND user_b = ?', args: [x, y] });
  return res.rows.length > 0;
}

export async function assertFriends(a: string, b: string): Promise<void> {
  if (!(await areFriends(a, b))) throw new HubError('NOT_FRIENDS');
}

export async function friendIds(userId: string): Promise<string[]> {
  const res = await db.execute({
    sql: `SELECT user_b AS f FROM friendships WHERE user_a = ? UNION SELECT user_a AS f FROM friendships WHERE user_b = ?`,
    args: [userId, userId],
  });
  return res.rows.map((r) => String(r.f));
}

export async function listFriends(userId: string): Promise<FriendInfo[]> {
  const res = await db.execute({
    sql: `SELECT u.id, u.username FROM users u WHERE u.id IN
            (SELECT user_b FROM friendships WHERE user_a = ? UNION SELECT user_a FROM friendships WHERE user_b = ?)
          ORDER BY u.username`,
    args: [userId, userId],
  });
  return res.rows.map((r) => ({ userId: String(r.id), username: String(r.username) }));
}

async function count(sql: string, args: Array<string | number>): Promise<number> {
  return Number((await db.execute({ sql, args })).rows[0].n);
}

const friendCount = (userId: string): Promise<number> =>
  count('SELECT COUNT(*) AS n FROM friendships WHERE user_a = ? OR user_b = ?', [userId, userId]);

interface RequestRow {
  id: string;
  from: string;
  to: string;
  source: FriendRequestSource;
  createdAt: number;
  expiresAt: number;
}

function toRequest(r: Record<string, unknown>): RequestRow {
  return {
    id: String(r.id),
    from: String(r.from_user),
    to: String(r.to_user),
    source: r.source as FriendRequestSource,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
  };
}

async function findRequest(id: string): Promise<RequestRow | undefined> {
  const res = await db.execute({ sql: 'SELECT * FROM friend_requests WHERE id = ? AND expires_at > ?', args: [id, Date.now()] });
  return res.rows.length ? toRequest(res.rows[0] as unknown as Record<string, unknown>) : undefined;
}

async function findRequestBetween(from: string, to: string): Promise<RequestRow | undefined> {
  const res = await db.execute({
    sql: 'SELECT * FROM friend_requests WHERE from_user = ? AND to_user = ? AND expires_at > ?',
    args: [from, to, Date.now()],
  });
  return res.rows.length ? toRequest(res.rows[0] as unknown as Record<string, unknown>) : undefined;
}

/** Filter für Anfragen (Alias r), die nicht durch einen Block versteckt sind */
const VISIBLE_REQUEST = `NOT EXISTS (SELECT 1 FROM user_blocks b WHERE
  (b.blocker_id = r.from_user AND b.blocked_id = r.to_user) OR (b.blocker_id = r.to_user AND b.blocked_id = r.from_user))`;

const requestKey = (id: string): string => `friend_request:${id}`;

async function establish(requesterId: string, responderId: string, requestId: string | undefined): Promise<void> {
  const [a, b] = pair(requesterId, responderId);
  await db.execute({ sql: 'INSERT OR IGNORE INTO friendships (user_a, user_b, created_at) VALUES (?, ?, ?)', args: [a, b, Date.now()] });
  const stale = await db.execute({
    sql: `SELECT id FROM friend_requests WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)`,
    args: [requesterId, responderId, responderId, requesterId],
  });
  await db.execute({
    sql: `DELETE FROM friend_requests WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)`,
    args: [requesterId, responderId, responderId, requesterId],
  });
  for (const r of stale.rows) {
    await dropNotifications(responderId, requestKey(String(r.id)));
    await dropNotifications(requesterId, requestKey(String(r.id)));
  }
  const [requester, responder] = await Promise.all([userInfo(requesterId), userInfo(responderId)]);
  if (requester && responder) {
    emitToUser(requesterId, 'friend:requestAccepted', { friend: responder, requestId });
    emitToUser(responderId, 'friend:requestAccepted', { friend: requester, requestId });
    await notify(requesterId, 'friend_accepted', { userId: responder.userId, username: responder.username });
  }
  for (const hook of friendHooks.onAdded) await hook(requesterId, responderId);
}

/** Gemeinsamer Kern für Name- und Lobby-Anfragen. Still (kein Fehler) für alles, was Informationen über andere leaken würde. */
async function createRequest(fromId: string, toId: string, source: FriendRequestSource): Promise<void> {
  if (fromId === toId) return;
  if (await areFriends(fromId, toId)) return;
  if ((await friendCount(fromId)) >= socialConfig.maxFriends) throw new HubError('FRIEND_LIMIT_REACHED');

  const blocked = await isBlockedEither(fromId, toId);

  const inverse = blocked ? undefined : await findRequestBetween(toId, fromId);
  if (inverse) {
    if ((await friendCount(toId)) >= socialConfig.maxFriends) return;
    await establish(toId, fromId, inverse.id);
    return;
  }
  if (await findRequestBetween(fromId, toId)) return;
  if ((await count('SELECT COUNT(*) AS n FROM friend_requests WHERE from_user = ? AND expires_at > ?', [fromId, Date.now()])) >= socialConfig.maxOutgoingRequests) {
    throw new HubError('REQUEST_LIMIT_REACHED');
  }
  if ((await count(`SELECT COUNT(*) AS n FROM friend_requests r WHERE r.to_user = ? AND r.expires_at > ? AND ${VISIBLE_REQUEST}`, [toId, Date.now()])) >= socialConfig.maxIncomingRequests) return;

  const now = Date.now();
  const id = uuidv4();
  const expiresAt = now + socialConfig.requestExpiryMs;
  await db.execute({
    sql: 'INSERT INTO friend_requests (id, from_user, to_user, source, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    args: [id, fromId, toId, source, now, expiresAt],
  });
  // Shadow-Anfrage: für den Absender sichtbar wie jede andere, dem Empfänger wird nie etwas zugestellt oder angezeigt
  if (blocked) return;
  const sender = await userInfo(fromId);
  if (!sender) return;
  const request: FriendRequestInfo = { id, user: sender, source, createdAt: now, expiresAt };
  emitToUser(toId, 'friend:requestReceived', { request });
  await notify(toId, 'friend_request', { requestId: id, fromUserId: sender.userId, fromUsername: sender.username, source }, { key: requestKey(id), expiresAt });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Anfrage per Username. Antwort ist ausschließlich REQUEST_SENT oder NO_SUCH_PLAYER; alle anderen Fälle
 * (selbst, bereits befreundet, Duplikat, volles Postfach des Ziels) sehen für den Aufrufer wie REQUEST_SENT aus.
 */
export async function requestByName(fromId: string, username: string): Promise<FriendRequestResult> {
  const started = Date.now();
  const res = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [username] });
  let result: FriendRequestResult = 'NO_SUCH_PLAYER';
  if (res.rows.length > 0) {
    result = 'REQUEST_SENT';
    await createRequest(fromId, String(res.rows[0].id), 'name');
  }
  const remaining = socialConfig.nameLookupMinMs - (Date.now() - started);
  if (remaining > 0) await sleep(remaining);
  return result;
}

/** Anfrage an ein Mitglied der eigenen Lobby */
export async function requestFromLobby(fromId: string, targetId: string): Promise<FriendRequestResult> {
  const mine = lobbyManager.getLobbyByUserId(fromId);
  if (!mine) throw new HubError('NOT_IN_LOBBY');
  const theirs = lobbyManager.getLobbyByUserId(targetId);
  if (!theirs || theirs.id !== mine.id) throw new HubError('PLAYER_NOT_IN_LOBBY');
  await createRequest(fromId, targetId, 'lobby');
  return 'REQUEST_SENT';
}

export async function respond(userId: string, requestId: string, accept: boolean): Promise<void> {
  const req = await findRequest(requestId);
  if (!req || req.to !== userId || (await isBlockedEither(req.from, req.to))) throw new HubError('FRIEND_REQUEST_NOT_FOUND');
  if (accept) {
    if ((await friendCount(userId)) >= socialConfig.maxFriends) throw new HubError('FRIEND_LIMIT_REACHED');
    if ((await friendCount(req.from)) >= socialConfig.maxFriends) {
      await db.execute({ sql: 'DELETE FROM friend_requests WHERE id = ?', args: [requestId] });
      await dropNotifications(userId, requestKey(requestId));
      throw new HubError('FRIEND_REQUEST_NOT_FOUND');
    }
    await establish(req.from, userId, requestId);
    return;
  }
  await db.execute({ sql: 'DELETE FROM friend_requests WHERE id = ?', args: [requestId] });
  await dropNotifications(userId, requestKey(requestId));
  const decliner = await userInfo(userId);
  if (decliner && !socialConfig.silentDecline) emitToUser(req.from, 'friend:requestDeclined', { requestId, user: decliner });
}

export async function cancel(userId: string, requestId: string): Promise<void> {
  const req = await findRequest(requestId);
  if (!req || req.from !== userId) throw new HubError('FRIEND_REQUEST_NOT_FOUND');
  await db.execute({ sql: 'DELETE FROM friend_requests WHERE id = ?', args: [requestId] });
  await dropNotifications(req.to, requestKey(requestId));
  if (!(await isBlockedEither(req.from, req.to))) emitToUser(req.to, 'friend:requestCancelled', { requestId });
}

/** Entfernt offene Anfragen zwischen zwei Usern in beide Richtungen; der Empfänger einer abgebrochenen Anfrage erhält friend:requestCancelled. */
export async function dropRequestsBetween(a: string, b: string): Promise<void> {
  const reqs = await db.execute({
    sql: `SELECT id, from_user, to_user FROM friend_requests WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)`,
    args: [a, b, b, a],
  });
  await db.execute({
    sql: `DELETE FROM friend_requests WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)`,
    args: [a, b, b, a],
  });
  for (const r of reqs.rows) {
    const id = String(r.id);
    await dropNotifications(String(r.to_user), requestKey(id));
    emitToUser(String(r.to_user), 'friend:requestCancelled', { requestId: id });
  }
}

/** Verwirft (still) alle Anfragen zwischen zwei Usern, z.B. Shadow-Anfragen nach dem Aufheben eines Blocks. */
export async function dropShadowRequests(a: string, b: string): Promise<void> {
  await db.execute({
    sql: `DELETE FROM friend_requests WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)`,
    args: [a, b, b, a],
  });
}

export async function dropFriendship(a: string, b: string): Promise<boolean> {
  const [x, y] = pair(a, b);
  const res = await db.execute({ sql: 'DELETE FROM friendships WHERE user_a = ? AND user_b = ?', args: [x, y] });
  if (res.rowsAffected === 0) return false;
  for (const hook of friendHooks.onRemoved) await hook(a, b);
  return true;
}

export async function removeFriend(userId: string, friendId: string): Promise<void> {
  if (!(await dropFriendship(userId, friendId))) throw new HubError('NOT_FRIENDS');
  const me = await userInfo(userId);
  emitToUser(userId, 'friend:removed', { userId: friendId });
  emitToUser(friendId, 'friend:removed', { userId });
  if (me) await notify(friendId, 'friend_removed', { userId: me.userId, username: me.username });
}

export async function listRequests(userId: string): Promise<FriendRequestsResult> {
  const now = Date.now();
  const [inc, out] = await Promise.all([
    db.execute({
      sql: `SELECT r.*, u.username AS other_name FROM friend_requests r JOIN users u ON u.id = r.from_user
            WHERE r.to_user = ? AND r.expires_at > ? AND ${VISIBLE_REQUEST} ORDER BY r.created_at DESC`,
      args: [userId, now],
    }),
    db.execute({
      sql: `SELECT r.*, u.username AS other_name FROM friend_requests r JOIN users u ON u.id = r.to_user
            WHERE r.from_user = ? AND r.expires_at > ? ORDER BY r.created_at DESC`,
      args: [userId, now],
    }),
  ]);
  const map = (rows: typeof inc.rows, otherCol: 'from_user' | 'to_user'): FriendRequestInfo[] =>
    rows.map((r) => ({
      id: String(r.id),
      user: { userId: String(r[otherCol]), username: String(r.other_name) },
      source: r.source as FriendRequestSource,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
    }));
  return { incoming: map(inc.rows, 'from_user'), outgoing: map(out.rows, 'to_user') };
}

export async function purgeExpiredRequests(): Promise<number> {
  const res = await db.execute({ sql: 'DELETE FROM friend_requests WHERE expires_at < ?', args: [Date.now()] });
  return res.rowsAffected;
}

/** Löscht alle Freundschafts-Daten eines Users (Kaskade bei Account-Löschung). Gibt die bisherigen Freunde zurück. */
export async function purgeUserFriends(userId: string): Promise<void> {
  const friends = await friendIds(userId);
  for (const f of friends) {
    if (await dropFriendship(userId, f)) emitToUser(f, 'friend:removed', { userId });
  }
  const reqs = await db.execute({
    sql: 'SELECT id, from_user, to_user FROM friend_requests WHERE from_user = ? OR to_user = ?',
    args: [userId, userId],
  });
  await db.execute({ sql: 'DELETE FROM friend_requests WHERE from_user = ? OR to_user = ?', args: [userId, userId] });
  for (const r of reqs.rows) {
    const other = String(r.from_user) === userId ? String(r.to_user) : String(r.from_user);
    await dropNotifications(other, requestKey(String(r.id)));
    emitToUser(other, 'friend:requestCancelled', { requestId: String(r.id) });
  }
}
