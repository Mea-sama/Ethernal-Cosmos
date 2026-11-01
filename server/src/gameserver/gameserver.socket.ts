import type { Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import type {
  GameInfo,
  GameServerHandshake,
  GameServerInfo,
  GameServerToHubEvents,
  HubToGameServerEvents,
  Lobby,
  LobbyAssignReason,
  LobbyChangeReason,
  ServerPreference,
} from '@ethernal/shared';
import { HubError, isHubError } from '../errors';
import { serverLimits } from '../config/limits';
import { clientIp } from '../limits/client-ip';
import { getGame } from '../games/game.registry';
import { lobbyManager } from '../lobby/lobby.manager';
import { gameRoom, sessionManager, userRoom } from '../session/session.manager';
import {
  broadcastLobbyChange,
  jsonDepth,
  leaveLobbyFlow,
  nextSeq,
  scheduleClosedRelease,
  validateJsonPayloadSize,
  validateMessageType,
  type AppServer,
} from '../lobby/lobby.socket';
import { setGameServerHooks } from './hooks';
import { verifyGameServerKey } from './keys.service';

type ServerSocket = Socket<GameServerToHubEvents, HubToGameServerEvents, Record<string, never>, { serverId: string; gameId: string; ip?: string }>;

interface LiveServer {
  serverId: string;
  gameId: string;
  region?: string;
  capacity: number;
  version?: string;
  draining: boolean;
  socketId?: string;
  connected: boolean;
  lobbies: Set<string>;
  resumeTimer?: NodeJS.Timeout;
  /** unix ms of the last disconnect while still holding lobbies */
  lostAt?: number;
}

const servers = new Map<string, LiveServer>();
const gsConnectionsPerIp = new Map<string, number>();
let namespace: Namespace<GameServerToHubEvents, HubToGameServerEvents, Record<string, never>, { serverId: string; gameId: string; ip?: string }> | null = null;
let mainIo: AppServer | null = null;

const resumeGraceMs = (): number => (Number(process.env.SERVER_RESUME_GRACE_MS) > 0 ? Number(process.env.SERVER_RESUME_GRACE_MS) : 30_000);
const assignTimeoutMs = (): number => (Number(process.env.SERVER_ASSIGN_TIMEOUT_MS) > 0 ? Number(process.env.SERVER_ASSIGN_TIMEOUT_MS) : 5_000);
const serverRoom = (serverId: string): string => `server:${serverId}`;

const HandshakeSchema = z.object({
  serverKey: z.string().min(1).max(200),
  gameId: z.string().min(1).max(64),
  serverId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
  region: z.string().min(1).max(32).optional(),
  capacity: z.coerce.number().int().min(1).max(100_000),
  version: z.string().max(32).optional(),
});

export function toServerInfo(s: LiveServer): GameServerInfo {
  return {
    serverId: s.serverId,
    gameId: s.gameId,
    region: s.region,
    capacity: s.capacity,
    load: s.lobbies.size,
    draining: s.draining,
    connected: s.connected,
    version: s.version,
  };
}

/** Diagnose/Tests: Zustand der bekannten Game-Server */
export function listGameServers(gameId?: string): GameServerInfo[] {
  return [...servers.values()].filter((s) => !gameId || s.gameId === gameId).map(toServerInfo);
}

function emitToServer<E extends keyof HubToGameServerEvents>(serverId: string | undefined, event: E, ...args: Parameters<HubToGameServerEvents[E]>): void {
  const s = serverId ? servers.get(serverId) : undefined;
  if (!s?.connected || !namespace) return;
  (namespace.to(serverRoom(s.serverId)) as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit(event, ...args);
}

// ─── Allokation ───────────────────────────────────────────────────────────────

function candidatesFor(gameId: string, pref?: ServerPreference): LiveServer[] {
  const usable = [...servers.values()].filter(
    (s) => s.gameId === gameId && s.connected && !s.draining && s.lobbies.size < s.capacity,
  );
  // Region ist eine Präferenz: passende Region zuerst, dann nach Auslastung
  return usable.sort((a, b) => {
    const ra = pref?.region && a.region === pref.region ? 0 : 1;
    const rb = pref?.region && b.region === pref.region ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return a.lobbies.size / a.capacity - b.lobbies.size / b.capacity;
  });
}

type AssignInfo = { reason: LobbyAssignReason; previousServerId?: string; lostAt?: number };

function askAssignment(server: LiveServer, lobby: Lobby, info: AssignInfo = { reason: 'new_lobby' }): Promise<boolean> {
  return new Promise((resolve) => {
    if (!namespace) return resolve(false);
    const timer = setTimeout(() => resolve(false), assignTimeoutMs());
    const players = lobby.players.map((p) => ({ userId: p.userId, username: p.username }));
    (namespace.to(serverRoom(server.serverId)) as unknown as { timeout: (ms: number) => { emit: (...a: unknown[]) => void } })
      .timeout(assignTimeoutMs())
      .emit('lobby:assigned', { lobby, players, ...info }, (err: unknown, responses: Array<{ accept: boolean }>) => {
        clearTimeout(timer);
        resolve(!err && responses?.[0]?.accept === true);
      });
  });
}

/**
 * Bindet eine neu erstellte Lobby je nach serverSupport des Spiels an einen Game-Server.
 * @returns true, wenn die Lobby jetzt auf einem Server läuft; false = serverlos (none/optional ohne Server)
 */
export async function bindGameServer(_io: AppServer, lobby: Lobby, game: GameInfo, pref?: ServerPreference): Promise<boolean> {
  const support = game.serverSupport ?? 'none';
  if (support === 'none') return false;
  if (support === 'optional' && pref?.mode === 'none') return false;

  const candidates = candidatesFor(game.id, pref);
  for (const server of candidates) {
    server.lobbies.add(lobby.id); // Kapazität reservieren, solange die Antwort aussteht
    if (await askAssignment(server, lobby)) {
      lobbyManager.setServer(lobby.id, { serverId: server.serverId, region: server.region });
      return true;
    }
    server.lobbies.delete(lobby.id);
  }

  if (support === 'required') {
    throw candidates.length === 0 ? new HubError('NO_GAME_SERVER_AVAILABLE') : new HubError('LOBBY_START_FAILED');
  }
  return false;
}

export function releaseServerSlot(lobbyId: string, serverId: string | undefined): void {
  if (!serverId) return;
  servers.get(serverId)?.lobbies.delete(lobbyId);
}

// ─── Verlust eines Servers ────────────────────────────────────────────────────

function closeLostLobby(lobbyId: string): void {
  const lobby = lobbyManager.getLobby(lobbyId);
  if (!lobby || !mainIo || lobby.status === 'closed') return;
  mainIo.to(lobbyId).emit('gameCrashed', { lobbyId, code: null });
  lobbyManager.setStatus(lobbyId, 'closed');
  broadcastLobbyChange(mainIo, lobby, 'state_changed');
  scheduleClosedRelease(mainIo, lobbyId);
}

/** Resume-Frist abgelaufen: Lobby auf einen anderen Server umbinden; sonst required → schließen, optional → serverlos weiter. */
async function recoverLobby(lobbyId: string, gameId: string, lostServerId: string, lostAt: number): Promise<void> {
  const io = mainIo;
  const lobby = lobbyManager.getLobby(lobbyId);
  if (!io || !lobby || lobby.status === 'closed' || lobby.server?.serverId !== lostServerId) return;
  const support = getGame(gameId)?.serverSupport ?? 'none';
  for (const candidate of candidatesFor(gameId, { region: lobby.server.region })) {
    candidate.lobbies.add(lobbyId);
    if (await askAssignment(candidate, lobby, { reason: 'server_rebound', previousServerId: lostServerId, lostAt })) {
      if (lobbyManager.getLobby(lobbyId)?.status === 'closed') {
        candidate.lobbies.delete(lobbyId);
        return;
      }
      lobbyManager.setServer(lobbyId, { serverId: candidate.serverId, region: candidate.region });
      broadcastLobbyChange(io, lobby, 'server_rebound');
      return;
    }
    candidate.lobbies.delete(lobbyId);
  }
  if (support === 'optional') {
    lobbyManager.setServer(lobbyId, undefined);
    broadcastLobbyChange(io, lobby, 'server_lost');
  } else {
    closeLostLobby(lobbyId);
  }
}

function dropServer(serverId: string): void {
  const s = servers.get(serverId);
  if (!s || !mainIo) return;
  clearTimeout(s.resumeTimer);
  servers.delete(serverId);
  for (const lobbyId of [...s.lobbies]) {
    void recoverLobby(lobbyId, s.gameId, serverId, s.lostAt ?? Date.now()).catch((err) => {
      console.error('[GameServer] Recovery fehlgeschlagen:', err);
      closeLostLobby(lobbyId);
    });
  }
}

/** Setzt den Server-Status aller Lobbys eines Servers und informiert Mitglieder. */
function markServerLobbies(s: LiveServer, status: 'ok' | 'lost' | 'draining', reason: LobbyChangeReason): void {
  if (!mainIo) return;
  for (const lobbyId of s.lobbies) {
    const lobby = lobbyManager.setServerStatus(lobbyId, status);
    if (lobby && lobby.status !== 'closed') broadcastLobbyChange(mainIo, lobby, reason);
  }
}

// ─── Autorisierung ────────────────────────────────────────────────────────────

/** Ein Server darf nur auf eigene Lobbys zugreifen. */
function ownLobby(socket: ServerSocket, lobbyId: unknown): Lobby {
  const id = z.string().min(1).max(64).parse(lobbyId);
  const lobby = lobbyManager.getLobby(id);
  if (!lobby || lobby.server?.serverId !== socket.data.serverId) throw new HubError('NOT_LOBBY_SERVER');
  return lobby;
}

function onServerEvent(
  socket: ServerSocket,
  event: keyof GameServerToHubEvents,
  fn: (data: any) => Record<string, unknown> | void,
): void {
  (socket as unknown as { on(e: string, l: (...a: unknown[]) => void): void }).on(event, (...args: unknown[]) => {
    const ack = typeof args[args.length - 1] === 'function' ? (args.pop() as (r: unknown) => void) : undefined;
    try {
      const result = fn(args[0]);
      ack?.({ ok: true, ...(result ?? {}) });
    } catch (err) {
      const hubErr = isHubError(err) ? err : err instanceof z.ZodError ? new HubError('INVALID_INPUT') : new HubError('INTERNAL');
      if (hubErr.code === 'INTERNAL') console.error(`[GameServer] ${event} Fehler:`, err);
      ack?.({ ok: false, error: hubErr.toPayload({ event }) });
    }
  });
}

// ─── Registrierung ────────────────────────────────────────────────────────────

export function registerGameServerNamespace(io: AppServer): void {
  mainIo = io;
  const ns = io.of('/gameserver') as unknown as NonNullable<typeof namespace>;
  namespace = ns;

  ns.use(async (socket, next) => {
    try {
      const parsed = HandshakeSchema.safeParse(socket.handshake.auth);
      if (!parsed.success) return next(new Error('INVALID_INPUT'));
      const hs: GameServerHandshake = parsed.data;
      const game = getGame(hs.gameId);
      if (!game) return next(new Error('UNKNOWN_GAME'));
      if ((game.serverSupport ?? 'none') === 'none') return next(new Error('GAME_SERVER_NOT_ALLOWED'));
      if (!(await verifyGameServerKey(hs.gameId, hs.serverKey))) return next(new Error('INVALID_SERVER_KEY'));
      const existing = servers.get(hs.serverId);
      if (existing && existing.gameId !== hs.gameId) return next(new Error('INVALID_INPUT'));
      const { caps } = serverLimits;
      const ip = clientIp(socket.handshake.headers, socket.handshake.address);
      const capErr = (message: string): Error => {
        const err = new Error('RATE_LIMITED') as Error & { data: unknown };
        err.data = { code: 'RATE_LIMITED', message, retryAfterMs: caps.capRetryAfterMs };
        return err;
      };
      if ((gsConnectionsPerIp.get(ip) ?? 0) >= caps.maxGameServerConnectionsPerIp) return next(capErr('Zu viele Game-Server-Verbindungen von dieser IP'));
      if (!existing && [...servers.values()].filter((s) => s.gameId === hs.gameId && s.connected).length >= caps.maxGameServersPerGame) {
        return next(capErr('Maximale Anzahl Game-Server für dieses Spiel erreicht'));
      }
      socket.data.ip = ip;
      socket.data.serverId = hs.serverId;
      socket.data.gameId = hs.gameId;
      next();
    } catch (err) {
      console.error('[GameServer] Handshake-Fehler:', err);
      next(new Error('INTERNAL'));
    }
  });

  ns.on('connection', (socket: ServerSocket) => {
    const hs = HandshakeSchema.parse(socket.handshake.auth);
    const ip = socket.data.ip ?? 'unknown';
    gsConnectionsPerIp.set(ip, (gsConnectionsPerIp.get(ip) ?? 0) + 1);
    socket.on('disconnect', () => {
      const n = (gsConnectionsPerIp.get(ip) ?? 1) - 1;
      if (n <= 0) gsConnectionsPerIp.delete(ip);
      else gsConnectionsPerIp.set(ip, n);
    });
    let server = servers.get(hs.serverId);
    const resumed = !!server;

    if (server) {
      // Resume oder Takeover einer noch verbundenen alten Verbindung
      if (server.connected && server.socketId) ns.sockets.get(server.socketId)?.disconnect(true);
      clearTimeout(server.resumeTimer);
      server.region = hs.region;
      server.capacity = hs.capacity;
      server.version = hs.version;
    } else {
      server = { serverId: hs.serverId, gameId: hs.gameId, region: hs.region, capacity: hs.capacity, version: hs.version, draining: false, connected: false, lobbies: new Set() };
      servers.set(hs.serverId, server);
    }
    server.socketId = socket.id;
    server.connected = true;
    if (resumed) markServerLobbies(server, server.draining ? 'draining' : 'ok', 'server_resumed');
    socket.join(serverRoom(hs.serverId));
    console.log(`[GameServer] "${hs.serverId}" (${hs.gameId}${hs.region ? `, ${hs.region}` : ''}) ${resumed ? 'wieder verbunden' : 'verbunden'}`);

    const lobbies = [...server.lobbies].map((id) => lobbyManager.getLobby(id)).filter((l): l is Lobby => !!l);
    socket.emit('hello', { serverId: hs.serverId, gameId: hs.gameId, resumed, lobbies });

    // ── Server → Hub ──
    onServerEvent(socket, 'lobby:relay', (data) => {
      const { lobbyId, toUserId, type, payload } = z
        .object({ lobbyId: z.string(), toUserId: z.string().max(64).optional(), type: z.string(), payload: z.unknown() })
        .parse(data);
      ownLobby(socket, lobbyId);
      validateMessageType(type);
      validateJsonPayloadSize(payload);
      const msg = { from: 'server', seq: nextSeq(lobbyId), type, payload };
      if (toUserId) {
        if (lobbyManager.getLobbyByUserId(toUserId)?.id !== lobbyId) throw new HubError('PLAYER_NOT_IN_LOBBY');
        io.to(gameRoom(toUserId)).emit('message', msg);
      } else {
        io.to(lobbyId).emit('message', msg);
      }
      return { seq: msg.seq };
    });

    onServerEvent(socket, 'lobby:state', (data) => {
      const { lobbyId, toUserId, state } = z.object({ lobbyId: z.string(), toUserId: z.string().max(64).optional(), state: z.unknown() }).parse(data);
      ownLobby(socket, lobbyId);
      validateJsonPayloadSize(state);
      if (toUserId) {
        if (lobbyManager.getLobbyByUserId(toUserId)?.id !== lobbyId) throw new HubError('PLAYER_NOT_IN_LOBBY');
        io.to(gameRoom(toUserId)).emit('gameState', state as never);
      } else {
        io.to(lobbyId).emit('gameState', state as never);
      }
    });

    onServerEvent(socket, 'lobby:kick', (data) => {
      const { lobbyId, userId, reason } = z.object({ lobbyId: z.string(), userId: z.string().max(64), reason: z.string().trim().max(200).optional() }).parse(data);
      const lobby = ownLobby(socket, lobbyId);
      if (!lobby.players.some((p) => p.userId === userId)) throw new HubError('PLAYER_NOT_FOUND');
      lobbyManager.markKicked(lobbyId, userId);
      io.to(userRoom(userId)).emit('playerKicked', { lobbyId, ...(reason ? { reason } : {}) });
      leaveLobbyFlow(io, userId, { notifyInstance: false, reason: 'kicked' });
      sessionManager.dropIfIdle(userId);
    });

    onServerEvent(socket, 'lobby:setState', (data) => {
      const { lobbyId, state } = z.object({ lobbyId: z.string(), state: z.enum(['in_progress', 'closed']) }).parse(data);
      const lobby = ownLobby(socket, lobbyId);
      if (lobby.status === 'closed' || (state === 'in_progress' && lobby.status === 'in_progress')) throw new HubError('INVALID_STATE');
      lobbyManager.setStatus(lobbyId, state);
      broadcastLobbyChange(io, lobby, 'state_changed');
      if (state === 'closed') scheduleClosedRelease(io, lobbyId);
      return { lobby };
    });

    onServerEvent(socket, 'lobby:setSettings', (data) => {
      const { lobbyId, settings } = z.object({ lobbyId: z.string(), settings: z.record(z.unknown()) }).parse(data);
      ownLobby(socket, lobbyId);
      const maxBytes = getGame(hs.gameId)?.maxSettingsBytes ?? 8192;
      if (Buffer.byteLength(JSON.stringify(settings)) > maxBytes) throw new HubError('SETTINGS_TOO_LARGE');
      if (jsonDepth(settings) > 8) throw new HubError('INVALID_INPUT', 'Lobby-Einstellungen zu tief verschachtelt');
      const lobby = lobbyManager.setSettings(lobbyId, settings);
      if (!lobby) throw new HubError('INVALID_STATE');
      broadcastLobbyChange(io, lobby, 'settings_changed');
      return { lobby };
    });

    onServerEvent(socket, 'lobby:gameOver', (data) => {
      const { lobbyId, result } = z.object({ lobbyId: z.string(), result: z.unknown().optional() }).parse(data);
      const lobby = ownLobby(socket, lobbyId);
      if (lobby.status === 'closed') throw new HubError('INVALID_STATE');
      io.to(lobbyId).emit('gameOver', result as never);
      lobbyManager.setStatus(lobbyId, 'closed');
      broadcastLobbyChange(io, lobby, 'state_changed');
      scheduleClosedRelease(io, lobbyId);
    });

    onServerEvent(socket, 'lobby:close', (data) => {
      const { lobbyId } = z.object({ lobbyId: z.string() }).parse(data);
      const lobby = ownLobby(socket, lobbyId);
      if (lobby.status === 'closed') return;
      lobbyManager.setStatus(lobbyId, 'closed');
      broadcastLobbyChange(io, lobby, 'state_changed');
      scheduleClosedRelease(io, lobbyId);
    });

    onServerEvent(socket, 'server:status', (data) => {
      const { draining, capacity } = z.object({ draining: z.boolean().optional(), capacity: z.number().int().min(1).max(100_000).optional() }).parse(data ?? {});
      const s = servers.get(hs.serverId)!;
      if (draining !== undefined && draining !== s.draining) {
        s.draining = draining;
        markServerLobbies(s, draining ? 'draining' : 'ok', 'server_draining');
      }
      if (capacity !== undefined) s.capacity = capacity;
      return { info: toServerInfo(s) };
    });

    socket.on('disconnect', () => {
      const s = servers.get(hs.serverId);
      if (!s || s.socketId !== socket.id) return; // abgelöst durch neuere Verbindung
      s.connected = false;
      s.lostAt = Date.now();
      console.log(`[GameServer] "${hs.serverId}" getrennt`);
      markServerLobbies(s, 'lost', 'server_lost');
      if (s.lobbies.size === 0) {
        servers.delete(hs.serverId);
        return;
      }
      s.resumeTimer = setTimeout(() => {
        console.log(`[GameServer] Resume-Frist abgelaufen für "${hs.serverId}"`);
        dropServer(hs.serverId);
      }, resumeGraceMs());
      s.resumeTimer.unref();
    });
  });

  // ── Hooks: Lobby-Ereignisse → Game-Server ──
  setGameServerHooks({
    playerJoined: (lobby, userId, username) => emitToServer(lobby.server?.serverId, 'player:joined', { lobbyId: lobby.id, userId, username }),
    playerLeft: (lobbyId, serverId, userId, reason) => emitToServer(serverId, 'player:left', { lobbyId, userId, reason }),
    playerDisconnected: (lobby, userId) => emitToServer(lobby.server?.serverId, 'player:disconnected', { lobbyId: lobby.id, userId }),
    playerReconnected: (lobby, userId) => emitToServer(lobby.server?.serverId, 'player:reconnected', { lobbyId: lobby.id, userId }),
    lobbyUpdated: (lobby, reason) => emitToServer(lobby.server?.serverId, 'lobby:updated', { lobby, reason }),
    lobbyClosed: (lobbyId, serverId, reason) => {
      const s = serverId ? servers.get(serverId) : undefined;
      if (!s || !s.lobbies.delete(lobbyId)) return;
      emitToServer(serverId, 'lobby:closed', { lobbyId, reason });
    },
    action: (lobby, userId, type, payload) => {
      const s = lobby.server ? servers.get(lobby.server.serverId) : undefined;
      if (!s?.connected) throw new HubError('SERVER_UNAVAILABLE');
      emitToServer(s.serverId, 'player:action', { lobbyId: lobby.id, userId, type, payload });
      return true;
    },
  });
}
