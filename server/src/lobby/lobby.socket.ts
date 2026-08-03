import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { verifyToken } from '../auth/auth.service';
import { lobbyManager } from './lobby.manager';
import { getGame } from '../games/game.registry';
import { instanceManager } from '../games/instance.manager';
import { bulkSet, getAllOwn, getVisibleData } from '../user-data/userdata.service';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
  IpcGameToHub,
  PresenceUser,
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

const SOCKET_LIMITS: Record<string, LimitRule> = {
  // Control plane
  createLobby: { refillPerSecond: 0.1, burst: 2 },
  joinLobby: { refillPerSecond: 0.25, burst: 4 },
  joinLobbyByCode: { refillPerSecond: 0.25, burst: 4 },
  kickPlayer: { refillPerSecond: 0.5, burst: 3 },
  transferHost: { refillPerSecond: 0.5, burst: 3 },
  listLobbies: { refillPerSecond: 5, burst: 15 },
  getLobbyInfo: { refillPerSecond: 5, burst: 15 },
  presenceList: { refillPerSecond: 3, burst: 10 },
  getUserData: { refillPerSecond: 8, burst: 20 },
  getPlayerData: { refillPerSecond: 8, burst: 20 },

  // Data plane (high-throughput): designed to sustain 120+ msg/s workloads.
  sendToLobby: { refillPerSecond: 250, burst: 500 },
  sendToPlayer: { refillPerSecond: 200, burst: 400 },
  gameAction: { refillPerSecond: 300, burst: 600 },
};

const LOBBY_LIMITS: Record<string, LimitRule> = {
  sendToLobby: { refillPerSecond: 1200, burst: 2400 },
  gameAction: { refillPerSecond: 1600, burst: 3200 },
};

const socketBuckets = new Map<string, Map<string, TokenBucket>>();
const lobbyBuckets = new Map<string, Map<string, TokenBucket>>();
const lastRateLimitNotice = new Map<string, number>();
const RATE_NOTICE_COOLDOWN_MS = 2000;

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

// ─── Presence Map ──────────────────────────────────────────────────────────────
// userId → PresenceUser (in-memory, wird bei connect/disconnect gepflegt)
const presenceMap = new Map<string, PresenceUser>();// userId → aktive socket.id für Game-Clients (für Session-Takeover)
const gameSocketMap = new Map<string, string>();
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
      handleLeave(socket, io);
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
        handleLeave(socket, io);
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
            LOBBY_FULL: 'Lobby ist voll',
          }[err.message] ?? 'Beitreten fehlgeschlagen'
        : 'Beitreten fehlgeschlagen';
    socket.emit('error', msg);
  }
}

// ─── Hilfsfunktion: Lobby verlassen und alle informieren ─────────────────────

function handleLeave(socket: AppSocket, io: AppServer): void {
  const { userId, username } = socket.data;
  const { lobby, dissolved } = lobbyManager.leaveLobby(userId);

  if (!lobby && !dissolved) return; // war in keiner Lobby

  const lobbyId = socket.data.currentLobbyId;
  socket.data.currentLobbyId = undefined;
  if (lobbyId) socket.leave(lobbyId);

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
  } else if (dissolved && lobbyId) {
    lobbyBuckets.delete(lobbyId);
  }
}
