import { Request, Response, NextFunction } from 'express';
import { verifyTokenFresh } from './auth.service';
import type { AuthPayload } from '@ethernal/shared';

// Express Request um auth-Payload erweitern
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

/**
 * Middleware: prüft den Bearer-Token im Authorization-Header.
 * Bei Erfolg wird req.auth mit userId + username befüllt.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Nicht authentifiziert', code: 'UNAUTHENTICATED' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    req.auth = await verifyTokenFresh(token);
    next();
  } catch {
    res.status(401).json({ error: 'Token ungültig oder abgelaufen', code: 'INVALID_TOKEN' });
  }
}
