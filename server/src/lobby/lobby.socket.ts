import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { verifyToken } from '../auth/auth.service';
import { lobbyManager } from './lobby.manager';
import { getGame } from '../games/game.registry';
import { instanceManager } from '../games/instance.manager';
import { bulkSet, getAllOwn, getVisibleData } from '../user-data/userdata.service';
import { serverLimits } from '../config/limits';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
  IpcGameToHub,
  PresenceUser,
  Lobby,
} from '@ethernal/shared';

type AppServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

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

function allowByBucket(
  bucketMap: Map<string, Map<string, TokenBucket>>,
  entityId: string,
  key: string,
  rule: LimitRule,
): boolean {
  const now = Date.now();
  const entityBuckets = bucketMap.get(entityId) ?? new Map<string, TokenBucket>();
  const bucket = entityBuckets.get(key) ?? { tokens: rule.burst, lastRefill: now };

  const elapsedSeconds = Math.max(0, (now - bucket.lastRefill) / 1000);
  bucket.tokens = Math.min(rule.burst, bucket.tokens + elapsedSeconds * rule.refillPerSecond);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    entityBuckets.set(key, bucket);
    bucketMap.set(entityId, entityBuckets);
    return false;
  }

  bucket.tokens -= 1;
  entityBuckets.set(key, bucket);
  bucketMap.set(entityId, entityBuckets);
  return true;
}

function allowSocketEvent(socket: AppSocket, key: keyof typeof SOCKET_LIMITS): boolean {
  const rule = SOCKET_LIMITS[key];
  return allowByBucket(socketBuckets, socket.id, key, rule);
}

function allowLobbyEvent(lobbyId: string, key: keyof typeof LOBBY_LIMITS): boolean {
  const rule = LOBBY_LIMITS[key];
  return allowByBucket(lobbyBuckets, lobbyId, key, rule);
}

function emitRateLimitError(socket: AppSocket, eventName: string): void {
  const key = `${socket.id}:${eventName}`;
  const now = Date.now();
  const last = lastRateLimitNotice.get(key) ?? 0;
  if (now - last < RATE_NOTICE_COOLDOWN_MS) return;
  lastRateLimitNotice.set(key, now);
  socket.emit('error', `Rate limit erreicht (${eventName})`);
}

function enforceSocketLimit(socket: AppSocket, eventName: keyof typeof SOCKET_LIMITS): boolean {
  if (allowSocketEvent(socket, eventName)) return true;
  emitRateLimitError(socket, eventName);
  return false;
}

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

function validateBinaryRelayInput(
  socket: AppSocket,
  data: { typeCode: number; payload: unknown },
): { typeCode: number; payload: Uint8Array } | null {
  if (!Number.isInteger(data.typeCode) || data.typeCode < 0 || data.typeCode > 65535) {
    socket.emit('error', 'Ungültiger Binary-Typcode');
    return null;
  }

  const payload = asBinaryPayload(data.payload);
  if (!payload) {
    socket.emit('error', 'Ungültige Binary-Payload');
    return null;
  }
  if (payload.byteLength > MAX_BINARY_PAYLOAD_BYTES) {
    socket.emit('error', `Binary-Payload zu groß (max ${MAX_BINARY_PAYLOAD_BYTES} Bytes)`);
    return null;
  }

  return { typeCode: data.typeCode, payload };
}

// ─── Presence Map ──────────────────────────────────────────────────────────────
// userId → PresenceUser (in-memory, wird bei connect/disconnect gepflegt)
const presenceMap = new Map<string, PresenceUser>();// userId → aktive socket.id für Game-Clients (für Session-Takeover)
const gameSocketMap = new Map<string, string>();

// ─── Beitrittsanfragen für gesperrte Lobbys ──────────────────────────────────
// lobbyId → (requesterId → ausstehende Anfrage mit Auto-Reject-Timer)
const joinRequests = new Map<string, Map<string, { username: string; timer: NodeJS.Timeout }>>();
const JOIN_REQUEST_TIMEOUT_MS = 15_000;

function clearJoinRequest(lobbyId: string, requesterId: string): void {
  const reqs = joinRequests.get(lobbyId);
  const entry = reqs?.get(requesterId);
  if (!entry) return;
  clearTimeout(entry.timer);
  reqs!.delete(requesterId);
  if (reqs!.size === 0) joinRequests.delete(lobbyId);
}

