import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { verifyToken, setSessionTerminator } from '../auth/auth.service';
import { lobbyManager } from './lobby.manager';
import { getGame } from '../games/game.registry';
import { instanceManager } from '../games/instance.manager';
import { bulkSet, deleteKey, getAllOwn, getVisibleData, writeEntries } from '../user-data/userdata.service';
import { GameIdSchema, KeySchema, VisibilitySchema, BulkEntriesSchema } from '../user-data/userdata.schemas';
import { serverLimits } from '../config/limits';
import { HubError, isHubError } from '../errors';
import { sessionManager, userRoom, gameRoom } from '../session/session.manager';
import { presenceChanged } from '../social/presence.service';
import { gsHooks } from '../gameserver/hooks';
import { bindGameServer, releaseServerSlot } from '../gameserver/gameserver.socket';
import {
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type SocketData,
  type IpcGameToHub,
  type Lobby,
  type GameInfo,
  type LobbyChangeReason,
  type JoinRequestRejectReason,
  type HelloPayload,
} from '@ethernal/shared';

export type AppServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

// ─── Rate Limiting ────────────────────────────────────────────────────────────

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

interface LimitRule {
  refillPerSecond: number;
  burst: number;
}

const SOCKET_LIMITS: Record<string, LimitRule> = serverLimits.socketLimits;
const LOBBY_LIMITS: Record<string, LimitRule> = serverLimits.lobbyLimits;
const MAX_BINARY_PAYLOAD_BYTES = serverLimits.binary.maxPayloadBytes;

const socketBuckets = new Map<string, Map<string, TokenBucket>>();
const lobbyBuckets = new Map<string, Map<string, TokenBucket>>();
const lastRateLimitNotice = new Map<string, number>();
const RATE_NOTICE_COOLDOWN_MS = serverLimits.rateLimitNoticeCooldownMs;

/** Gibt 0 zurück wenn erlaubt, sonst die Wartezeit in ms bis zum nächsten freien Token. */
function consumeBucket(
  bucketMap: Map<string, Map<string, TokenBucket>>,
  entityId: string,
  key: string,
  rule: LimitRule,
): number {
  const now = Date.now();
  const entityBuckets = bucketMap.get(entityId) ?? new Map<string, TokenBucket>();
  const bucket = entityBuckets.get(key) ?? { tokens: rule.burst, lastRefill: now };

  const elapsedSeconds = Math.max(0, (now - bucket.lastRefill) / 1000);
  bucket.tokens = Math.min(rule.burst, bucket.tokens + elapsedSeconds * rule.refillPerSecond);
  bucket.lastRefill = now;
  entityBuckets.set(key, bucket);
  bucketMap.set(entityId, entityBuckets);

  if (bucket.tokens < 1) {
    return rule.refillPerSecond > 0 ? Math.ceil(((1 - bucket.tokens) / rule.refillPerSecond) * 1000) : 60_000;
  }
  bucket.tokens -= 1;
  return 0;
}

function assertSocketLimit(socketId: string, key: string): void {
  const rule = SOCKET_LIMITS[key];
  if (!rule) throw new Error(`Kein Rate-Limit für "${key}" konfiguriert`);
  const wait = consumeBucket(socketBuckets, socketId, key, rule);
  if (wait > 0) throw new HubError('RATE_LIMITED', `Rate limit erreicht (${key})`, wait);
}

function assertLobbyLimit(lobbyId: string, key: string): void {
  const rule = LOBBY_LIMITS[key];
  if (!rule) throw new Error(`Kein Lobby-Rate-Limit für "${key}" konfiguriert`);
  const wait = consumeBucket(lobbyBuckets, lobbyId, key, rule);
  if (wait > 0) throw new HubError('RATE_LIMITED', `Rate limit erreicht (${key}:lobby)`, wait);
}

// ─── Handler-Wrapper: Rate-Limit → Handler → Ack / Fehler ─────────────────────

interface HandleOptions {
  /** Key in socketLimits */
  limit: string;
  /** Fehler ohne Ack nicht als Legacy-`error`/`errorDetail`-Event senden (für hochfrequente Events) */
  quiet?: boolean;
  /** Rate-Limit pro User statt pro Socket (mehrere Sessions vervielfachen das Kontingent nicht) */
  perUser?: boolean;
}

type AnyAck = (result: unknown) => void;

/**
 * Registriert einen Event-Handler mit einheitlicher Fehlerbehandlung:
 * - letztes Argument, falls Funktion, ist der Ack-Callback → `{ ok: true, ... }` bzw. `{ ok: false, error }`
 * - ohne Ack gehen Fehler als `error` (Legacy-Text) und `errorDetail` (strukturiert) an den Socket
 */
function handle(
  socket: AppSocket,
  event: string,
  opts: HandleOptions,
  fn: (data: any) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void,
): void {
  if (!SOCKET_LIMITS[opts.limit]) throw new Error(`Kein Rate-Limit für "${opts.limit}" konfiguriert`);
  (socket as unknown as { on(e: string, l: (...a: unknown[]) => void): void }).on(event, async (...args: unknown[]) => {
    const ack = typeof args[args.length - 1] === 'function' ? (args.pop() as AnyAck) : undefined;
    const data = args[0];
    const requestId =
      data && typeof data === 'object' && typeof (data as { requestId?: unknown }).requestId === 'string'
        ? ((data as { requestId: string }).requestId.slice(0, 64))
        : undefined;
    try {
      assertSocketLimit(opts.perUser ? socket.data.userId : socket.id, opts.limit);
      const result = await fn(data);
      ack?.({ ok: true, ...(result ?? {}) });
    } catch (err) {
      let hubErr: HubError;
      if (isHubError(err)) {
        hubErr = err;
      } else {
        console.error(`[Socket] ${event} Fehler:`, err);
        hubErr = new HubError('INTERNAL');
      }
      const payload = hubErr.toPayload({ event, requestId });
      if (ack) {
        ack({ ok: false, error: payload });
        return;
      }
      if (opts.quiet) return;
      if (hubErr.code === 'RATE_LIMITED') {
        const key = `${socket.id}:${event}`;
        const now = Date.now();
        if (now - (lastRateLimitNotice.get(key) ?? 0) < RATE_NOTICE_COOLDOWN_MS) return;
        lastRateLimitNotice.set(key, now);
      }
      socket.emit('error', hubErr.message);
      socket.emit('errorDetail', payload);
    }
  });
}

// ─── Hilfsfunktionen: Binary ──────────────────────────────────────────────────

