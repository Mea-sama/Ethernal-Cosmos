import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { AuthPayload, AuthResult, PublicUser } from '@ethernal/shared';
import { db } from '../db/database';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
const JWT_EXPIRES_IN = '1h';
const BCRYPT_ROUNDS = 12;
const REFRESH_TOKEN_EXPIRES_DAYS = 30;

// ─── Validierungsschemas ─────────────────────────────────────────────────────

export const RegisterSchema = z.object({
  username: z
    .string()
    .min(3, 'Mindestens 3 Zeichen')
    .max(32, 'Maximal 32 Zeichen')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Nur Buchstaben, Zahlen, - und _'),
  password: z
    .string()
    .min(8, 'Mindestens 8 Zeichen')
    .max(128, 'Maximal 128 Zeichen'),
});

export const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

// ─── Service-Funktionen ──────────────────────────────────────────────────────

export async function registerUser(
  username: string,
  password: string
): Promise<AuthResult> {
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const id = uuidv4();
  const createdAt = Date.now();

  try {
    await db.execute({
      sql: 'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
      args: [id, username, passwordHash, createdAt],
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
      throw new Error('USERNAME_TAKEN');
    }
    throw err;
  }

  const user: PublicUser = { id, username };
  const payload: AuthPayload = { userId: id, username };
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  const refreshToken = await createRefreshToken(id);

  return { user, accessToken, refreshToken };
}

export async function loginUser(
  username: string,
  password: string
): Promise<AuthResult> {
  const result = await db.execute({
    sql: 'SELECT id, username, password_hash FROM users WHERE username = ?',
    args: [username],
  });

  if (result.rows.length === 0) {
    throw new Error('INVALID_CREDENTIALS');
  }

  const row = result.rows[0];
  const valid = await bcrypt.compare(password, row.password_hash as string);
  if (!valid) {
    throw new Error('INVALID_CREDENTIALS');
  }

  const user: PublicUser = {
    id: row.id as string,
    username: row.username as string,
  };
  const payload: AuthPayload = { userId: user.id, username: user.username };
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  const refreshToken = await createRefreshToken(user.id);

  return { user, accessToken, refreshToken };
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, JWT_SECRET) as AuthPayload;
}

// ─── Refresh-Token Verwaltung ────────────────────────────────────────────────

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export async function createRefreshToken(userId: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString('hex');
  const id = uuidv4();
  const expiresAt = Date.now() + REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000;

  await db.execute({
    sql: 'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)',
    args: [id, userId, hashToken(raw), expiresAt],
  });

  return raw;
}

export async function rotateRefreshToken(rawToken: string): Promise<AuthResult> {
  const hash = hashToken(rawToken);

  const result = await db.execute({
    sql: 'SELECT id, user_id, expires_at, revoked FROM refresh_tokens WHERE token_hash = ?',
    args: [hash],
  });

  if (result.rows.length === 0) throw new Error('INVALID_REFRESH_TOKEN');

  const row = result.rows[0];
  if (row.revoked as number) throw new Error('REFRESH_TOKEN_REVOKED');
  if ((row.expires_at as number) < Date.now()) throw new Error('REFRESH_TOKEN_EXPIRED');

  // Altes Token widerrufen
  await db.execute({
    sql: 'UPDATE refresh_tokens SET revoked = 1 WHERE id = ?',
    args: [row.id],
  });

  const userResult = await db.execute({
    sql: 'SELECT id, username FROM users WHERE id = ?',
    args: [row.user_id],
  });

  if (userResult.rows.length === 0) throw new Error('USER_NOT_FOUND');
  const userRow = userResult.rows[0];

  const user: PublicUser = { id: userRow.id as string, username: userRow.username as string };
  const payload: AuthPayload = { userId: user.id, username: user.username };
  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  const refreshToken = await createRefreshToken(user.id);

  return { user, accessToken, refreshToken };
}

export async function revokeRefreshToken(rawToken: string): Promise<void> {
  const hash = hashToken(rawToken);
  await db.execute({
    sql: 'UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?',
    args: [hash],
  });
}
