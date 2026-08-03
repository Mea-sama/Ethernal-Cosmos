import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';

interface WhitelistEntry {
  userId: string;
  username?: string;
}

interface WhitelistConfig {
  accounts: WhitelistEntry[];
}

const CONFIG_PATH = path.resolve(__dirname, '../../config/rate-limit-whitelist.json');

function loadWhitelist(): WhitelistConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return { accounts: [] };
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WhitelistConfig>;
    const accounts = Array.isArray(parsed.accounts)
      ? parsed.accounts.filter((a): a is WhitelistEntry => !!a && typeof a.userId === 'string' && a.userId.length > 0)
      : [];
    return { accounts };
  } catch (err) {
    console.error('[Auth] Konnte rate-limit-whitelist.json nicht laden:', err);
    return { accounts: [] };
  }
}

export function isUserIdWhitelisted(userId: string): boolean {
  if (!userId) return false;
  const config = loadWhitelist();
  return config.accounts.some((entry) => entry.userId === userId);
}

export function isUsernameWhitelisted(username: string): boolean {
  if (!username) return false;
  const config = loadWhitelist();
  return config.accounts.some((entry) => entry.username === username);
}

export async function isAuthUsernameWhitelisted(username: string): Promise<boolean> {
  if (!username) return false;

  if (isUsernameWhitelisted(username)) {
    return true;
  }

  const result = await db.execute({
    sql: 'SELECT id FROM users WHERE username = ?',
    args: [username],
  });

  if (result.rows.length === 0) return false;
  return isUserIdWhitelisted(result.rows[0].id as string);
}

export async function isRefreshTokenWhitelisted(refreshToken: string): Promise<boolean> {
  if (!refreshToken) return false;

  const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const result = await db.execute({
    sql: 'SELECT user_id FROM refresh_tokens WHERE token_hash = ? LIMIT 1',
    args: [tokenHash],
  });

  if (result.rows.length === 0) return false;
  return isUserIdWhitelisted(result.rows[0].user_id as string);
}