function asBinaryPayload(payload: unknown): Uint8Array | null {
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (typeof payload === 'string') {
    try {
      return Buffer.from(payload, 'base64');
    } catch {
      return null;
    }
  }
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  return null;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MESSAGE_TYPE_RE = /^[A-Za-z0-9_.:\-]{1,64}$/;
const MAX_BINARY_HARD_CAP = 64 * 1024;

function maxBinaryBytesFor(userId: string): number {
  const override = getGame(sessionManager.getGameId(userId) ?? '')?.maxBinaryBytes;
  return override && override > 0 ? Math.min(override, MAX_BINARY_HARD_CAP) : MAX_BINARY_PAYLOAD_BYTES;
}

export function validateMessageType(type: unknown): string {
  if (typeof type !== 'string' || !MESSAGE_TYPE_RE.test(type)) {
    throw new HubError('INVALID_MESSAGE_TYPE', 'Ungültiger Nachrichtentyp (1–64 Zeichen: A-Z a-z 0-9 _ . : -)');
  }
  return type;
}

export function validateJsonPayloadSize(payload: unknown): void {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(payload ?? null));
  } catch {
    throw new HubError('INVALID_INPUT', 'Payload nicht serialisierbar');
  }
  if (size > serverLimits.maxJsonPayloadBytes) {
    throw new HubError('PAYLOAD_TOO_LARGE', `Payload zu groß (max ${serverLimits.maxJsonPayloadBytes} Bytes)`);
  }
}

function validateBinaryRelayInput(data: { typeCode: number; payload: unknown }, maxBytes = MAX_BINARY_PAYLOAD_BYTES): { typeCode: number; payload: Uint8Array } {
  if (!Number.isInteger(data?.typeCode) || data.typeCode < 0 || data.typeCode > 65535) {
    throw new HubError('INVALID_BINARY_TYPECODE');
  }
  // Länge vor dem Dekodieren prüfen und ungültiges Base64 explizit ablehnen
  if (typeof data.payload === 'string') {
    if (data.payload.length > Math.ceil((maxBytes * 4) / 3) + 4) {
      throw new HubError('BINARY_PAYLOAD_TOO_LARGE', `Binary-Payload zu groß (max ${maxBytes} Bytes)`);
    }
    if (data.payload.length % 4 !== 0 || !BASE64_RE.test(data.payload)) throw new HubError('INVALID_BINARY_PAYLOAD');
  }
  const payload = asBinaryPayload(data.payload);
  if (!payload) throw new HubError('INVALID_BINARY_PAYLOAD');
  if (payload.byteLength > maxBytes) {
    throw new HubError('BINARY_PAYLOAD_TOO_LARGE', `Binary-Payload zu groß (max ${maxBytes} Bytes)`);
  }
  return { typeCode: data.typeCode, payload };
}

// ─── Hilfsfunktionen: Session-/Lobby-Kontext ──────────────────────────────────

function requireGame(userId: string): GameInfo {
  const gameId = sessionManager.getGameId(userId);
  if (!gameId) throw new HubError('GAME_NOT_REGISTERED');
  const game = getGame(gameId);
  if (!game) throw new HubError('UNKNOWN_GAME');
  return game;
}

function requireLobby(userId: string): Lobby {
  const lobby = lobbyManager.getLobbyByUserId(userId);
  if (!lobby) throw new HubError('NOT_IN_LOBBY');
  return lobby;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Lobby für Nicht-Mitglieder (Listen): ohne Invite-Code, Settings ggf. auf publicSettingKeys reduziert. */
export function toListing(lobby: Lobby): Lobby {
  const game = getGame(lobby.gameId);
  const keys = game?.publicSettingKeys;
  const settings = keys
    ? Object.fromEntries(Object.entries(lobby.settings).filter(([k]) => keys.includes(k)))
    : lobby.settings;
  const joinable = lobby.status === 'open' || (lobby.status === 'in_progress' && !!game?.joinInProgress);
  return { ...lobby, inviteCode: undefined, settings, joinable, server: undefined, serverBound: !!lobby.server, region: lobby.server?.region };
}

export function jsonDepth(value: unknown, depth = 0): number {
  if (depth > 16 || value === null || typeof value !== 'object') return depth;
  let max = depth;
  for (const v of Object.values(value as Record<string, unknown>)) max = Math.max(max, jsonDepth(v, depth + 1));
  return max;
}

const CreateLobbySchema = z.object({
  name: z.string().trim().min(1).max(64),
  isPrivate: z.boolean().optional().default(false),
  settings: z.record(z.unknown()).optional().default({}),
  serverPreference: z
    .object({ mode: z.enum(['any', 'none']).optional(), region: z.string().max(32).optional() })
    .optional(),
});

const InviteCodeSchema = z.string().trim().length(6).transform((c) => c.toUpperCase());

function parseInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, data: unknown, err: HubError = new HubError('INVALID_INPUT')): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw err;
  return parsed.data;
}

// ─── Presence (abgeleitet aus Session- und Lobby-Zustand) ─────────────────────

/** Presence geht nur noch an Freunde (siehe social/presence.service.ts) — kein globaler Broadcast. */
function broadcastPresence(_io: AppServer, userId: string): void {
  presenceChanged(userId);
}

export function broadcastLobbyChange(io: AppServer, lobby: Lobby, reason?: LobbyChangeReason): void {
  io.to(lobby.id).emit('lobbyUpdated', lobby, reason);
  gsHooks.lobbyUpdated(lobby, reason);
  if (lobby.status === 'closed') gsHooks.lobbyClosed(lobby.id, lobby.server?.serverId, 'closed');
  for (const p of lobby.players) broadcastPresence(io, p.userId);
}

// ─── Beitrittsanfragen für gesperrte Lobbys ───────────────────────────────────

// lobbyId → (requesterId → ausstehende Anfrage mit Auto-Reject-Timer)
const joinRequests = new Map<string, Map<string, { username: string; viaCode: boolean; timer: NodeJS.Timeout }>>();
const JOIN_REQUEST_TIMEOUT_MS = serverLimits.joinRequestTimeoutMs;

function clearJoinRequest(lobbyId: string, requesterId: string): void {
  const reqs = joinRequests.get(lobbyId);
  const entry = reqs?.get(requesterId);
  if (!entry) return;
  clearTimeout(entry.timer);
  reqs!.delete(requesterId);
  if (reqs!.size === 0) joinRequests.delete(lobbyId);
}