/** Bricht alle offenen Anfragen einer Lobby ab (Host gewechselt oder Lobby geschlossen). */
function rejectAllJoinRequests(io: AppServer, lobbyId: string, reason: 'host_changed' | 'lobby_closed'): void {
  const reqs = joinRequests.get(lobbyId);
  if (!reqs) return;
  for (const requesterId of [...reqs.keys()]) {
    clearJoinRequest(lobbyId, requesterId);
    const reqSocketId = gameSocketMap.get(requesterId);
    if (reqSocketId) io.to(reqSocketId).emit('joinRequestRejected', { lobbyId, reason });
  }
}

/** Entfernt alle offenen Anfragen eines Users (z.B. bei Disconnect) und informiert die jeweiligen Hosts. */
function withdrawAllRequestsFor(io: AppServer, requesterId: string, reason: 'cancelled' | 'timeout'): void {
  for (const [lobbyId, reqs] of [...joinRequests.entries()]) {
    if (!reqs.has(requesterId)) continue;
    clearJoinRequest(lobbyId, requesterId);
    const lobby = lobbyManager.getLobby(lobbyId);
    const hostSocketId = lobby ? gameSocketMap.get(lobby.hostId) : undefined;
    if (hostSocketId) io.to(hostSocketId).emit('joinRequestWithdrawn', { requesterId, reason });
  }
}

// ─── Validierung ─────────────────────────────────────────────────────────────

const CreateLobbySchema = z.object({
  gameId: z.string().min(1).max(32).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(64),
  isPrivate: z.boolean().optional().default(false),
  settings: z.record(z.unknown()).optional().default({}),
});

// ─── Socket.io Auth-Middleware ────────────────────────────────────────────────

/**
 * Prüft den JWT aus socket.handshake.auth.token bei jeder neuen Verbindung.
 * Client sendet: io({ auth: { token: "Bearer eyJ..." } })
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
      next();
    } catch {
      next(new Error('INVALID_TOKEN'));
    }
  });
}
// ─── IPC → Socket.io Routing ───────────────────────────────────────────────────────────────

/**
 * Registriert den IPC-Callback: leitet Subprocess-Nachrichten als
 * Socket.io-Events an alle Spieler im jeweiligen Lobby-Room weiter.
 */
