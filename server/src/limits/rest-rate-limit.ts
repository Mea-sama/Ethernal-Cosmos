import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { serverLimits } from '../config/limits';
import { HubError, sendHubError } from '../errors';
import { verifyToken } from '../auth/auth.service';
import { clientIp } from './client-ip';

type RestLimitName = keyof typeof serverLimits.restRateLimits;

const windows = new Map<string, { count: number; resetAt: number }>();

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key);
}, 60_000);
sweeper.unref();

/** Festes Zeitfenster pro User (gültiges Bearer-Token) bzw. IP; Konfiguration in `limits.json` → `restRateLimits`. */
export function restRateLimit(name: RestLimitName): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rule = serverLimits.restRateLimits[name];
    let who = `ip:${clientIp(req.headers, req.socket.remoteAddress)}`;
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      try {
        who = `user:${verifyToken(header.slice(7)).userId}`;
      } catch {
        // ungültiges Token: Auth-Middleware antwortet später, Limit gilt pro IP
      }
    }
    const key = `${name}:${who}`;
    const now = Date.now();
    let w = windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + rule.windowMs };
      windows.set(key, w);
    }
    if (++w.count > rule.max) {
      sendHubError(res, new HubError('RATE_LIMITED', `Rate limit erreicht (${name})`, Math.max(1, w.resetAt - now)));
      return;
    }
    next();
  };
}