/** Bricht alle offenen Anfragen einer Lobby ab (Host gewechselt oder Lobby geschlossen). */
function rejectAllJoinRequests(io: AppServer, lobbyId: string, reason: JoinRequestRejectReason): void {
  const reqs = joinRequests.get(lobbyId);
  if (!reqs) return;
  for (const requesterId of [...reqs.keys()]) {
    clearJoinRequest(lobbyId, requesterId);
    io.to(userRoom(requesterId)).emit('joinRequestRejected', { lobbyId, reason });
  }
}

/** Entfernt alle offenen Anfragen eines Users (z.B. bei Disconnect) und informiert die jeweiligen Hosts. */
function withdrawAllRequestsFor(
  io: AppServer,
  requesterId: string,
  reason: 'cancelled' | 'timeout',
  opts: { exceptLobbyId?: string; notifyRequester?: boolean } = {},
): void {
  for (const [lobbyId, reqs] of [...joinRequests.entries()]) {
    if (!reqs.has(requesterId) || lobbyId === opts.exceptLobbyId) continue;
    clearJoinRequest(lobbyId, requesterId);
    if (opts.notifyRequester) io.to(userRoom(requesterId)).emit('joinRequestRejected', { lobbyId, reason: 'superseded' });
    const lobby = lobbyManager.getLobby(lobbyId);
    if (lobby) io.to(userRoom(lobby.hostId)).emit('joinRequestWithdrawn', { requesterId, reason });
  }
}

/** Stellt dem (neuen) Host alle offenen Beitrittsanfragen zu — nach Host-Wechsel oder Reconnect. */
function redeliverJoinRequests(target: { emit: (...a: any[]) => unknown }, lobbyId: string): void {
  for (const [requesterId, entry] of joinRequests.get(lobbyId) ?? []) {
    target.emit('joinRequestReceived', { lobbyId, requesterId, username: entry.username });
  }
}

// ─── Relay: Reihenfolge & Pufferung für Mitglieder in der Reconnect-Gnadenfrist ─

const relaySeq = new Map<string, number>();
export function nextSeq(lobbyId: string): number {
  const n = (relaySeq.get(lobbyId) ?? 0) + 1;
  relaySeq.set(lobbyId, n);
  return n;
}

const GRACE_BUFFER_MAX = 50;
const GRACE_BUFFER_MAX_AGE_MS = 30_000;
const graceBuffers = new Map<string, Array<{ at: number; event: 'message' | 'messageBinary'; msg: unknown }>>();

/** Lobby-Broadcasts für getrennte Mitglieder kurz puffern (begrenzt) und beim Resume nachliefern. */
function bufferForGrace(lobby: Lobby, senderId: string, event: 'message' | 'messageBinary', msg: unknown): void {
  const now = Date.now();
  for (const p of lobby.players) {
    if (p.userId === senderId || p.connected !== false) continue;
    const buf = (graceBuffers.get(p.userId) ?? []).filter((e) => now - e.at <= GRACE_BUFFER_MAX_AGE_MS);
    buf.push({ at: now, event, msg });
    if (buf.length > GRACE_BUFFER_MAX) buf.shift();
    graceBuffers.set(p.userId, buf);
  }
}

function replayBuffered(socket: AppSocket, lobbyId: string): void {
  const buf = graceBuffers.get(socket.data.userId);
  graceBuffers.delete(socket.data.userId);
  if (!buf || lobbyManager.getLobbyByUserId(socket.data.userId)?.id !== lobbyId) return;
  const now = Date.now();
  for (const e of buf) {
    if (now - e.at <= GRACE_BUFFER_MAX_AGE_MS) (socket as unknown as { emit: (...a: unknown[]) => void }).emit(e.event, e.msg);
  }
}

// ─── Geschlossene Lobbys: automatische Freigabe der Mitglieder ─────────────────

const closedReleaseTimers = new Map<string, NodeJS.Timeout>();

export function scheduleClosedRelease(io: AppServer, lobbyId: string): void {
  if (closedReleaseTimers.has(lobbyId)) return;
  const timer = setTimeout(() => {
    closedReleaseTimers.delete(lobbyId);
    const lobby = lobbyManager.getLobby(lobbyId);
    if (!lobby || lobby.status !== 'closed') return;
    for (const p of [...lobby.players]) {
      leaveLobbyFlow(io, p.userId, { notifyInstance: false });
      sessionManager.dropIfIdle(p.userId);
    }
  }, serverLimits.closedLobbyTtlMs);
  timer.unref();
  closedReleaseTimers.set(lobbyId, timer);
}

// ─── Lobby verlassen (gemeinsamer Pfad für Leave, Disconnect-Ablauf, Kick) ────

export function leaveLobbyFlow(io: AppServer, userId: string, opts: { notifyInstance?: boolean; reason?: 'left' | 'kicked' | 'timeout' } = {}): void {
  sessionManager.clearGrace(userId);
  const serverId = lobbyManager.getLobbyByUserId(userId)?.server?.serverId;
  const { lobby, dissolved, lobbyId, hostChanged, evicted } = lobbyManager.leaveLobby(userId);
  if (!lobbyId) return;
  gsHooks.playerLeft(lobbyId, serverId, userId, opts.reason ?? 'left');

  io.in(userRoom(userId)).socketsLeave(lobbyId);
  if (opts.notifyInstance !== false && instanceManager.isRunning(lobbyId)) {
    instanceManager.sendToInstance(lobbyId, { type: 'PLAYER_LEAVE', payload: { userId } });
  }

  if (dissolved) {
    // Subprocess beenden — sonst leakt pro aufgelöster Lobby ein Prozess
    instanceManager.stopInstance(lobbyId);
    lobbyBuckets.delete(lobbyId);
    relaySeq.delete(lobbyId);
    clearTimeout(closedReleaseTimers.get(lobbyId));
    closedReleaseTimers.delete(lobbyId);
    rejectAllJoinRequests(io, lobbyId, 'lobby_closed');
    gsHooks.lobbyClosed(lobbyId, serverId, 'dissolved');
    // Host-Policy 'dissolve': verbleibende Mitglieder werden aus der aufgelösten Lobby entfernt
    for (const p of evicted ?? []) {
      if (p.userId === userId) continue;
      io.to(userRoom(p.userId)).emit('playerKicked', { lobbyId });
      io.in(userRoom(p.userId)).socketsLeave(lobbyId);
      sessionManager.clearGrace(p.userId);
      broadcastPresence(io, p.userId);
      sessionManager.dropIfIdle(p.userId);
    }
  } else if (lobby) {
    broadcastLobbyChange(io, lobby, hostChanged ? 'host_left' : 'player_left');
    if (hostChanged) {
      redeliverJoinRequests(io.to(userRoom(lobby.hostId)), lobbyId);
    }
  }
  broadcastPresence(io, userId);
}

