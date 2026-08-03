import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  registerUser,
  loginUser,
  RegisterSchema,
  LoginSchema,
  rotateRefreshToken,
  revokeRefreshToken,
} from './auth.service';
import { isAuthUsernameWhitelisted, isRefreshTokenWhitelisted } from './rate-limit-whitelist';

const router = Router();

// ─── Rate Limiter ───────────────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minuten
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Zu viele Login-Versuche, bitte in 15 Minuten erneut versuchen' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 Stunde
  max: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Zu viele Registrierungsversuche, bitte später erneut versuchen' },
});

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minuten
  max: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Zu viele Token-Refresh-Anfragen' },
});

function withWhitelistBypass(
  limiter: RequestHandler,
  isWhitelisted: (req: Request) => Promise<boolean>
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (await isWhitelisted(req)) {
        next();
        return;
      }
    } catch (err) {
      console.error('[Auth] Fehler beim Prüfen der Rate-Limit-Whitelist:', err);
    }

    limiter(req, res, next);
  };
}

const registerLimiterWithWhitelist = withWhitelistBypass(registerLimiter, async (req) => {
  const username = typeof req.body?.username === 'string' ? req.body.username : '';
  return isAuthUsernameWhitelisted(username);
});

const loginLimiterWithWhitelist = withWhitelistBypass(loginLimiter, async (req) => {
  const username = typeof req.body?.username === 'string' ? req.body.username : '';
  return isAuthUsernameWhitelisted(username);
});

const refreshLimiterWithWhitelist = withWhitelistBypass(refreshLimiter, async (req) => {
  const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '';
  return isRefreshTokenWhitelisted(refreshToken);
});

// POST /auth/register
router.post('/register', registerLimiterWithWhitelist, async (req: Request, res: Response): Promise<void> => {
  const parse = RegisterSchema.safeParse(req.body);
  if (!parse.success) {
    const messages = Object.values(parse.error.flatten().fieldErrors)
      .flat()
      .join(' · ');
    res.status(400).json({ error: messages || 'Ungültige Eingabe' });
    return;
  }

  const { username, password } = parse.data;
  try {
    const result = await registerUser(username, password);
    res.status(201).json(result);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'USERNAME_TAKEN') {
      res.status(409).json({ error: 'Benutzername bereits vergeben' });
      return;
    }
    console.error('[Auth] Registrierung fehlgeschlagen:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

// POST /auth/login
router.post('/login', loginLimiterWithWhitelist, async (req: Request, res: Response): Promise<void> => {
  const parse = LoginSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
    return;
  }

  const { username, password } = parse.data;
  try {
    const result = await loginUser(username, password);
    res.json(result);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'INVALID_CREDENTIALS') {
      res.status(401).json({ error: 'Benutzername oder Passwort falsch' });
      return;
    }
    console.error('[Auth] Login fehlgeschlagen:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

// POST /auth/refresh
router.post('/refresh', refreshLimiterWithWhitelist, async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body as { refreshToken?: unknown };
  if (typeof refreshToken !== 'string' || !refreshToken) {
    res.status(400).json({ error: 'refreshToken erforderlich' });
    return;
  }

  try {
    const result = await rotateRefreshToken(refreshToken);
    res.json(result);
  } catch (err: unknown) {
    if (err instanceof Error) {
      const status =
        err.message === 'REFRESH_TOKEN_REVOKED' ||
        err.message === 'REFRESH_TOKEN_EXPIRED' ||
        err.message === 'INVALID_REFRESH_TOKEN'
          ? 401
          : 500;
      res.status(status).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

// POST /auth/logout
router.post('/logout', async (req: Request, res: Response): Promise<void> => {
  const { refreshToken } = req.body as { refreshToken?: unknown };
  if (typeof refreshToken !== 'string' || !refreshToken) {
    res.status(400).json({ error: 'refreshToken erforderlich' });
    return;
  }

  try {
    await revokeRefreshToken(refreshToken);
    res.status(204).send();
  } catch (err) {
    console.error('[Auth] Logout fehlgeschlagen:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

export { router as authRouter };
