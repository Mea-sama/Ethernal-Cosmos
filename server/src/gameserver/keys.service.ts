import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/database';

const hash = (raw: string): string => crypto.createHash('sha256').update(raw).digest('hex');

export interface GameServerKeyRecord {
  id: string;
  gameId: string;
  label: string;
  createdAt: number;
  revokedAt: number | null;
}

/** Stellt einen neuen Key aus. Der Klartext wird nur hier zurückgegeben und nie gespeichert. */
export async function issueGameServerKey(gameId: string, label = ''): Promise<{ id: string; key: string }> {
  const key = `esk_${crypto.randomBytes(24).toString('hex')}`;
  const id = uuidv4();
  await db.execute({
    sql: 'INSERT INTO game_server_keys (id, game_id, key_hash, label, created_at) VALUES (?, ?, ?, ?, ?)',
    args: [id, gameId, hash(key), label.slice(0, 64), Date.now()],
  });
  return { id, key };
}

export async function verifyGameServerKey(gameId: string, key: string): Promise<boolean> {
  if (typeof key !== 'string' || key.length < 16 || key.length > 200) return false;
  const res = await db.execute({
    sql: 'SELECT 1 FROM game_server_keys WHERE key_hash = ? AND game_id = ? AND revoked_at IS NULL',
    args: [hash(key), gameId],
  });
  return res.rows.length > 0;
}

export async function revokeGameServerKey(id: string): Promise<boolean> {
  const res = await db.execute({
    sql: 'UPDATE game_server_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    args: [Date.now(), id],
  });
  return res.rowsAffected > 0;
}

export async function listGameServerKeys(gameId: string): Promise<GameServerKeyRecord[]> {
  const res = await db.execute({
    sql: 'SELECT id, game_id, label, created_at, revoked_at FROM game_server_keys WHERE game_id = ? ORDER BY created_at',
    args: [gameId],
  });
  return res.rows.map((r) => ({
    id: r.id as string,
    gameId: r.game_id as string,
    label: r.label as string,
    createdAt: Number(r.created_at),
    revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
  }));
}