/** Bindet die Sockets des Users an die Lobby (Room-Mitgliedschaft hängt am User, nicht am Socket). */
function bindUserToLobby(io: AppServer, userId: string, lobbyId: string): void {
  io.in(userRoom(userId)).socketsJoin(lobbyId);
}

export function afterJoin(io: AppServer, userId: string, username: string, lobby: Lobby): void {
  withdrawAllRequestsFor(io, userId, 'cancelled');
  bindUserToLobby(io, userId, lobby.id);
  broadcastLobbyChange(io, lobby, 'player_joined');
  // Beitritt über Panel/Einladung muss den Spielclient genauso initialisieren wie ein Beitritt per Code
  io.to(gameRoom(userId)).emit('lobbyInfo', lobby);
  if (instanceManager.isRunning(lobby.id)) {
    instanceManager.sendToInstance(lobby.id, { type: 'PLAYER_JOIN', payload: { userId, username } });
  }
  gsHooks.playerJoined(lobby, userId, username);
}

// ─── Disconnect / Reconnect ───────────────────────────────────────────────────

function handleLastSessionGone(io: AppServer, userId: string): void {
  withdrawAllRequestsFor(io, userId, 'cancelled');
  socketBuckets.delete(userId);
  presenceChanged(userId);

  const lobby = lobbyManager.getLobbyByUserId(userId);
  if (!lobby) {
    sessionManager.dropIfIdle(userId);
    return;
  }

  const grace = getGame(lobby.gameId)?.reconnectGraceMs ?? 0;
  if (grace <= 0) {
    leaveLobbyFlow(io, userId, { notifyInstance: false });
    sessionManager.dropIfIdle(userId);
    return;
  }

  const updated = lobbyManager.setConnected(userId, false);
  if (instanceManager.isRunning(lobby.id)) {
    instanceManager.sendToInstance(lobby.id, { type: 'PLAYER_DISCONNECT', payload: { userId } });
  }
  if (updated) {
    io.to(lobby.id).emit('lobbyUpdated', updated, 'player_disconnected');
    gsHooks.playerDisconnected(updated, userId);
  }

  sessionManager.startGrace(userId, grace, () => {
    console.log(`[Session] Reconnect-Gnadenfrist abgelaufen für ${userId}`);
    leaveLobbyFlow(io, userId);
    sessionManager.dropIfIdle(userId);
  });
}

/** Verbindet eine neue Session mit einer bestehenden Lobby-Mitgliedschaft (Reconnect, zweites Gerät, Takeover). */
function resumeIntoLobby(io: AppServer, socket: AppSocket, lobby: Lobby): void {
  const { userId } = socket.data;
  const wasInGrace = sessionManager.clearGrace(userId);
  const updated = lobbyManager.setConnected(userId, true) ?? lobby;
  socket.join(lobby.id);

  if (socket.data.clientType === 'game' && instanceManager.isRunning(lobby.id)) {
    instanceManager.sendToInstance(lobby.id, {
      type: 'PLAYER_RECONNECT',
      payload: { userId, username: socket.data.username },
    });
  }
  if (wasInGrace) {
    io.to(lobby.id).emit('lobbyUpdated', updated, 'player_reconnected');
    gsHooks.playerReconnected(updated, userId);
  }
  if (lobby.hostId === userId) redeliverJoinRequests(socket, lobby.id);
  if (socket.data.clientType === 'game') replayBuffered(socket, lobby.id);
  socket.emit('session:resumed', { state: sessionManager.stateFor(userId, socket.data.sessionId, lobby.id), lobby: updated });
}

// ─── Socket.io Auth-Middleware ────────────────────────────────────────────────

/**
 * Prüft den JWT aus socket.handshake.auth.token bei jeder neuen Verbindung.
 * Client sendet: io({ auth: { token: "Bearer <jwt>" } })
 */
export function registerSocketAuth(io: AppServer): void {
  io.use((socket, next) => {
    const raw: unknown = socket.handshake.auth?.token;
    if (typeof raw !== 'string' || !raw.startsWith('Bearer ')) {
      return next(new Error('UNAUTHENTICATED'));
    }
    try {
      const payload = verifyToken(raw.slice(7));
      const clientType: 'game' | 'panel' =
        socket.handshake.auth?.clientType === 'panel' ? 'panel' : 'game';
      socket.data.userId = payload.userId;
      socket.data.username = payload.username;
      socket.data.clientType = clientType;
      socket.data.sessionId = uuidv4();
      socket.data.tokenExpiresAt = payload.exp ? payload.exp * 1000 : undefined;
      next();
    } catch {
      next(new Error('INVALID_TOKEN'));
    }
  });
}

// ─── IPC → Socket.io Routing ──────────────────────────────────────────────────

/**
 * Registriert den IPC-Callback: leitet Subprocess-Nachrichten als
 * Socket.io-Events an alle Spieler im jeweiligen Lobby-Room weiter.
 */
export function registerIpcRouting(io: AppServer): void {
  setSessionTerminator((uid) => {
    io.in(userRoom(uid)).disconnectSockets(true);
  });
  instanceManager.setExitCallback((lobbyId, code, alreadyClosed) => {
    const lobby = lobbyManager.getLobby(lobbyId);
    if (!lobby) return;
    if (!alreadyClosed && code !== 0) io.to(lobbyId).emit('gameCrashed', { lobbyId, code });
    broadcastLobbyChange(io, lobby, 'state_changed');
    scheduleClosedRelease(io, lobbyId);
  });
  instanceManager.setMessageCallback((lobbyId: string, msg: IpcGameToHub) => {
    switch (msg.type) {
      case 'GAME_STATE':
        io.to(lobbyId).emit('gameState', msg.payload);
        break;
      case 'GAME_STATE_FOR_USER': {
        // Nur an aktuelle Mitglieder DIESER Lobby liefern (nicht nach Verlassen/Wechsel)
        const targetLobby = lobbyManager.getLobbyByUserId(msg.payload.userId);
        if (!targetLobby || targetLobby.id !== lobbyId) break;
        io.to(gameRoom(msg.payload.userId)).emit('gameState', msg.payload.state);
        break;
      }
      case 'GAME_EVENT':
        io.to(lobbyId).emit('gameEvent', msg.payload);
        break;
      case 'GAME_STARTED': {
        const before = lobbyManager.getLobby(lobbyId);
        if (!before || before.status === 'closed' || before.status === 'in_progress') break;
        lobbyManager.setStatus(lobbyId, 'in_progress');
        broadcastLobbyChange(io, before, 'state_changed');
        break;
      }
      case 'GAME_OVER': {
        io.to(lobbyId).emit('gameOver', msg.payload);
        lobbyManager.setStatus(lobbyId, 'closed');
        const lobby = lobbyManager.getLobby(lobbyId);
        if (lobby) {
          broadcastLobbyChange(io, lobby, 'state_changed');
          scheduleClosedRelease(io, lobbyId);
        }
        break;
      }
      case 'SAVE_META': {
        const { userId, gameId, entries } = msg.payload;
        if (!lobbyManager.isParticipant(lobbyId, gameId, userId)) {
          console.warn(`[IPC] SAVE_META abgelehnt (${userId}/${gameId}) in Lobby ${lobbyId}`);
          break;
        }
        bulkSet(userId, gameId, entries, 'server').catch((err) =>
          console.error(`[IPC] SAVE_META fehlgeschlagen (${userId}/${gameId}):`, err)
        );
        break;
      }
      case 'READY':
        console.log(`[IPC] Subprocess für Lobby ${lobbyId} ist bereit`);
        io.to(lobbyId).emit('gameStarting', {
          lobbyId,
          gameId: lobbyManager.getLobby(lobbyId)?.gameId ?? '',
        });
        break;
      case 'LOG':
        console.log(`[IPC:${lobbyId.slice(0, 8)}] ${msg.payload}`);
        break;
    }
  });
}

