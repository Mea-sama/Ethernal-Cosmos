import type { BlockedUserInfo } from '@ethernal/shared';
import { db } from '../db/database';
import { HubError } from '../errors';
import { emitToUser } from './bus';
import { socialConfig } from './config';
import { dropFriendship, dropRequestsBetween, dropShadowRequests, userInfo } from './friends.service';

/** True, wenn einer der beiden den anderen blockiert hat (symmetrische Wirkung, Liste bleibt privat). */
export async function isBlockedEither(a: string, b: string): Promise<boolean> {
  const res = await db.execute({
    sql: 'SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)',
    args: [a, b, b, a],
  });
  return res.rows.length > 0;
}

export async function listBlocks(userId: string): Promise<BlockedUserInfo[]> {
  const res = await db.execute({
    sql: `SELECT b.blocked_id AS id, u.username, b.created_at FROM user_blocks b JOIN users u ON u.id = b.blocked_id
          WHERE b.blocker_id = ? ORDER BY u.username`,
    args: [userId],
  });
  return res.rows.map((r) => ({ userId: String(r.id), username: String(r.username), blockedAt: Number(r.created_at) }));
}

/**
 * Blockiert einen User: Freundschaft (inkl. DMs/Einladungen über die Hooks) und offene Anfragen fallen weg.
 * Der Blockierte erhält nur die Events, die er auch bei Unfriend/Abbruch bekäme.
 */
export async function blockUser(userId: string, targetId: string): Promise<BlockedUserInfo> {
  if (userId === targetId) throw new HubError('CANNOT_TARGET_SELF');
  const target = await userInfo(targetId);
  if (!target) throw new HubError('USER_NOT_FOUND');

  const existing = await db.execute({ sql: 'SELECT created_at FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', args: [userId, targetId] });
  if (existing.rows.length > 0) return { ...target, blockedAt: Number(existing.rows[0].created_at) };

  const count = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM user_blocks WHERE blocker_id = ?', args: [userId] });
  if (Number(count.rows[0].n) >= socialConfig.maxBlocks) throw new HubError('BLOCK_LIMIT_REACHED');

  const blockedAt = Date.now();
  await db.execute({ sql: 'INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)', args: [userId, targetId, blockedAt] });

  if (await dropFriendship(userId, targetId)) {
    emitToUser(userId, 'friend:removed', { userId: targetId });
    emitToUser(targetId, 'friend:removed', { userId });
  }
  await dropRequestsBetween(userId, targetId);

  const blocked: BlockedUserInfo = { ...target, blockedAt };
  return blocked;
}

export async function unblockUser(userId: string, targetId: string): Promise<void> {
  const res = await db.execute({ sql: 'DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', args: [userId, targetId] });
  if (res.rowsAffected === 0) return;
  // Während des Blocks gesendete Anfragen werden nie nachträglich zugestellt
  if (!(await isBlockedEither(userId, targetId))) await dropShadowRequests(userId, targetId);
}

/** Löscht alle Blocks, die den User betreffen (eigene und gegen ihn gerichtete) – Kaskade bei Account-Löschung. */
export async function deleteUserBlocks(userId: string): Promise<void> {
  await db.execute({ sql: 'DELETE FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?', args: [userId, userId] });
}
