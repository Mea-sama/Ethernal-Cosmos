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

// ─── Presence Map ──────────────────────────────────────────────────────────────
// userId → PresenceUser (in-memory, wird bei connect/disconnect gepflegt)
const presenceMap = new Map<string, PresenceUser>();

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

      // Nur Spiel-Clients (nicht das Panel) sind auf eine aktive Sitzung beschränkt.
      // Das Panel läuft als zweite Verbindung im gleichen Browser-Tab — das ist erlaubt.
      if (clientType === 'game' && presenceMap.has(payload.userId)) {
        return next(new Error('ALREADY_CONNECTED'));
      }

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
    // Das Panel ist ein zweiter Socket desselben Users im selben Tab — es darf
    // die Presence weder überschreiben noch beim Disconnect entfernen.
    if (clientType === 'game') {
      presenceMap.set(userId, { userId, username });
      socket.broadcast.emit('presence:joined', { userId, username });
    }

    // ── presence:list ────────────────────────────────────────────────────────
    socket.on('presence:list', () => {
      socket.emit('presence:list', [...presenceMap.values()]);
    });

    // ── listLobbies ─────────────────────────────────────────────────────────
    socket.on('listLobbies', (gameId: string) => {
      const lobbies = lobbyManager.listLobbies(gameId);
      socket.emit('lobbyList', lobbies);
    });

    // ── createLobby ─────────────────────────────────────────────────────────
    socket.on('createLobby', async (data) => {
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
      joinLobbyById(socket, io, userId, username, lobbyId);
    });

    // ── joinLobbyByCode ──────────────────────────────────────────────────────
    socket.on('joinLobbyByCode', ({ code }) => {
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
      const lobby = lobbyManager.getLobbyByUserId(userId);
      if (!lobby) {
        socket.emit('error', 'Du bist in keiner Lobby');
        return;
      }
      socket.emit('lobbyInfo', lobby);
    });

    // ── kickPlayer ───────────────────────────────────────────────────────────
    socket.on('kickPlayer', async ({ playerId }) => {
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
      const lobbyId = socket.data.currentLobbyId;
      if (!lobbyId) {
        socket.emit('error', 'Du bist in keiner Lobby');
        return;
      }
      // An alle anderen in der Lobby senden (Sender ausgenommen)
      socket.to(lobbyId).emit('message', { from: userId, type, payload });
    });

    // ── sendToPlayer (Relay) ─────────────────────────────────────────────────
    socket.on('sendToPlayer', async ({ playerId, type, payload }) => {
      const lobbyId = socket.data.currentLobbyId;
      if (!lobbyId) {
        socket.emit('error', 'Du bist in keiner Lobby');
        return;
      }
      const allSockets = await io.in(lobbyId).fetchSockets();
      const target = allSockets.find((s) => s.data.userId === playerId);
      if (!target) {
        socket.emit('error', 'Spieler nicht erreichbar');
        return;
      }
      target.emit('message', { from: userId, type, payload });
    });
    // ── getUserData ──────────────────────────────────────────────────────────────
    socket.on('getUserData', async (gameId: string) => {
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
      const lobbyId = socket.data.currentLobbyId;
      if (!lobbyId || !instanceManager.isRunning(lobbyId)) return;
      instanceManager.sendToInstance(lobbyId, {
        type: 'PLAYER_ACTION',
        payload: { userId, action: data.type, data: data.payload },
      });
    });

    // ── disconnect ──────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`[Socket] "${username}" getrennt (${socket.id})`);

      if (clientType === 'game') {
        // Presence entfernen
        presenceMap.delete(userId);
        io.emit('presence:left', { userId });

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
  }
}