// ─── Lobby-Events ─────────────────────────────────────────────────────────────

export function registerLobbyHandlers(io: AppServer): void {
  io.on('connection', (socket: AppSocket) => {
    const { userId, username, clientType, sessionId } = socket.data;
    console.log(`[Socket] "${username}" verbunden als ${clientType} (${socket.id})`);

    // Session-Takeover: ein neuer Spiel-Client ersetzt den alten (F5, Gerätewechsel).
    // Die Lobby-Mitgliedschaft bleibt dabei bestehen (hängt am User).
    if (clientType === 'game') {
      for (const old of sessionManager.gameSessions(userId)) {
        const oldSocket = io.sockets.sockets.get(old.socketId);
        if (oldSocket) {
          console.log(`[Socket] Session-Takeover für "${username}" — alter Socket ${old.socketId} wird getrennt`);
          oldSocket.emit('session:replaced', { reason: 'new_session' });
          oldSocket.disconnect(true);
        }
      }
    }

    sessionManager.add(userId, username, { sessionId, socketId: socket.id, clientType });
    socket.join(userRoom(userId));
    if (clientType === 'game') socket.join(gameRoom(userId));

    // Bestehende Lobby-Mitgliedschaft übernehmen (Reconnect innerhalb der Gnadenfrist, zweites Gerät)
    const existingLobby = lobbyManager.getLobbyByUserId(userId);
    if (existingLobby) sessionManager.setGame(userId, existingLobby.gameId);

    const hello: HelloPayload = {
      protocolVersion: PROTOCOL_VERSION,
      serverTime: Date.now(),
      sessionId,
      capabilities: ['acks', 'gameRegistration', 'reconnect', 'userDataWriteScope', 'userDataSocketWrite', 'social'],
      gameId: sessionManager.getGameId(userId),
      lobbyId: existingLobby?.id,
    };
    socket.emit('hello', hello);
    if (existingLobby) resumeIntoLobby(io, socket, existingLobby);
    if (clientType === 'game') broadcastPresence(io, userId);

    // ── session:registerGame ─────────────────────────────────────────────────
    handle(socket, 'session:registerGame', { limit: 'registerGame' }, (data) => {
      const input = parseInput(
        z.object({
          gameId: GameIdSchema,
          clientVersion: z.string().max(32).optional(),
          platform: z.string().max(32).optional(),
        }),
        data,
      );
      const game = getGame(input.gameId);
      if (!game) throw new HubError('UNKNOWN_GAME');
      const lobby = lobbyManager.getLobbyByUserId(userId);
      if (lobby && lobby.gameId !== game.id) throw new HubError('LEAVE_LOBBY_FIRST');
      if (game.minClientVersion && (!input.clientVersion || compareVersions(input.clientVersion, game.minClientVersion) < 0)) {
        throw new HubError('CLIENT_OUTDATED', `Client-Version zu alt (mindestens ${game.minClientVersion})`);
      }
      sessionManager.setGame(userId, game.id, input.clientVersion, input.platform);
      broadcastPresence(io, userId);
      return { game, state: sessionManager.stateFor(userId, sessionId, lobby?.id) };
    });

    // ── session:getState ─────────────────────────────────────────────────────
    handle(socket, 'session:getState', { limit: 'sessionState' }, () => {
      const lobby = lobbyManager.getLobbyByUserId(userId);
      return { state: sessionManager.stateFor(userId, sessionId, lobby?.id), lobby };
    });

    // ── listLobbies ─────────────────────────────────────────────────────────
    handle(socket, 'listLobbies', { limit: 'listLobbies' }, () => {
      const game = requireGame(userId);
      const lobbies = lobbyManager.listLobbies(game.id).map(toListing);
      socket.emit('lobbyList', lobbies);
      return { lobbies };
    });

    // ── createLobby ─────────────────────────────────────────────────────────
    handle(socket, 'createLobby', { limit: 'createLobby' }, async (data) => {
      const game = requireGame(userId);
      const { name, isPrivate, settings, serverPreference } = parseInput(CreateLobbySchema, data);
      const maxBytes = game.maxSettingsBytes ?? 8192;
      if (Buffer.byteLength(JSON.stringify(settings)) > maxBytes) throw new HubError('SETTINGS_TOO_LARGE');
      if (jsonDepth(settings) > 8) throw new HubError('INVALID_INPUT', 'Lobby-Einstellungen zu tief verschachtelt');

      const lobby = lobbyManager.createLobby(userId, username, game.id, name, game.maxPlayers, game.hosted, isPrivate, settings);
      bindUserToLobby(io, userId, lobby.id);
      try {
        // Game-Server hat Vorrang vor dem eingebetteten Subprocess; ohne Server läuft der Subprocess (falls vorhanden)
        const bound = await bindGameServer(io, lobby, game, serverPreference);
        if (!bound) await instanceManager.startInstance(lobby);
      } catch (err) {
        // Kein Ghost-Lobby: bei Startfehler komplett zurückrollen
        console.error(`[createLobby] Start fehlgeschlagen (${game.id}):`, err);
        io.in(userRoom(userId)).socketsLeave(lobby.id);
        releaseServerSlot(lobby.id, lobby.server?.serverId);
        lobbyManager.removeLobby(lobby.id);
        instanceManager.stopInstance(lobby.id);
        if (isHubError(err) && ['INSTANCE_LIMIT', 'NO_GAME_SERVER_AVAILABLE'].includes(err.code)) throw err;
        throw new HubError('LOBBY_START_FAILED');
      }
      socket.emit('lobbyCreated', lobby);
      broadcastPresence(io, userId);
      return { lobby };
    });

    // ── joinLobby ───────────────────────────────────────────────────────────
    handle(socket, 'joinLobby', { limit: 'joinLobby' }, (data) => {
      const { lobbyId } = parseInput(z.object({ lobbyId: z.string().min(1).max(64) }), data);
      const game = requireGame(userId);
      const lobby = lobbyManager.joinLobby(userId, username, lobbyId, { gameId: game.id });
      afterJoin(io, userId, username, lobby);
      return { lobby };
    });

    // ── joinLobbyByCode ──────────────────────────────────────────────────────
    handle(socket, 'joinLobbyByCode', { limit: 'joinLobbyByCode' }, (data) => {
      const { code } = parseInput(z.object({ code: InviteCodeSchema }), data, new HubError('INVALID_INVITE_CODE'));
      const game = requireGame(userId);
      const found = lobbyManager.getByInviteCode(code);
      if (!found) throw new HubError('INVITE_CODE_NOT_FOUND');
      const lobby = lobbyManager.joinLobby(userId, username, found.id, { gameId: game.id, viaCode: true });
      afterJoin(io, userId, username, lobby);
      return { lobby };
    });

    // ── leaveLobby ──────────────────────────────────────────────────────────
    handle(socket, 'leaveLobby', { limit: 'leaveLobby' }, () => {
      // Explizites Verlassen kennt keine Gnadenfrist
      leaveLobbyFlow(io, userId);
    });

    // ── getLobbyInfo ─────────────────────────────────────────────────────────
    handle(socket, 'getLobbyInfo', { limit: 'getLobbyInfo' }, () => {
      const lobby = requireLobby(userId);
      socket.emit('lobbyInfo', lobby);
      if (lobby.hostId === userId) redeliverJoinRequests(socket, lobby.id);
      return { lobby };
    });

    // ── kickPlayer ───────────────────────────────────────────────────────────
    handle(socket, 'kickPlayer', { limit: 'kickPlayer' }, (data) => {
      const { playerId } = parseInput(z.object({ playerId: z.string().min(1).max(64) }), data);
      const lobby = lobbyManager.kickPlayer(userId, playerId);
      gsHooks.playerLeft(lobby.id, lobby.server?.serverId, playerId, 'kicked');
      io.to(userRoom(playerId)).emit('playerKicked', { lobbyId: lobby.id });
      io.in(userRoom(playerId)).socketsLeave(lobby.id);
      sessionManager.clearGrace(playerId);
      if (instanceManager.isRunning(lobby.id)) {
        instanceManager.sendToInstance(lobby.id, { type: 'PLAYER_LEAVE', payload: { userId: playerId } });
      }
      broadcastLobbyChange(io, lobby, 'kicked');
      broadcastPresence(io, playerId);
      if (!sessionManager.isConnected(playerId)) sessionManager.dropIfIdle(playerId);
      return { lobby };
    });

    // ── transferHost ─────────────────────────────────────────────────────────
    handle(socket, 'transferHost', { limit: 'transferHost' }, (data) => {
      const { playerId } = parseInput(z.object({ playerId: z.string().min(1).max(64) }), data);
      const lobby = lobbyManager.transferHost(userId, playerId);
      broadcastLobbyChange(io, lobby, 'host_transferred');
      redeliverJoinRequests(io.to(userRoom(playerId)), lobby.id);
      return { lobby };
    });

    // ── lockLobby / unlockLobby ───────────────────────────────────────────────
    handle(socket, 'lockLobby', { limit: 'lockLobby' }, () => {
      const lobby = lobbyManager.setLocked(userId, true);
      broadcastLobbyChange(io, lobby, 'locked');
      return { lobby };
    });
    handle(socket, 'unlockLobby', { limit: 'unlockLobby' }, () => {
      const lobby = lobbyManager.setLocked(userId, false);
      broadcastLobbyChange(io, lobby, 'unlocked');
      // Offene Anfragen sind hinfällig: Anfragende sollen normal beitreten
      rejectAllJoinRequests(io, lobby.id, 'unlocked');
      return { lobby };
    });

    // ── setLobbyState (Host; für Relay-Spiele ohne Subprocess) ────────────────
    handle(socket, 'setLobbyState', { limit: 'setLobbyState' }, (data) => {
      const { state } = parseInput(z.object({ state: z.enum(['in_progress', 'closed']) }), data);
      const lobby = lobbyManager.setStateByHost(userId, state);
      broadcastLobbyChange(io, lobby, 'state_changed');
      if (state === 'closed') scheduleClosedRelease(io, lobby.id);
      return { lobby };
    });

    // ── requestJoinLobby / requestJoinLobbyByCode ─────────────────────────────
    handle(socket, 'requestJoinLobby', { limit: 'requestJoinLobby' }, (data) => {
      const { lobbyId } = parseInput(z.object({ lobbyId: z.string().min(1).max(64) }), data);
      const lobby = lobbyManager.getLobby(lobbyId);
      if (!lobby) throw new HubError('LOBBY_NOT_FOUND');
      return startJoinRequest(io, userId, username, lobby, false);
    });

    handle(socket, 'requestJoinLobbyByCode', { limit: 'requestJoinLobbyByCode' }, (data) => {
      const { code } = parseInput(z.object({ code: InviteCodeSchema }), data, new HubError('INVALID_INVITE_CODE'));
      const lobby = lobbyManager.getByInviteCode(code);
      if (!lobby) throw new HubError('INVITE_CODE_NOT_FOUND');
      return startJoinRequest(io, userId, username, lobby, true);
    });

    // ── cancelJoinRequest ─────────────────────────────────────────────────────
    handle(socket, 'cancelJoinRequest', { limit: 'cancelJoinRequest' }, (data) => {
      const { lobbyId } = parseInput(z.object({ lobbyId: z.string().min(1).max(64) }), data);
      if (!joinRequests.get(lobbyId)?.has(userId)) throw new HubError('JOIN_REQUEST_NOT_FOUND');
      clearJoinRequest(lobbyId, userId);
      const lobby = lobbyManager.getLobby(lobbyId);
      if (lobby) io.to(userRoom(lobby.hostId)).emit('joinRequestWithdrawn', { requesterId: userId, reason: 'cancelled' });
    });

    // ── respondJoinRequest (Host) ─────────────────────────────────────────────
    handle(socket, 'respondJoinRequest', { limit: 'respondJoinRequest' }, (data) => {
      const { requesterId, accept } = parseInput(
        z.object({ requesterId: z.string().min(1).max(64), accept: z.boolean() }),
        data,
      );
      const lobby = lobbyManager.getLobbyByUserId(userId);
      if (!lobby || lobby.hostId !== userId) {
        throw new HubError('NOT_HOST', 'Nur der Host kann Beitrittsanfragen beantworten');
      }
      const entry = joinRequests.get(lobby.id)?.get(requesterId);
      if (!entry) throw new HubError('JOIN_REQUEST_NOT_FOUND');
      clearJoinRequest(lobby.id, requesterId);

      if (!accept) {
        io.to(userRoom(requesterId)).emit('joinRequestRejected', { lobbyId: lobby.id, reason: 'declined' });
        return;
      }
      try {
        const requesterGame = sessionManager.getGameId(requesterId);
        const updated = lobbyManager.joinLobby(requesterId, entry.username, lobby.id, {
          gameId: requesterGame,
          viaCode: entry.viaCode,
          bypassLock: true,
        });
        afterJoin(io, requesterId, entry.username, updated);
        io.to(userRoom(requesterId)).emit('joinRequestAccepted', { lobby: updated });
      } catch (err) {
        const code = isHubError(err) ? err.code : 'LOBBY_CLOSED';
        const reason: JoinRequestRejectReason =
          code === 'ALREADY_IN_LOBBY' ? 'already_in_lobby' : code === 'LOBBY_FULL' ? 'lobby_full' : 'lobby_closed';
        io.to(userRoom(requesterId)).emit('joinRequestRejected', { lobbyId: lobby.id, reason });
        throw isHubError(err) ? err : new HubError('LOBBY_CLOSED');
      }
    });

    // ── Relay ────────────────────────────────────────────────────────────────
    const relayTarget = (playerId: string): void => {
      const lobby = requireLobby(userId);
      const targetLobby = lobbyManager.getLobbyByUserId(playerId);
      if (!targetLobby || targetLobby.id !== lobby.id) throw new HubError('PLAYER_NOT_IN_LOBBY');
      const target = targetLobby.players.find((p) => p.userId === playerId);
      if (target?.connected === false || !sessionManager.hasGameSession(playerId)) throw new HubError('PLAYER_UNREACHABLE');
    };
    const RelayBase = { type: z.string(), payload: z.unknown(), echo: z.boolean().optional() };

    handle(socket, 'sendToLobby', { limit: 'sendToLobby', perUser: true }, (data) => {
      const lobby = requireLobby(userId);
      assertLobbyLimit(lobby.id, 'sendToLobby');
      const { type, payload, echo } = parseInput(z.object(RelayBase), data);
      validateMessageType(type);
      validateJsonPayloadSize(payload);
      const msg = { from: userId, seq: nextSeq(lobby.id), type, payload };
      bufferForGrace(lobby, userId, 'message', msg);
      // Standard: alle anderen Mitglieder; mit echo:true bekommt der Sender (alle seine Sessions) die Nachricht ebenfalls
      (echo ? io.to(lobby.id) : io.to(lobby.id).except(userRoom(userId))).emit('message', msg);
      return { seq: msg.seq };
    });

    handle(socket, 'sendToLobbyBinary', { limit: 'sendToLobbyBinary', perUser: true }, (data) => {
      const lobby = requireLobby(userId);
      assertLobbyLimit(lobby.id, 'sendToLobbyBinary');
      const bin = validateBinaryRelayInput(data, maxBinaryBytesFor(userId));
      const msg = { from: userId, seq: nextSeq(lobby.id), typeCode: bin.typeCode, payload: bin.payload };
      bufferForGrace(lobby, userId, 'messageBinary', msg);
      (data?.echo === true ? io.to(lobby.id) : io.to(lobby.id).except(userRoom(userId))).emit('messageBinary', msg);
      return { seq: msg.seq };
    });

    handle(socket, 'sendToPlayer', { limit: 'sendToPlayer', perUser: true }, (data) => {
      const { playerId, type, payload, echo } = parseInput(z.object({ playerId: z.string().min(1).max(64), ...RelayBase }), data);
      validateMessageType(type);
      validateJsonPayloadSize(payload);
      if (playerId === userId && !echo) throw new HubError('CANNOT_TARGET_SELF');
      relayTarget(playerId);
      const msg = { from: userId, seq: nextSeq(requireLobby(userId).id), type, payload };
      io.to(gameRoom(playerId)).emit('message', msg);
      return { seq: msg.seq };
    });

    handle(socket, 'sendToPlayerBinary', { limit: 'sendToPlayerBinary', perUser: true }, (data) => {
      const playerId = parseInput(z.string().min(1).max(64), data?.playerId);
      if (playerId === userId && data?.echo !== true) throw new HubError('CANNOT_TARGET_SELF');
      relayTarget(playerId);
      const bin = validateBinaryRelayInput(data, maxBinaryBytesFor(userId));
      const msg = { from: userId, seq: nextSeq(requireLobby(userId).id), typeCode: bin.typeCode, payload: bin.payload };
      io.to(gameRoom(playerId)).emit('messageBinary', msg);
      return { seq: msg.seq };
    });

    // ── User-Daten (Socket-Parität zu REST) ──────────────────────────────────
    handle(socket, 'getUserData', { limit: 'getUserData' }, async (gameIdRaw) => {
      const gameId = parseInput(GameIdSchema, gameIdRaw, new HubError('INVALID_INPUT', 'Ungültige Spiel-ID'));
      if (!getGame(gameId)) throw new HubError('UNKNOWN_GAME');
      const entries = await getAllOwn(userId, gameId);
      socket.emit('userData', { gameId, entries });
      return { gameId, entries };
    });

    handle(socket, 'setUserData', { limit: 'setUserData' }, async (data) => {
      const { gameId, key, value, visibility } = parseInput(
        z.object({ gameId: GameIdSchema, key: KeySchema, value: z.unknown(), visibility: VisibilitySchema.optional() }),
        data,
      );
      await writeEntries(userId, gameId, [{ key, value, visibility }], 'client');
    });

    handle(socket, 'bulkSetUserData', { limit: 'bulkSetUserData' }, async (data) => {
      const { gameId, entries } = parseInput(z.object({ gameId: GameIdSchema, entries: BulkEntriesSchema }), data);
      await writeEntries(userId, gameId, entries, 'client');
    });

    handle(socket, 'deleteUserData', { limit: 'deleteUserData' }, async (data) => {
      const { gameId, key } = parseInput(z.object({ gameId: GameIdSchema, key: KeySchema }), data);
      await deleteKey(userId, gameId, key, 'client');
    });

    handle(socket, 'getPlayerData', { limit: 'getPlayerData' }, async (data) => {
      const { playerId, gameId } = parseInput(
        z.object({ playerId: z.string().min(1).max(64), gameId: GameIdSchema }),
        data,
        new HubError('INVALID_INPUT', 'Ungültige Spiel-ID'),
      );
      if (!getGame(gameId)) throw new HubError('UNKNOWN_GAME');
      const requesterLobby = lobbyManager.getLobbyByUserId(userId);
      const targetLobby = lobbyManager.getLobbyByUserId(playerId);
      const inSameLobby = !!(requesterLobby && targetLobby && requesterLobby.id === targetLobby.id);
      const entries = await getVisibleData(playerId, gameId, inSameLobby);
      socket.emit('playerData', { playerId, gameId, entries });
      return { playerId, gameId, entries };
    });

    // ── gameAction ───────────────────────────────────────────────────────────
    handle(socket, 'gameAction', { limit: 'gameAction', quiet: true }, (data) => {
      const lobby = requireLobby(userId);
      if (!lobby.server && !instanceManager.isRunning(lobby.id)) throw new HubError('GAME_NOT_RUNNING');
      assertLobbyLimit(lobby.id, 'gameAction');
      const { type, payload } = parseInput(z.object({ type: z.string().min(1).max(64), payload: z.unknown() }), data);
      if (lobby.server) {
        gsHooks.action(lobby, userId, type, payload);
        return;
      }
      instanceManager.sendToInstance(lobby.id, {
        type: 'PLAYER_ACTION',
        payload: { userId, action: type, data: payload },
      });
    });

    // ── Token-Ablauf: ohne auth:refresh wird der Socket nach Gnadenfrist getrennt ──
    let expiryTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    const armExpiry = (): void => {
      clearTimeout(expiryTimer);
      clearTimeout(graceTimer); // ein Refresh nach AUTH_EXPIRED (innerhalb der Gnadenfrist) rettet den Socket
      const exp = socket.data.tokenExpiresAt;
      if (!exp) return;
      const graceMs = Number(process.env.AUTH_EXPIRY_GRACE_MS) >= 0 && process.env.AUTH_EXPIRY_GRACE_MS ? Number(process.env.AUTH_EXPIRY_GRACE_MS) : 15_000;
      expiryTimer = setTimeout(() => {
        const detail = { code: 'AUTH_EXPIRED' as const, message: 'Sitzung abgelaufen' };
        socket.emit('errorDetail', detail);
        socket.emit('error', detail.message);
        graceTimer = setTimeout(() => socket.disconnect(true), graceMs);
        graceTimer.unref();
      }, Math.max(0, exp - Date.now()));
      expiryTimer.unref();
    };
    armExpiry();

    handle(socket, 'auth:refresh', { limit: 'authRefresh' }, (data) => {
      const { token } = parseInput(z.object({ token: z.string().min(1) }), data);
      let payload;
      try {
        payload = verifyToken(token.startsWith('Bearer ') ? token.slice(7) : token);
      } catch {
        throw new HubError('INVALID_TOKEN');
      }
      if (payload.userId !== userId) throw new HubError('INVALID_TOKEN', 'Token gehört zu einem anderen User');
      socket.data.tokenExpiresAt = payload.exp ? payload.exp * 1000 : undefined;
      armExpiry();
      return { expiresAt: socket.data.tokenExpiresAt ?? 0 };
    });

    // ── disconnect ──────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      clearTimeout(expiryTimer);
      clearTimeout(graceTimer);
      console.log(`[Socket] "${username}" getrennt (${socket.id})`);
      socketBuckets.delete(socket.id);
      for (const key of [...lastRateLimitNotice.keys()]) {
        if (key.startsWith(`${socket.id}:`)) lastRateLimitNotice.delete(key);
      }

      const { remaining } = sessionManager.remove(userId, socket.id);
      if (remaining > 0) {
        // Anderer Socket des Users aktiv (Takeover/Panel): nur Presence neu bewerten
        if (!sessionManager.hasGameSession(userId)) presenceChanged(userId);
        return;
      }
      handleLastSessionGone(io, userId);
    });
  });
}

