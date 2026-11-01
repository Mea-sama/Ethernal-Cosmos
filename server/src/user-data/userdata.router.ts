import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/auth.middleware';
import { GameIdSchema, KeySchema, VisibilitySchema, BulkEntriesSchema, IncrementBodySchema, SetIfBodySchema, OpsSchema } from './userdata.schemas';
import { getGame } from '../games/game.registry';
import { HubError, isHubError, sendHubError } from '../errors';
import { setKey, getKey, deleteKey, getAllOwn, bulkSet, applyOps, getPlayerData, getLeaderboard } from './userdata.service';

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
 * Sichtbare Keys eines Spielers: selbst private/lobby/friends; Freund friends (+ lobby in gemeinsamer Lobby);
 * Lobby-Mitglied lobby; sonst 403 NOT_ALLOWED (auch für unbekannte User).
 */
playerDataRouter.get('/:playerId/data/:gameId', async (req, res): Promise<void> => {
  const gameId = GameIdSchema.safeParse(req.params.gameId);
  if (!gameId.success) { res.status(400).json({ error: 'Ungültige Spiel-ID' }); return; }

  const { playerId } = req.params;

  if (!knownGame(res, gameId.data)) return;
  try {
    res.json(await getPlayerData(req.auth!.userId, playerId, gameId.data));
  } catch (err) {
    handleError(res, '[PlayerData] GET Fehler:', err);
  }
});

// ─── Leaderboard: /leaderboard ────────────────────────────────────────────────

const leaderboardRouter = Router();
leaderboardRouter.use(requireAuth);

const LeaderboardQuerySchema = z.object({
  order:  z.enum(['asc', 'desc']).default('desc'),
  limit:  z.coerce.number().int().min(1).max(100).default(10),
  offset: z.coerce.number().int().min(0).default(0),
  me:     z.enum(['true', 'false']).default('false'),
  around: z.enum(['me']).optional(),
  range:  z.coerce.number().int().min(1).max(50).default(5),
  scope:  z.enum(['all', 'friends']).default('all'),
});

/**
 * GET /leaderboard/:gameId/:key?order=desc&limit=10&offset=0&scope=all|friends&me=true&around=me&range=5
 * Bestenliste über `public`-Schlüssel (nur Spiele mit Server-Support). Standard: Array mit `rank`;
 * mit `me=true` oder `around=me`: `{ entries, me, total }`. Ungültige Parameter → 400 INVALID_INPUT.
 */
leaderboardRouter.get('/:gameId/:key', async (req, res): Promise<void> => {
  const gameId = GameIdSchema.safeParse(req.params.gameId);
  const key    = KeySchema.safeParse(req.params.key);
  if (!gameId.success || !key.success) { res.status(400).json({ error: 'Ungültige Parameter' }); return; }
  const q = LeaderboardQuerySchema.safeParse(req.query);
  if (!q.success) { sendHubError(res, new HubError('INVALID_INPUT')); return; }

  try {
    const wantsMe = q.data.me === 'true' || q.data.around === 'me';
    const result = await getLeaderboard(gameId.data, key.data, {
      order: q.data.order, limit: q.data.limit, offset: q.data.offset, range: q.data.range,
      scope: q.data.scope, me: q.data.me === 'true', around: q.data.around === 'me', userId: req.auth!.userId,
    });
    res.json(wantsMe ? result : result.entries);
  } catch (err) {
    handleError(res, '[Leaderboard] GET Fehler:', err);
  }
});

export { userDataRouter, playerDataRouter, leaderboardRouter };

