import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { getGame } from '../games/game.registry';
import { issueGameServerKey, listGameServerKeys, revokeGameServerKey } from './keys.service';

/**
 * Verwaltung der Game-Server-Schlüssel. Nur aktiv, wenn ADMIN_TOKEN gesetzt ist (sonst 404).
 * Rotation: neuen Key ausstellen, Server umstellen, alten Key widerrufen.
 */
export const gameServerAdminRouter = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    res.status(404).json({ error: 'Nicht gefunden', code: 'NOT_FOUND' });
    return;
  }
  const given = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'Nicht authentifiziert', code: 'UNAUTHENTICATED' });
    return;
  }
  next();
}

gameServerAdminRouter.use(requireAdmin);

gameServerAdminRouter.post('/:gameId/keys', async (req: Request, res: Response): Promise<void> => {
  const game = getGame(String(req.params.gameId));
  if (!game) {
    res.status(404).json({ error: 'Unbekanntes Spiel', code: 'UNKNOWN_GAME' });
    return;
  }
  if ((game.serverSupport ?? 'none') === 'none') {
    res.status(403).json({ error: 'Spiel erlaubt keine Game-Server', code: 'GAME_SERVER_NOT_ALLOWED' });
    return;
  }
  const label = typeof req.body?.label === 'string' ? req.body.label : '';
  res.status(201).json(await issueGameServerKey(game.id, label));
});

gameServerAdminRouter.get('/:gameId/keys', async (req: Request, res: Response): Promise<void> => {
  res.json({ keys: await listGameServerKeys(String(req.params.gameId)) });
});

gameServerAdminRouter.delete('/keys/:id', async (req: Request, res: Response): Promise<void> => {
  const ok = await revokeGameServerKey(String(req.params.id));
  res.status(ok ? 204 : 404).send();
});