export function registerIpcRouting(io: AppServer): void {
  instanceManager.setMessageCallback((lobbyId: string, msg: IpcGameToHub) => {
    switch (msg.type) {
      case 'GAME_STATE':
        io.to(lobbyId).emit('gameState', msg.payload);
        break;
      case 'GAME_STATE_FOR_USER': {
        // Sicherheitscheck: wie sendToPlayer — nur an Sockets liefern, die aktuell
        // noch Mitglied DIESER Lobby sind (verhindert Zustellung nach Lobby-Verlassen/-Wechsel).
        const targetLobby = lobbyManager.getLobbyByUserId(msg.payload.userId);
        if (!targetLobby || targetLobby.id !== lobbyId) break;
        const socketId = gameSocketMap.get(msg.payload.userId);
        if (socketId) io.to(socketId).emit('gameState', msg.payload.state);
        break;
      }
      case 'GAME_EVENT':
        io.to(lobbyId).emit('gameEvent', msg.payload);
        break;
      case 'GAME_OVER':
        io.to(lobbyId).emit('gameOver', msg.payload);
        lobbyManager.setStatus(lobbyId, 'closed');
        // Presence: lobbyStatus aller Spieler in dieser Lobby auf 'closed' setzen
        for (const [uid, pu] of presenceMap) {
          if (pu.lobbyId === lobbyId) {
            const updated = { ...pu, lobbyStatus: 'closed' as const };
            presenceMap.set(uid, updated);
            io.emit('presence:joined', updated);
          }
        }
        break;
      case 'SAVE_META': {
        const { userId, gameId, entries } = msg.payload;
        bulkSet(userId, gameId, entries).catch((err) =>
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
    const { userId, username, clientType } = socket.data;
    console.log(`[Socket] "${username}" verbunden als ${clientType} (${socket.id})`);

    // ── Presence: nur für Spiel-Clients verwalten ──────────────────────────────
    // Das Panel läuft als zweiter Socket desselben Users im selben Tab — es darf
    // die Presence weder überschreiben noch beim Disconnect entfernen.
    if (clientType === 'game') {
      // Session-Takeover: wenn der User bereits über ein anderes Gerät/Fenster
      // verbunden ist, den alten Socket trennen bevor der neue übernimmt.
      // Damit funktionieren F5, Navigation und Gerätewechsel sauber.
      const oldSocketId = gameSocketMap.get(userId);
      if (oldSocketId) {
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        if (oldSocket) {
          console.log(`[Socket] Session-Takeover für "${username}" — alter Socket ${oldSocketId} wird getrennt`);
          oldSocket.disconnect(true);
        }
      }
      gameSocketMap.set(userId, socket.id);
      presenceMap.set(userId, { userId, username });
      socket.broadcast.emit('presence:joined', { userId, username });
    }

    // ── presence:list ────────────────────────────────────────────────────────
    socket.on('presence:list', () => {
      if (!enforceSocketLimit(socket, 'presenceList')) return;
      socket.emit('presence:list', [...presenceMap.values()]);
    });

    // ── listLobbies ─────────────────────────────────────────────────────────
    socket.on('listLobbies', (gameId: string) => {
      if (!enforceSocketLimit(socket, 'listLobbies')) return;
      const lobbies = lobbyManager.listLobbies(gameId);
      socket.emit('lobbyList', lobbies);
    });

    // ── createLobby ─────────────────────────────────────────────────────────
    socket.on('createLobby', async (data) => {
      if (!enforceSocketLimit(socket, 'createLobby')) return;
      const parse = CreateLobbySchema.safeParse(data);
      if (!parse.success) {
        socket.emit('error', 'Ungültige Lobby-Daten');
        return;
      }
      const { gameId, name, isPrivate, settings } = parse.data;

      // maxPlayers kommt aus der Registry, nicht vom Client
      const game = getGame(gameId);
      if (!game) {
        socket.emit('error', 'Unbekanntes Spiel');
        return;
      }

      try {
        const lobby = lobbyManager.createLobby(userId, username, gameId, name, game.maxPlayers, game.hosted, isPrivate, settings);
        socket.data.currentLobbyId = lobby.id;
        socket.join(lobby.id);
        socket.emit('lobbyCreated', lobby);

        // Presence aktualisieren
        presenceMap.set(userId, { userId, username, lobbyId: lobby.id, gameId, lobbyStatus: lobby.status });
        io.emit('presence:joined', presenceMap.get(userId)!);

        // Subprocess sofort starten – solo play ist ab sofort möglich
        await instanceManager.startInstance(lobby);
      } catch (err: unknown) {
        if (err instanceof Error && err.message === 'ALREADY_IN_LOBBY') {
          socket.emit('error', 'Du bist bereits in einer Lobby');
        } else {
          console.error('[createLobby] Fehler:', err);
          socket.emit('error', 'Lobby konnte nicht erstellt werden');
        }
      }
    });

    // ── joinLobby ───────────────────────────────────────────────────────────
    socket.on('joinLobby', ({ lobbyId }) => {
      if (!enforceSocketLimit(socket, 'joinLobby')) return;
      joinLobbyById(socket, io, userId, username, lobbyId);
    });

    // ── joinLobbyByCode ──────────────────────────────────────────────────────
    socket.on('joinLobbyByCode', ({ code }) => {
      if (!enforceSocketLimit(socket, 'joinLobbyByCode')) return;
      const codeClean = z.string().min(6).max(6).safeParse(code?.trim().toUpperCase());
      if (!codeClean.success) {
        socket.emit('error', 'Ungültiger Einladungscode');
        return;
      }
      const lobby = lobbyManager.getByInviteCode(codeClean.data);
      if (!lobby) {
        socket.emit('error', 'Einladungscode nicht gefunden');
        return;
      }
      joinLobbyById(socket, io, userId, username, lobby.id);
    });

    // ── leaveLobby ──────────────────────────────────────────────────────────
    socket.on('leaveLobby', () => {
      handleLeave(socket, io, true);
    });

    // ── getLobbyInfo ─────────────────────────────────────────────────────────
    socket.on('getLobbyInfo', () => {
      if (!enforceSocketLimit(socket, 'getLobbyInfo')) return;
      const lobby = lobbyManager.getLobbyByUserId(userId);
      if (!lobby) {
        socket.emit('error', 'Du bist in keiner Lobby');
        return;
      }
      socket.emit('lobbyInfo', lobby);
    });

    // ── kickPlayer ───────────────────────────────────────────────────────────
    socket.on('kickPlayer', async ({ playerId }) => {
      if (!enforceSocketLimit(socket, 'kickPlayer')) return;
      try {
        const lobby = lobbyManager.kickPlayer(userId, playerId);
        // Dem gekickten Spieler Bescheid geben und ihn aus dem Room entfernen
        const allSockets = await io.in(lobby.id).fetchSockets();
        for (const s of allSockets) {
          if (s.data.userId === playerId) {
            s.emit('playerKicked', { lobbyId: lobby.id });
            s.leave(lobby.id);
            s.data.currentLobbyId = undefined;
            break;
          }
        }
        if (instanceManager.isRunning(lobby.id)) {
          instanceManager.sendToInstance(lobby.id, { type: 'PLAYER_LEAVE', payload: { userId: playerId } });
        }
        io.to(lobby.id).emit('lobbyUpdated', lobby);
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? ({
                NOT_IN_LOBBY: 'Du bist in keiner Lobby',
                NOT_HOST: 'Nur der Host kann Spieler entfernen',
                CANNOT_KICK_SELF: 'Du kannst dich nicht selbst kicken',
                PLAYER_NOT_FOUND: 'Spieler nicht in dieser Lobby',
              }[err.message] ?? 'Kick fehlgeschlagen')
            : 'Kick fehlgeschlagen';
        socket.emit('error', msg);
      }
    });

    // ── transferHost ─────────────────────────────────────────────────────────
    socket.on('transferHost', ({ playerId }) => {
      if (!enforceSocketLimit(socket, 'transferHost')) return;
      try {
        const lobby = lobbyManager.transferHost(userId, playerId);
        io.to(lobby.id).emit('lobbyUpdated', lobby);
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? ({
                NOT_IN_LOBBY: 'Du bist in keiner Lobby',
                NOT_HOST: 'Nur der Host kann die Rolle übertragen',
                ALREADY_HOST: 'Du bist bereits der Host',
                PLAYER_NOT_FOUND: 'Spieler nicht in dieser Lobby',
              }[err.message] ?? 'Übertragung fehlgeschlagen')
            : 'Übertragung fehlgeschlagen';
        socket.emit('error', msg);
      }
    });

    // ── lockLobby / unlockLobby ───────────────────────────────────────────────
    socket.on('lockLobby', () => {
      if (!enforceSocketLimit(socket, 'lockLobby')) return;
      try {
        const lobby = lobbyManager.setLocked(userId, true);
        io.to(lobby.id).emit('lobbyUpdated', lobby);
      } catch (err: unknown) {
        socket.emit('error', mapLockError(err));
      }
    });

    socket.on('unlockLobby', () => {
      if (!enforceSocketLimit(socket, 'unlockLobby')) return;
      try {
        const lobby = lobbyManager.setLocked(userId, false);
        io.to(lobby.id).emit('lobbyUpdated', lobby);
      } catch (err: unknown) {
        socket.emit('error', mapLockError(err));
      }
    });

    // ── requestJoinLobby / requestJoinLobbyByCode ─────────────────────────────
    socket.on('requestJoinLobby', ({ lobbyId }) => {
      if (!enforceSocketLimit(socket, 'requestJoinLobby')) return;
      const lobby = lobbyManager.getLobby(lobbyId);
      if (!lobby) {
        socket.emit('error', 'Lobby nicht gefunden');
        return;
      }
      startJoinRequest(io, socket, userId, username, lobby);
    });

    socket.on('requestJoinLobbyByCode', ({ code }) => {
      if (!enforceSocketLimit(socket, 'requestJoinLobbyByCode')) return;
      const codeClean = z.string().min(6).max(6).safeParse(code?.trim().toUpperCase());
      if (!codeClean.success) {
        socket.emit('error', 'Ungültiger Einladungscode');
        return;
      }
      const lobby = lobbyManager.getByInviteCode(codeClean.data);
      if (!lobby) {
        socket.emit('error', 'Einladungscode nicht gefunden');
        return;
      }
      startJoinRequest(io, socket, userId, username, lobby);
    });

    // ── cancelJoinRequest ─────────────────────────────────────────────────────
    socket.on('cancelJoinRequest', ({ lobbyId }) => {
      if (!enforceSocketLimit(socket, 'cancelJoinRequest')) return;
      if (!joinRequests.get(lobbyId)?.has(userId)) return;
      clearJoinRequest(lobbyId, userId);
      const lobby = lobbyManager.getLobby(lobbyId);
      const hostSocketId = lobby ? gameSocketMap.get(lobby.hostId) : undefined;
      if (hostSocketId) io.to(hostSocketId).emit('joinRequestWithdrawn', { requesterId: userId, reason: 'cancelled' });
    });

    // ── respondJoinRequest (Host) ─────────────────────────────────────────────
    socket.on('respondJoinRequest', async ({ requesterId, accept }) => {
      if (!enforceSocketLimit(socket, 'respondJoinRequest')) return;
      const lobby = lobbyManager.getLobbyByUserId(userId);
      if (!lobby || lobby.hostId !== userId) {
        socket.emit('error', 'Nur der Host kann Beitrittsanfragen beantworten');
        return;
      }
      const entry = joinRequests.get(lobby.id)?.get(requesterId);
      if (!entry) {
        socket.emit('error', 'Anfrage nicht gefunden oder bereits abgelaufen');
        return;
      }
      clearJoinRequest(lobby.id, requesterId);
      const reqSocketId = gameSocketMap.get(requesterId);

      if (!accept) {
        if (reqSocketId) io.to(reqSocketId).emit('joinRequestRejected', { lobbyId: lobby.id, reason: 'declined' });
        return;
      }

      try {
        const updated = lobbyManager.joinLobby(requesterId, entry.username, lobby.id, { bypassLock: true });
        const reqSocket = reqSocketId ? io.sockets.sockets.get(reqSocketId) : undefined;
        if (reqSocket) {
          reqSocket.data.currentLobbyId = updated.id;
          reqSocket.join(updated.id);
        }
        presenceMap.set(requesterId, {
          userId: requesterId,
          username: entry.username,
          lobbyId: updated.id,
          gameId: updated.gameId,
          lobbyStatus: updated.status,
        });
        io.emit('presence:joined', presenceMap.get(requesterId)!);
        io.to(updated.id).emit('lobbyUpdated', updated);
        if (instanceManager.isRunning(updated.id)) {
          instanceManager.sendToInstance(updated.id, {
            type: 'PLAYER_JOIN',
            payload: { userId: requesterId, username: entry.username },
          });
        }
        if (reqSocket) reqSocket.emit('joinRequestAccepted', { lobby: updated });
      } catch {
        if (reqSocketId) io.to(reqSocketId).emit('joinRequestRejected', { lobbyId: lobby.id, reason: 'lobby_closed' });
      }
    });

    // ── sendToLobby (Relay) ──────────────────────────────────────────────────
    socket.on('sendToLobby', ({ type, payload }) => {
      if (!enforceSocketLimit(socket, 'sendToLobby')) return;
      const lobbyId = socket.data.currentLobbyId;
      if (!lobbyId) {
        socket.emit('error', 'Du bist in keiner Lobby');
        return;
      }
      const currentLobby = lobbyManager.getLobbyByUserId(userId);
      if (!currentLobby || currentLobby.id !== lobbyId) {
        socket.emit('error', 'Lobby-Kontext ungültig');
        return;
      }
      if (!allowLobbyEvent(lobbyId, 'sendToLobby')) {
        emitRateLimitError(socket, 'sendToLobby:lobby');
        return;
      }
      // An alle anderen in der Lobby senden (Sender ausgenommen)
      socket.to(lobbyId).emit('message', { from: userId, type, payload });
    });

    // ── sendToLobbyBinary (Relay) ───────────────────────────────────────────
    socket.on('sendToLobbyBinary', ({ typeCode, payload }) => {
      if (!enforceSocketLimit(socket, 'sendToLobbyBinary')) return;
      const lobbyId = socket.data.currentLobbyId;
      if (!lobbyId) {
        socket.emit('error', 'Du bist in keiner Lobby');
        return;
      }
      const currentLobby = lobbyManager.getLobbyByUserId(userId);
      if (!currentLobby || currentLobby.id !== lobbyId) {
        socket.emit('error', 'Lobby-Kontext ungültig');
        return;
      }
      if (!allowLobbyEvent(lobbyId, 'sendToLobbyBinary')) {
        emitRateLimitError(socket, 'sendToLobbyBinary:lobby');
        return;
      }

      const binaryData = validateBinaryRelayInput(socket, { typeCode, payload });
      if (!binaryData) return;

      socket.to(lobbyId).emit('messageBinary', {
        from: userId,
        typeCode: binaryData.typeCode,
        payload: binaryData.payload,
      });
    });

    // ── sendToPlayer (Relay) ─────────────────────────────────────────────────
    socket.on('sendToPlayer', async ({ playerId, type, payload }) => {
      if (!enforceSocketLimit(socket, 'sendToPlayer')) return;
      const lobbyId = socket.data.currentLobbyId;
      if (!lobbyId) {
        socket.emit('error', 'Du bist in keiner Lobby');
        return;
      }
      const senderLobby = lobbyManager.getLobbyByUserId(userId);
      if (!senderLobby || senderLobby.id !== lobbyId) {
        socket.emit('error', 'Lobby-Kontext ungültig');
        return;
      }

      const targetLobby = lobbyManager.getLobbyByUserId(playerId);
      if (!targetLobby || targetLobby.id !== lobbyId) {
        socket.emit('error', 'Spieler nicht in derselben Lobby');
        return;
      }

      const targetSocketId = gameSocketMap.get(playerId);
      const target = targetSocketId ? io.sockets.sockets.get(targetSocketId) : undefined;
      if (!target) {
        socket.emit('error', 'Spieler nicht erreichbar');
        return;
      }
      target.emit('message', { from: userId, type, payload });
    });

    // ── sendToPlayerBinary (Relay) ──────────────────────────────────────────
    socket.on('sendToPlayerBinary', async ({ playerId, typeCode, payload }) => {
      if (!enforceSocketLimit(socket, 'sendToPlayerBinary')) return;
      const lobbyId = socket.data.currentLobbyId;
      if (!lobbyId) {
        socket.emit('error', 'Du bist in keiner Lobby');
        return;
      }
      const senderLobby = lobbyManager.getLobbyByUserId(userId);
      if (!senderLobby || senderLobby.id !== lobbyId) {
        socket.emit('error', 'Lobby-Kontext ungültig');
        return;
      }

      const targetLobby = lobbyManager.getLobbyByUserId(playerId);
      if (!targetLobby || targetLobby.id !== lobbyId) {
        socket.emit('error', 'Spieler nicht in derselben Lobby');
        return;
      }

      const targetSocketId = gameSocketMap.get(playerId);
      const target = targetSocketId ? io.sockets.sockets.get(targetSocketId) : undefined;
      if (!target) {
        socket.emit('error', 'Spieler nicht erreichbar');
        return;
      }

      const binaryData = validateBinaryRelayInput(socket, { typeCode, payload });
      if (!binaryData) return;

      target.emit('messageBinary', {
        from: userId,
        typeCode: binaryData.typeCode,
        payload: binaryData.payload,
      });
    });
    // ── getUserData ──────────────────────────────────────────────────────────────
    socket.on('getUserData', async (gameId: string) => {
      if (!enforceSocketLimit(socket, 'getUserData')) return;
      const parse = z.string().min(1).max(32).regex(/^[a-z0-9-]+$/).safeParse(gameId);
      if (!parse.success) {
        socket.emit('error', 'Ungültige Spiel-ID');
        return;
      }
      try {
        const entries = await getAllOwn(userId, parse.data);
        socket.emit('userData', { gameId: parse.data, entries });
      } catch (err) {
        console.error('[Socket] getUserData Fehler:', err);
        socket.emit('error', 'Fehler beim Laden der User-Daten');
      }
    });

    // ── getPlayerData ─────────────────────────────────────────────────────────
    socket.on('getPlayerData', async ({ playerId, gameId }) => {
      if (!enforceSocketLimit(socket, 'getPlayerData')) return;
      const parse = z.string().min(1).max(32).regex(/^[a-z0-9-]+$/).safeParse(gameId);
      if (!parse.success) {
        socket.emit('error', 'Ungültige Spiel-ID');
        return;
      }
      const requesterLobby = lobbyManager.getLobbyByUserId(userId);
      const targetLobby    = lobbyManager.getLobbyByUserId(playerId);
      const inSameLobby    = !!(requesterLobby && targetLobby && requesterLobby.id === targetLobby.id);
      try {
        const entries = await getVisibleData(playerId, parse.data, inSameLobby);
        socket.emit('playerData', { playerId, gameId: parse.data, entries });
      } catch (err) {
        console.error('[Socket] getPlayerData Fehler:', err);
        socket.emit('error', 'Fehler beim Laden der Spieler-Daten');
      }
    });
    // ── gameAction ───────────────────────────────────────────────────────────────
    socket.on('gameAction', (data) => {
      if (!enforceSocketLimit(socket, 'gameAction')) return;
      const lobbyId = socket.data.currentLobbyId;
      if (!lobbyId || !instanceManager.isRunning(lobbyId)) return;
      const currentLobby = lobbyManager.getLobbyByUserId(userId);
      if (!currentLobby || currentLobby.id !== lobbyId) return;
      if (!allowLobbyEvent(lobbyId, 'gameAction')) {
        emitRateLimitError(socket, 'gameAction:lobby');
        return;
      }
      instanceManager.sendToInstance(lobbyId, {
        type: 'PLAYER_ACTION',
        payload: { userId, action: data.type, data: data.payload },
      });
    });

    // ── disconnect ──────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`[Socket] "${username}" getrennt (${socket.id})`);
      socketBuckets.delete(socket.id);

      if (clientType === 'game') {
        // Nur entfernen wenn dieser Socket noch der aktive ist (kein Takeover)
        if (gameSocketMap.get(userId) === socket.id) {
          gameSocketMap.delete(userId);
          presenceMap.delete(userId);
          io.emit('presence:left', { userId });
        }

        // Laufende Spielinstanz über Disconnect informieren
        const currentLobby = socket.data.currentLobbyId;
        if (currentLobby && instanceManager.isRunning(currentLobby)) {
          instanceManager.sendToInstance(currentLobby, {
            type: 'PLAYER_DISCONNECT',
            payload: { userId },
          });
        }
        withdrawAllRequestsFor(io, userId, 'cancelled');
        handleLeave(socket, io, false);
      }
    });
  });
}

// ─── Hilfsfunktion: Lobby beitreten (gemeinsam für joinLobby + joinLobbyByCode) ──

function joinLobbyById(socket: AppSocket, io: AppServer, userId: string, username: string, lobbyId: string): void {
  try {
    const lobby = lobbyManager.joinLobby(userId, username, lobbyId);
    socket.data.currentLobbyId = lobby.id;
    socket.join(lobby.id);
    io.to(lobby.id).emit('lobbyUpdated', lobby);

    // Presence aktualisieren
    presenceMap.set(userId, { userId, username, lobbyId: lobby.id, gameId: lobby.gameId, lobbyStatus: lobby.status });
    io.emit('presence:joined', presenceMap.get(userId)!);

    if (instanceManager.isRunning(lobby.id)) {
      instanceManager.sendToInstance(lobby.id, {
        type: 'PLAYER_JOIN',
        payload: { userId, username },
      });
    }
  } catch (err: unknown) {
    const msg =
      err instanceof Error
        ? {
            ALREADY_IN_LOBBY: 'Du bist bereits in einer Lobby',
            LOBBY_NOT_FOUND: 'Lobby nicht gefunden',
            LOBBY_CLOSED: 'Lobby ist geschlossen',
            LOBBY_LOCKED: 'Lobby ist gesperrt — bitte Beitritt anfragen',
            LOBBY_FULL: 'Lobby ist voll',
          }[err.message] ?? 'Beitreten fehlgeschlagen'
        : 'Beitreten fehlgeschlagen';
    socket.emit('error', msg);
  }
}

// ─── Hilfsfunktion: Lobby verlassen und alle informieren ─────────────────────

function handleLeave(socket: AppSocket, io: AppServer, isExplicitLeave: boolean): void {
  const { userId, username } = socket.data;
  const wasHost = lobbyManager.getLobbyByUserId(userId)?.hostId === userId;
  const { lobby, dissolved } = lobbyManager.leaveLobby(userId);

  if (!lobby && !dissolved) return; // war in keiner Lobby

  const lobbyId = socket.data.currentLobbyId;
  socket.data.currentLobbyId = undefined;
  if (lobbyId) socket.leave(lobbyId);

  // Subprocess informieren: explizites Verlassen kennt keine Reconnect-Gnadenfrist
  // (Disconnects senden PLAYER_DISCONNECT bereits an anderer Stelle).
  if (isExplicitLeave && lobbyId && instanceManager.isRunning(lobbyId)) {
    instanceManager.sendToInstance(lobbyId, { type: 'PLAYER_LEAVE', payload: { userId } });
  }

  // Presence: Lobby/Game-Kontext des ausgetretenen Users zurücksetzen
  presenceMap.set(userId, { userId, username });
  io.emit('presence:joined', { userId, username }); // Broadcast: User ist jetzt ohne Lobby

  if (!dissolved && lobby) {
    // Verbleibende Spieler über den aktualisierten Stand informieren
    io.to(lobby.id).emit('lobbyUpdated', lobby);
    console.log(`[Lobby] "${username}" verließ "${lobby.name}"`);

    // Presence der verbleibenden Spieler aktualisieren (lobbyStatus kann sich geändert haben, z.B. wieder 'open')
    for (const player of lobby.players) {
      const existing = presenceMap.get(player.userId);
      if (existing?.lobbyId === lobby.id) {
        const updated: typeof existing = { ...existing, lobbyStatus: lobby.status };
        presenceMap.set(player.userId, updated);
        io.emit('presence:joined', updated);
      }
    }

    // Host gewechselt (war Host, ist es jetzt nicht mehr) → offene Anfragen sind hinfällig
    if (wasHost && lobby.hostId !== userId) {
      rejectAllJoinRequests(io, lobby.id, 'host_changed');
    }
  } else if (dissolved && lobbyId) {
    lobbyBuckets.delete(lobbyId);
    rejectAllJoinRequests(io, lobbyId, 'lobby_closed');
  }
}

// ─── Hilfsfunktion: Lock-Fehler zu Klartext-Meldung ──────────────────────────

function mapLockError(err: unknown): string {
  return err instanceof Error
    ? ({
        NOT_IN_LOBBY: 'Du bist in keiner Lobby',
        NOT_HOST: 'Nur der Host kann die Lobby sperren/entsperren',
      }[err.message] ?? 'Aktion fehlgeschlagen')
    : 'Aktion fehlgeschlagen';
}

// ─── Hilfsfunktion: Beitrittsanfrage starten (gemeinsam für ID + Invite-Code) ─

function startJoinRequest(io: AppServer, socket: AppSocket, userId: string, username: string, lobby: Lobby): void {
  if (lobbyManager.getLobbyByUserId(userId)) {
    socket.emit('error', 'Du bist bereits in einer Lobby');
    return;
  }
  if (lobby.status === 'closed') {
    socket.emit('error', 'Lobby ist geschlossen');
    return;
  }
  if (lobby.players.length >= lobby.maxPlayers) {
    socket.emit('error', 'Lobby ist voll');
    return;
  }

  // Nicht gesperrt → direkter Beitritt, keine Anfrage nötig
  if (!lobby.locked) {
    joinLobbyById(socket, io, userId, username, lobby.id);
    return;
  }

  if (joinRequests.get(lobby.id)?.has(userId)) {
    socket.emit('joinRequestPending', { lobbyId: lobby.id });
    return;
  }
  if (!allowLobbyEvent(lobby.id, 'requestJoinLobby')) {
    emitRateLimitError(socket, 'requestJoinLobby:lobby');
    return;
  }

  const timer = setTimeout(() => {
    clearJoinRequest(lobby.id, userId);
    socket.emit('joinRequestRejected', { lobbyId: lobby.id, reason: 'timeout' });
    const hostSocketId = gameSocketMap.get(lobby.hostId);
    if (hostSocketId) io.to(hostSocketId).emit('joinRequestWithdrawn', { requesterId: userId, reason: 'timeout' });
  }, JOIN_REQUEST_TIMEOUT_MS);

  const reqs = joinRequests.get(lobby.id) ?? new Map();
  reqs.set(userId, { username, timer });
  joinRequests.set(lobby.id, reqs);

  socket.emit('joinRequestPending', { lobbyId: lobby.id });
  const hostSocketId = gameSocketMap.get(lobby.hostId);
  if (hostSocketId) {
    io.to(hostSocketId).emit('joinRequestReceived', { lobbyId: lobby.id, requesterId: userId, username });
  }
}