// ─── Hilfsfunktion: Beitrittsanfrage (gemeinsam für ID + Invite-Code) ─────────

export function startJoinRequest(
  io: AppServer,
  userId: string,
  username: string,
  lobby: Lobby,
  viaCode: boolean,
): Record<string, unknown> {
  const game = requireGame(userId);
  lobbyManager.assertJoinable(userId, lobby, { gameId: game.id, viaCode });

  // Nicht gesperrt → direkter Beitritt, keine Anfrage nötig
  if (!lobby.locked) {
    const joined = lobbyManager.joinLobby(userId, username, lobby.id, { gameId: game.id, viaCode });
    afterJoin(io, userId, username, joined);
    return { pending: false, lobby: joined };
  }

  if (joinRequests.get(lobby.id)?.has(userId)) {
    io.to(userRoom(userId)).emit('joinRequestPending', { lobbyId: lobby.id });
    return { pending: true };
  }
  assertLobbyLimit(lobby.id, 'requestJoinLobby');
  // Pro User nur eine offene Anfrage: neue Anfrage ersetzt alte
  withdrawAllRequestsFor(io, userId, 'cancelled', { exceptLobbyId: lobby.id, notifyRequester: true });

  const timer = setTimeout(() => {
    clearJoinRequest(lobby.id, userId);
    io.to(userRoom(userId)).emit('joinRequestRejected', { lobbyId: lobby.id, reason: 'timeout' });
    io.to(userRoom(lobby.hostId)).emit('joinRequestWithdrawn', { requesterId: userId, reason: 'timeout' });
  }, JOIN_REQUEST_TIMEOUT_MS);
  timer.unref();

  const reqs = joinRequests.get(lobby.id) ?? new Map();
  reqs.set(userId, { username, viaCode, timer });
  joinRequests.set(lobby.id, reqs);

  io.to(userRoom(userId)).emit('joinRequestPending', { lobbyId: lobby.id });
  io.to(userRoom(lobby.hostId)).emit('joinRequestReceived', { lobbyId: lobby.id, requesterId: userId, username });
  return { pending: true };
}
