import { v4 as uuidv4 } from 'uuid';
import type { Lobby, LobbyPlayer, LobbyStatus } from '@ethernal/shared';

export class LobbyManager {
  /** lobbyId → Lobby */
  private lobbies = new Map<string, Lobby>();

  /** userId → lobbyId (schnelles Nachschlagen) */
  private userLobbyIndex = new Map<string, string>();

  /** inviteCode → lobbyId */
  private inviteCodeIndex = new Map<string, string>();

  // ─── Erstellen ─────────────────────────────────────────────────────────────

  createLobby(
    userId: string,
    username: string,
    gameId: string,
    name: string,
    maxPlayers: number,
    hosted: boolean,
    isPrivate: boolean = false,
    settings: Record<string, unknown> = {}
  ): Lobby {
    if (this.userLobbyIndex.has(userId)) {
      throw new Error('ALREADY_IN_LOBBY');
    }

    const host: LobbyPlayer = { userId, username, isHost: true };
    const inviteCode = isPrivate ? this.generateInviteCode() : undefined;
    const lobby: Lobby = {
      id: uuidv4(),
      gameId,
      name: name.trim().slice(0, 64),
      hostId: userId,
      players: [host],
      maxPlayers,
      status: 'open',
      isPrivate,
      inviteCode,
      settings,
      hosted,
      createdAt: Date.now(),
    };

    this.lobbies.set(lobby.id, lobby);
    this.userLobbyIndex.set(userId, lobby.id);
    if (inviteCode) this.inviteCodeIndex.set(inviteCode, lobby.id);
    console.log(`[Lobby] Erstellt: "${lobby.name}" (${lobby.id}) für Spiel "${gameId}"${isPrivate ? ' [privat]' : ''}`);
    return lobby;
  }

  // ─── Beitreten ─────────────────────────────────────────────────────────────

  joinLobby(userId: string, username: string, lobbyId: string): Lobby {
    if (this.userLobbyIndex.has(userId)) {
      throw new Error('ALREADY_IN_LOBBY');
    }

    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) throw new Error('LOBBY_NOT_FOUND');
    if (lobby.status === 'closed') throw new Error('LOBBY_CLOSED');
    if (lobby.players.length >= lobby.maxPlayers) throw new Error('LOBBY_FULL');

    lobby.players.push({ userId, username, isHost: false });
    this.userLobbyIndex.set(userId, lobbyId);
    // Status auf 'full' setzen wenn maximale Spieleranzahl erreicht
    if (lobby.players.length >= lobby.maxPlayers) {
      lobby.status = 'full';
    }
    console.log(`[Lobby] "${username}" trat Lobby "${lobby.name}" bei`);
    return lobby;
  }

  // ─── Verlassen ─────────────────────────────────────────────────────────────

  /**
   * Entfernt den User aus seiner aktuellen Lobby.
   * Gibt die aktualisierte Lobby zurück, oder null wenn die Lobby aufgelöst wurde.
   */
  leaveLobby(userId: string): { lobby: Lobby | null; dissolved: boolean } {
    const lobbyId = this.userLobbyIndex.get(userId);
    if (!lobbyId) return { lobby: null, dissolved: false };

    this.userLobbyIndex.delete(userId);
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) return { lobby: null, dissolved: false };

    lobby.players = lobby.players.filter((p) => p.userId !== userId);

    // Lobby auflösen wenn leer
    if (lobby.players.length === 0) {
      this.lobbies.delete(lobbyId);
      if (lobby.inviteCode) this.inviteCodeIndex.delete(lobby.inviteCode);
      console.log(`[Lobby] Aufgelöst: "${lobby.name}" (${lobbyId})`);
      return { lobby: null, dissolved: true };
    }

    // Host-Rolle weitergeben wenn nötig
    if (lobby.hostId === userId) {
      const newHost = lobby.players[0];
      newHost.isHost = true;
      lobby.hostId = newHost.userId;
      console.log(`[Lobby] Host-Übergabe an "${newHost.username}" in "${lobby.name}"`);
    }

    // Status aktualisieren: war voll, jetzt wieder offen
    if (lobby.status === 'full') {
      lobby.status = 'open';
    }

    return { lobby, dissolved: false };
  }

  // ─── Status setzen ─────────────────────────────────────────────────────────

  setStatus(lobbyId: string, status: LobbyStatus): void {
    const lobby = this.lobbies.get(lobbyId);
    if (lobby) lobby.status = status;
  }

  // ─── Abfragen ──────────────────────────────────────────────────────────────

  getLobby(lobbyId: string): Lobby | undefined {
    return this.lobbies.get(lobbyId);
  }

  getLobbyByUserId(userId: string): Lobby | undefined {
    const lobbyId = this.userLobbyIndex.get(userId);
    return lobbyId ? this.lobbies.get(lobbyId) : undefined;
  }

  listLobbies(gameId: string): Lobby[] {
    return Array.from(this.lobbies.values()).filter(
      (l) => l.gameId === gameId && l.status === 'open' && !l.isPrivate
    );
  }

  getByInviteCode(code: string): Lobby | undefined {
    const lobbyId = this.inviteCodeIndex.get(code.toUpperCase());
    return lobbyId ? this.lobbies.get(lobbyId) : undefined;
  }

  // ─── Host-Aktionen ─────────────────────────────────────────────────────────

  /**
   * Host entfernt einen anderen Spieler aus der Lobby.
   * Gibt die aktualisierte Lobby zurück.
   */
  kickPlayer(requesterId: string, targetId: string): Lobby {
    const lobby = this.getLobbyByUserId(requesterId);
    if (!lobby) throw new Error('NOT_IN_LOBBY');
    if (lobby.hostId !== requesterId) throw new Error('NOT_HOST');
    if (requesterId === targetId) throw new Error('CANNOT_KICK_SELF');

    const target = lobby.players.find((p) => p.userId === targetId);
    if (!target) throw new Error('PLAYER_NOT_FOUND');

    lobby.players = lobby.players.filter((p) => p.userId !== targetId);
    this.userLobbyIndex.delete(targetId);

    if (lobby.status === 'full') lobby.status = 'open';
    console.log(`[Lobby] "${target.username}" wurde aus "${lobby.name}" gekickt`);
    return lobby;
  }

  /**
   * Host überträgt seine Rolle an einen anderen Spieler in der Lobby.
   * Gibt die aktualisierte Lobby zurück.
   */
  transferHost(requesterId: string, newHostId: string): Lobby {
    const lobby = this.getLobbyByUserId(requesterId);
    if (!lobby) throw new Error('NOT_IN_LOBBY');
    if (lobby.hostId !== requesterId) throw new Error('NOT_HOST');
    if (requesterId === newHostId) throw new Error('ALREADY_HOST');

    const newHost = lobby.players.find((p) => p.userId === newHostId);
    if (!newHost) throw new Error('PLAYER_NOT_FOUND');

    const currentHost = lobby.players.find((p) => p.userId === requesterId);
    if (currentHost) currentHost.isHost = false;

    newHost.isHost = true;
    lobby.hostId = newHostId;
    console.log(`[Lobby] Host-Übergabe an "${newHost.username}" in "${lobby.name}"`);
    return lobby;
  }

  // ─── Hilfsfunktionen ───────────────────────────────────────────────────────

  private generateInviteCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O/1/I zur Vermeidung von Verwechslungen
    let code: string;
    do {
      code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (this.inviteCodeIndex.has(code));
    return code;
  }
}

// Singleton – von Socket-Handler und Instance-Manager gemeinsam genutzt
export const lobbyManager = new LobbyManager();
