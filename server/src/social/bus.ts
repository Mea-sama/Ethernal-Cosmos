import type { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents, SocketData } from '@ethernal/shared';
import { serverLimits } from '../config/limits';
import { HubError } from '../errors';
import { userRoom } from '../session/session.manager';

export type SocialServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

let ioRef: SocialServer | undefined;

export function setSocialIo(io: SocialServer): void {
  ioRef = io;
}

export function getSocialIo(): SocialServer | undefined {
  return ioRef;
}

/** Sendet ein Event an alle Sessions eines Users (no-op, wenn der Socket-Server noch nicht gesetzt ist). */
export function emitToUser(userId: string, event: string, payload: unknown): void {
  (ioRef?.to(userRoom(userId)) as unknown as { emit(e: string, p: unknown): void } | undefined)?.emit(event, payload);
}

// ─── Rate-Limit pro User (gilt gemeinsam für Socket und REST) ─────────────────

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Map<string, Bucket>>();

export function assertUserLimit(userId: string, key: string): void {
  const rule = serverLimits.socketLimits[key];
  if (!rule) throw new Error(`Kein Rate-Limit für "${key}" konfiguriert`);
  const now = Date.now();
  const perUser = buckets.get(userId) ?? new Map<string, Bucket>();
  const bucket = perUser.get(key) ?? { tokens: rule.burst, lastRefill: now };
  bucket.tokens = Math.min(rule.burst, bucket.tokens + Math.max(0, (now - bucket.lastRefill) / 1000) * rule.refillPerSecond);
  bucket.lastRefill = now;
  perUser.set(key, bucket);
  buckets.set(userId, perUser);
  if (bucket.tokens < 1) {
    const wait = Math.ceil(((1 - bucket.tokens) / rule.refillPerSecond) * 1000);
    throw new HubError('RATE_LIMITED', `Rate limit erreicht (${key})`, wait);
  }
  bucket.tokens -= 1;
}

/** Räumt Buckets inaktiver User auf (aus dem Scheduler). */
export function pruneLimitBuckets(): void {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [userId, perUser] of buckets) {
    for (const [key, b] of perUser) if (b.lastRefill < cutoff) perUser.delete(key);
    if (perUser.size === 0) buckets.delete(userId);
  }
}
