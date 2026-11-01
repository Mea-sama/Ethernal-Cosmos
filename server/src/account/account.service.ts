import type { AccountExport, DirectMessage } from '@ethernal/shared';
import { db } from '../db/database';
import { HubError } from '../errors';
import { revokeAllRefreshTokens, terminateUserSessions, verifyPassword } from '../auth/auth.service';
import { leaveLobbyFlow } from '../lobby/lobby.socket';
import { sessionManager } from '../session/session.manager';
import { getSocialIo } from '../social/bus';
import { listBlocks } from '../social/blocks.service';
import { listFriends } from '../social/friends.service';
import { listNotifications } from '../social/notifications.service';
import { loadSettings, publicSettings } from '../social/settings.service';
import { socialConfig } from '../social/config';
import { purgeUserSocialData } from '../social/sync.service';

type AppIo = Parameters<typeof leaveLobbyFlow>[0];

/**
 * Löscht den Account samt aller Daten (DSGVO): Lobby verlassen (Host-Migration/Auflösung, Game-Server
 * erhält `player:left` mit reason `account_deleted`), Social-Daten (Freunde erhalten `friend:removed`
 * mit reason `account_deleted`), Blocks, User-/Leaderboard-Daten, Refresh-Tokens, User-Zeile, Sockets trennen.
 */
export async function deleteAccount(userId: string, password: string): Promise<void> {
  await verifyPassword(userId, password);

  const io = getSocialIo() as unknown as AppIo | undefined;
  if (io) leaveLobbyFlow(io, userId, { reason: 'account_deleted' });
  sessionManager.clearGrace(userId);

  await purgeUserSocialData(userId, { friendRemovedReason: 'account_deleted' });
  await db.execute({ sql: 'DELETE FROM user_data WHERE user_id = ?', args: [userId] });
  await db.execute({ sql: 'DELETE FROM refresh_tokens WHERE user_id = ?', args: [userId] });
  await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [userId] });
  await revokeAllRefreshTokens(userId);

  terminateUserSessions(userId);
  sessionManager.dropIfIdle(userId);
}

/** Alles, was der Hub über den User speichert (ohne private Daten anderer User). */
export async function exportAccount(userId: string): Promise<AccountExport> {
  const user = await db.execute({ sql: 'SELECT id, username, created_at FROM users WHERE id = ?', args: [userId] });
  if (user.rows.length === 0) throw new HubError('USER_NOT_FOUND');
  const u = user.rows[0];

  const data = await db.execute({
    sql: 'SELECT game_id, key, value, visibility, updated_at FROM user_data WHERE user_id = ? ORDER BY game_id, key',
    args: [userId],
  });
  const userData = data.rows.map((r) => {
    let value: unknown = r.value;
    try {
      value = JSON.parse(String(r.value));
    } catch {
      /* Rohwert behalten */
    }
    return { gameId: String(r.game_id), key: String(r.key), value, visibility: String(r.visibility), updatedAt: Number(r.updated_at) };
  });

  const dms = await db.execute({
    sql: `SELECT rowid AS seq, * FROM direct_messages WHERE (from_user = ? OR to_user = ?) AND sent_at > ? ORDER BY sent_at, rowid`,
    args: [userId, userId, Date.now() - socialConfig.dmRetentionMs],
  });
  const messages: DirectMessage[] = dms.rows.map((r) => ({
    id: String(r.id),
    seq: Number(r.seq),
    conversationId: String(r.conversation_id),
    from: String(r.from_user),
    to: String(r.to_user),
    text: String(r.text),
    sentAt: Number(r.sent_at),
    ...(r.delivered_at !== null && r.delivered_at !== undefined ? { deliveredAt: Number(r.delivered_at) } : {}),
    ...(r.read_at !== null && r.read_at !== undefined ? { readAt: Number(r.read_at) } : {}),
  }));

  const notifications = [];
  let cursor: string | undefined;
  do {
    const page = await listNotifications(userId, { limit: 100, ...(cursor ? { cursor } : {}) });
    notifications.push(...page.notifications);
    cursor = page.nextCursor;
  } while (cursor);

  const settings = await loadSettings(userId, true);
  if (!settings) throw new HubError('USER_NOT_FOUND');

  return {
    exportedAt: Date.now(),
    profile: { id: String(u.id), username: String(u.username), createdAt: Number(u.created_at) },
    userData,
    friends: await listFriends(userId),
    messages,
    notifications,
    settings: publicSettings(settings),
    blocks: await listBlocks(userId),
  };
}
