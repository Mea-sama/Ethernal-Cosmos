import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/auth.middleware';
import { lobbyManager } from '../lobby/lobby.manager';
import { GameIdSchema, KeySchema, VisibilitySchema, BulkEntriesSchema, IncrementBodySchema, SetIfBodySchema, OpsSchema } from './userdata.schemas';
import { getGame } from '../games/game.registry';
import { HubError, isHubError, sendHubError } from '../errors';
import { setKey, getKey, deleteKey, getAllOwn, bulkSet, applyOps, getVisibleData, getLeaderboard } from './userdata.service';

function handleError(res: import('express').Response, tag: string, err: unknown): void {
  if (isHubError(err)) {
    sendHubError(res, err);
    return;
  }
  console.error(tag, err);
  sendHubError(res, new HubError('INTERNAL'));
}

function knownGame(res: import('express').Response, gameId: string): boolean {
  if (getGame(gameId)) return true;
  sendHubError(res, new HubError('UNKNOWN_GAME'));
  return false;
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const SetKeyBodySchema = z.object({
  value: z.unknown(),
  visibility: VisibilitySchema.optional(),
});

const BulkSetBodySchema = BulkEntriesSchema;

// ─── Eigene Daten: /userdata ──────────────────────────────────────────────────

const userDataRouter = Router();
userDataRouter.use(requireAuth);

/** GET /userdata/:gameId — alle eigenen Keys */
userDataRouter.get('/:gameId', async (req, res): Promise<void> => {
  const parse = GameIdSchema.safeParse(req.params.gameId);
  if (!parse.success) { res.status(400).json({ error: 'Ungültige Spiel-ID' }); return; }
  if (!knownGame(res, parse.data)) return;
  try {
    res.json(await getAllOwn(req.auth!.userId, parse.data));
  } catch (err) {
    handleError(res, '[UserData] GET /:gameId Fehler:', err);
  }
});

/** GET /userdata/:gameId/:key — einzelner Key */
userDataRouter.get('/:gameId/:key', async (req, res): Promise<void> => {
  const gameId = GameIdSchema.safeParse(req.params.gameId);
  const key    = KeySchema.safeParse(req.params.key);
  if (!gameId.success || !key.success) { res.status(400).json({ error: 'Ungültige Parameter' }); return; }
  if (!knownGame(res, gameId.data)) return;
  try {
    const entry = await getKey(req.auth!.userId, gameId.data, key.data);
    if (!entry) { sendHubError(res, new HubError('DATA_KEY_NOT_FOUND')); return; }
    res.json(entry);
  } catch (err) {
    handleError(res, '[UserData] GET /:gameId/:key Fehler:', err);
  }
});

/** PUT /userdata/:gameId/:key — Key setzen { value, visibility? } */
userDataRouter.put('/:gameId/:key', async (req, res): Promise<void> => {
  const gameId = GameIdSchema.safeParse(req.params.gameId);
  const key    = KeySchema.safeParse(req.params.key);
  const body   = SetKeyBodySchema.safeParse(req.body);
  if (!gameId.success || !key.success) { res.status(400).json({ error: 'Ungültige Parameter' }); return; }
  if (!body.success) { sendHubError(res, new HubError('INVALID_INPUT')); return; }
  try {
    await setKey(req.auth!.userId, gameId.data, key.data, body.data.value, body.data.visibility);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, '[UserData] PUT /:gameId/:key Fehler:', err);
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
    handleError(res, '[UserData] DELETE /:gameId/:key Fehler:', err);
  }
});

/** PATCH /userdata/:gameId — Bulk-Set [{ key, value, visibility? }, ...] */
userDataRouter.patch('/:gameId', async (req, res): Promise<void> => {
  const gameId = GameIdSchema.safeParse(req.params.gameId);
  if (!gameId.success) { res.status(400).json({ error: 'Ungültige Spiel-ID' }); return; }
  const body = BulkSetBodySchema.safeParse(req.body);
  if (!body.success) { sendHubError(res, new HubError('INVALID_INPUT')); return; }
  try {
    await bulkSet(req.auth!.userId, gameId.data, body.data as Array<{ key: string; value: unknown; visibility?: 'private' | 'lobby' | 'public' }>);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, '[UserData] PATCH /:gameId Fehler:', err);
  }
});

/** POST /userdata/:gameId/:key/increment — atomar erhöhen { by, visibility? } → { key, value, version } */
userDataRouter.post('/:gameId/:key/increment', async (req, res): Promise<void> => {
  const gameId = GameIdSchema.safeParse(req.params.gameId);
  const key    = KeySchema.safeParse(req.params.key);
  const body   = IncrementBodySchema.safeParse(req.body);
  if (!gameId.success || !key.success) { res.status(400).json({ error: 'Ungültige Parameter' }); return; }
  if (!body.success) { sendHubError(res, new HubError('INVALID_INPUT')); return; }
  try {
    const [result] = await applyOps(req.auth!.userId, gameId.data, [{ op: 'increment', key: key.data, by: body.data.by, visibility: body.data.visibility }]);
    res.json(result);
  } catch (err) {
    handleError(res, '[UserData] POST increment Fehler:', err);
  }
});

/** POST /userdata/:gameId/:key/setIf — Compare-and-set { value, expectedVersion, visibility? } → { key, value, version } | 409 VERSION_CONFLICT */
userDataRouter.post('/:gameId/:key/setIf', async (req, res): Promise<void> => {
  const gameId = GameIdSchema.safeParse(req.params.gameId);
  const key    = KeySchema.safeParse(req.params.key);
  const body   = SetIfBodySchema.safeParse(req.body);
  if (!gameId.success || !key.success) { res.status(400).json({ error: 'Ungültige Parameter' }); return; }
  if (!body.success) { sendHubError(res, new HubError('INVALID_INPUT')); return; }
  try {
    const [result] = await applyOps(req.auth!.userId, gameId.data, [
      { op: 'setIf', key: key.data, value: body.data.value, expectedVersion: body.data.expectedVersion, visibility: body.data.visibility },
    ]);
    res.json(result);
  } catch (err) {
    handleError(res, '[UserData] POST setIf Fehler:', err);
  }
});

/** POST /userdata/:gameId/transact — { ops: [...] } alles oder nichts → { results } */
userDataRouter.post('/:gameId/transact', async (req, res): Promise<void> => {
  const gameId = GameIdSchema.safeParse(req.params.gameId);
  if (!gameId.success) { res.status(400).json({ error: 'Ungültige Spiel-ID' }); return; }
  const body = z.object({ ops: OpsSchema }).safeParse(req.body);
  if (!body.success) { sendHubError(res, new HubError('INVALID_INPUT')); return; }
  try {
    res.json({ results: await applyOps(req.auth!.userId, gameId.data, body.data.ops) });
  } catch (err) {
    handleError(res, '[UserData] POST transact Fehler:', err);
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

  if (!knownGame(res, gameId.data)) return;
  try {
    res.json(await getVisibleData(playerId, gameId.data, inSameLobby));
  } catch (err) {
    handleError(res, '[PlayerData] GET Fehler:', err);
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
    handleError(res, '[Leaderboard] GET Fehler:', err);
  }
});

export { userDataRouter, playerDataRouter, leaderboardRouter };

