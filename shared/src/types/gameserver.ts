// ─── Game-Server-Protokoll (Namespace /gameserver) ───────────────────────────
// Ein Game-Server ist ein Dienst, kein Lobby-Teilnehmer: ein Server bedient N Lobbys, eine Lobby hat 0..1 Server.

import type { Ack } from './errors';
import type { Lobby, LobbyChangeReason, LobbyStatus } from './index';

/** Handshake (socket.handshake.auth) eines Game-Servers */
export interface GameServerHandshake {
  serverKey: string;
  gameId: string;
  /** Stabile ID der Server-Instanz; gleiche ID = Resume derselben Instanz */
  serverId: string;
  region?: string;
  /** Max. gleichzeitige Lobbys */
  capacity: number;
  version?: string;
}

/** Öffentlicher Zustand eines verbundenen Game-Servers */
export interface GameServerInfo {
  serverId: string;
  gameId: string;
  region?: string;
  capacity: number;
  load: number;
  draining: boolean;
  connected: boolean;
  version?: string;
}

export interface GameServerPlayer {
  userId: string;
  username: string;
}

/** Wunsch des Spielers bei createLobby */
export interface ServerPreference {
  /** 'none' = bewusst ohne Server (nur bei serverSupport 'optional') */
  mode?: 'any' | 'none';
  region?: string;
}

/** Hub → Game-Server */
export interface HubToGameServerEvents {
  hello: (data: { serverId: string; gameId: string; resumed: boolean; lobbies: Lobby[] }) => void;
  /** Lobby wird diesem Server zugewiesen; der Server antwortet per Ack mit accept/reject */
  'lobby:assigned': (data: { lobby: Lobby; players: GameServerPlayer[] }, ack: (res: { accept: boolean; reason?: string }) => void) => void;
  'lobby:updated': (data: { lobby: Lobby; reason?: LobbyChangeReason }) => void;
  'lobby:closed': (data: { lobbyId: string; reason: 'closed' | 'dissolved' | 'host_left' | 'reassigned' }) => void;
  'player:joined': (data: { lobbyId: string } & GameServerPlayer) => void;
  'player:left': (data: { lobbyId: string; userId: string; reason: 'left' | 'kicked' | 'timeout' }) => void;
  'player:disconnected': (data: { lobbyId: string; userId: string }) => void;
  'player:reconnected': (data: { lobbyId: string; userId: string }) => void;
  /** Weitergeleitete gameAction eines Spielers */
  'player:action': (data: { lobbyId: string; userId: string; type: string; payload: unknown }) => void;
}

/** Game-Server → Hub (jeweils mit Ack) */
export interface GameServerToHubEvents {
  /** Nachricht an alle Lobby-Mitglieder (oder an `toUserId`) */
  'lobby:relay': (data: { lobbyId: string; toUserId?: string; type: string; payload?: unknown }, ack?: Ack<{ seq: number }>) => void;
  /** Spielzustand (`gameState`) an alle oder einen Spieler */
  'lobby:state': (data: { lobbyId: string; toUserId?: string; state: unknown }, ack?: Ack) => void;
  'lobby:kick': (data: { lobbyId: string; userId: string }, ack?: Ack) => void;
  'lobby:setState': (data: { lobbyId: string; state: Extract<LobbyStatus, 'in_progress' | 'closed'> }, ack?: Ack<{ lobby: Lobby }>) => void;
  'lobby:setSettings': (data: { lobbyId: string; settings: Record<string, unknown> }, ack?: Ack<{ lobby: Lobby }>) => void;
  'lobby:gameOver': (data: { lobbyId: string; result?: unknown }, ack?: Ack) => void;
  'lobby:close': (data: { lobbyId: string }, ack?: Ack) => void;
  /** Auslastung/Draining melden */
  'server:status': (data: { draining?: boolean; capacity?: number }, ack?: Ack<{ info: GameServerInfo }>) => void;
}
