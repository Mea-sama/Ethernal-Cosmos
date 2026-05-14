import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/auth.middleware';
import { lobbyManager } from '../lobby/lobby.manager';
import { setKey, getKey, deleteKey, getAllOwn, bulkSet, getVisibleData, getLeaderboard } from './userdata.service';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const GameIdSchema = z.string().min(1).max(32).regex(/^[a-z0-9-]+$/);
const KeySchema    = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/);
const VisibilitySchema = z.enum(['private', 'lobby', 'public']);

const SetKeyBodySchema = z.object({
  value: z.unknown(),
  visibility: VisibilitySchema.optional(),
});

const BulkSetBodySchema = z
  .array(z.object({ key: KeySchema, value: z.any(), visibility: VisibilitySchema.optional() }))
  .min(1)
  .max(100);

// ─── Eigene Daten: /userdata ──────────────────────────────────────────────────

const userDataRouter = Router();
userDataRouter.use(requireAuth);

/** GET /userdata/:gameId — alle eigenen Keys */
userDataRouter.get('/:gameId', async (req, res): Promise<void> => {
  const parse = GameIdSchema.safeParse(req.params.gameId);
  if (!parse.success) { res.status(400).json({ error: 'Ungültige Spiel-ID' }); return; }
  try {
    res.json(await getAllOwn(req.auth!.userId, parse.data));
  } catch (err) {
    console.error('[UserData] GET /:gameId Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

/** GET /userdata/:gameId/:key — einzelner Key */
userDataRouter.get('/:gameId/:key', async (req, res): Promise<void> => {
  const gameId = GameIdSchema.safeParse(req.params.gameId);
  const key    = KeySchema.safeParse(req.params.key);
  if (!gameId.success || !key.success) { res.status(400).json({ error: 'Ungültige Parameter' }); return; }
  try {
    const entry = await getKey(req.auth!.userId, gameId.data, key.data);
    if (!entry) { res.status(404).json({ error: 'Key nicht gefunden' }); return; }
    res.json(entry);
  } catch (err) {
    console.error('[UserData] GET /:gameId/:key Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

/** PUT /userdata/:gameId/:key — Key setzen { value, visibility? } */
userDataRouter.put('/:gameId/:key', async (req, res): Promise<void> => {
  const gameId = GameIdSchema.safeParse(req.params.gameId);
  const key    = KeySchema.safeParse(req.params.key);
  const body   = SetKeyBodySchema.safeParse(req.body);
  if (!gameId.success || !key.success) { res.status(400).json({ error: 'Ungültige Parameter' }); return; }
  if (!body.success) { res.status(400).json({ error: body.error.flatten() }); return; }
  try {
    await setKey(req.auth!.userId, gameId.data, key.data, body.data.value, body.data.visibility);
    res.json({ ok: true });
  } catch (err) {
    console.error('[UserData] PUT /:gameId/:key Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

/** DELETE /userdata/:gameId/:key — Key löschen */
userDataRouter.delete('/:gameId/:key', async (req, res): Promise<void> => {
  const gameId = GameIdSchema.safeParse(req.params.gameId);
  const key    = KeySchema.safeParse(req.params.key);
  if (!gameId.success || !key.success) { res.status(400).json({ error: 'Ungültige Parameter' }); return; }
  try {
    await deleteKey(req.auth!.userId, gameId.data, key.data);
    res.status(204).send();
  } catch (err) {
    console.error('[UserData] DELETE /:gameId/:key Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

/** PATCH /userdata/:gameId — Bulk-Set [{ key, value, visibility? }, ...] */
userDataRouter.patch('/:gameId', async (req, res): Promise<void> => {
  const gameId = GameIdSchema.safeParse(req.params.gameId);
  if (!gameId.success) { res.status(400).json({ error: 'Ungültige Spiel-ID' }); return; }
  const body = BulkSetBodySchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.flatten() }); return; }
  try {
    await bulkSet(req.auth!.userId, gameId.data, body.data as Array<{ key: string; value: unknown; visibility?: 'private' | 'lobby' | 'public' }>);
    res.json({ ok: true });
  } catch (err) {
    console.error('[UserData] PATCH /:gameId Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

// ─── Andere Spieler: /players ─────────────────────────────────────────────────

const playerDataRouter = Router();
playerDataRouter.use(requireAuth);

/**
 * GET /players/:playerId/data/:gameId
 * Gibt die sichtbaren Keys eines anderen Spielers zurück.
 * Lobby-Keys nur sichtbar wenn Requester + Target in derselben aktiven Lobby.
 */
playerDataRouter.get('/:playerId/data/:gameId', async (req, res): Promise<void> => {
  const gameId = GameIdSchema.safeParse(req.params.gameId);
  if (!gameId.success) { res.status(400).json({ error: 'Ungültige Spiel-ID' }); return; }

  const requesterId    = req.auth!.userId;
  const { playerId }   = req.params;
  const requesterLobby = lobbyManager.getLobbyByUserId(requesterId);
  const targetLobby    = lobbyManager.getLobbyByUserId(playerId);
  const inSameLobby    = !!(requesterLobby && targetLobby && requesterLobby.id === targetLobby.id);

  try {
    res.json(await getVisibleData(playerId, gameId.data, inSameLobby));
  } catch (err) {
    console.error('[PlayerData] GET Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

// ─── Leaderboard: /leaderboard ────────────────────────────────────────────────

const leaderboardRouter = Router();
leaderboardRouter.use(requireAuth);

/**
 * GET /leaderboard/:gameId/:key?order=desc&limit=10
 * Top-N Spieler nach dem angegebenen Key (nur public-Daten, numerisch sortiert).
 */
leaderboardRouter.get('/:gameId/:key', async (req, res): Promise<void> => {
  const gameId = GameIdSchema.safeParse(req.params.gameId);
  const key    = KeySchema.safeParse(req.params.key);
  if (!gameId.success || !key.success) { res.status(400).json({ error: 'Ungültige Parameter' }); return; }

  const orderParse = z.enum(['asc', 'desc']).safeParse(req.query.order ?? 'desc');
  const order      = orderParse.success ? orderParse.data : 'desc';
  const limitParse = z.coerce.number().int().min(1).max(100).safeParse(req.query.limit ?? '10');
  const limit      = limitParse.success ? limitParse.data : 10;

  try {
    res.json(await getLeaderboard(gameId.data, key.data, order, limit));
  } catch (err) {
    console.error('[Leaderboard] GET Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

export { userDataRouter, playerDataRouter, leaderboardRouter };

