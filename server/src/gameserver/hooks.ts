import type { Lobby, LobbyChangeReason, PlayerLeftReason } from '@ethernal/shared';

/**
 * Entkoppelt den Lobby-Code vom Game-Server-Namespace (vermeidet zirkuläre Imports).
 * Jeder Hook ist ein No-Op für Lobbys ohne Game-Server.
 */
export interface GameServerHooks {
  playerJoined(lobby: Lobby, userId: string, username: string): void;
  playerLeft(lobbyId: string, serverId: string | undefined, userId: string, reason: PlayerLeftReason): void;
  playerDisconnected(lobby: Lobby, userId: string): void;
  playerReconnected(lobby: Lobby, userId: string): void;
  lobbyUpdated(lobby: Lobby, reason?: LobbyChangeReason): void;
  lobbyClosed(lobbyId: string, serverId: string | undefined, reason: 'closed' | 'dissolved' | 'host_left'): void;
  /** true = Aktion wurde an den Game-Server weitergeleitet */
  action(lobby: Lobby, userId: string, type: string, payload: unknown): boolean;
}

const noop: GameServerHooks = {
  playerJoined: () => undefined,
  playerLeft: () => undefined,
  playerDisconnected: () => undefined,
  playerReconnected: () => undefined,
  lobbyUpdated: () => undefined,
  lobbyClosed: () => undefined,
  action: () => false,
};

export let gsHooks: GameServerHooks = noop;
export function setGameServerHooks(h: GameServerHooks): void {
  gsHooks = h;
}
