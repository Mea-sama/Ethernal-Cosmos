import { v4 as uuidv4 } from 'uuid';
import type { Lobby, LobbyPlayer, LobbyStatus } from '@ethernal/shared';
import { HubError } from '../errors';
import { getGame } from '../games/game.registry';

const RECENT_LOBBY_TTL_MS = 60_000;

export interface JoinOptions {
  /** Lobby muss zu diesem Spiel gehören (GAME_MISMATCH sonst) */
  gameId?: string;
  /** Beitritt über Einladungscode — erlaubt private Lobbys */
  viaCode?: boolean;
  /** Beitritt nach vom Host angenommener Anfrage (ignoriert Sperre) */
  bypassLock?: boolean;
}

export class LobbyManager {
  /** lobbyId → Lobby */
  private lobbies = new Map<string, Lobby>();

  /** userId → lobbyId (schnelles Nachschlagen) */
  private userLobbyIndex = new Map<string, string>();

  /** inviteCode → lobbyId */
  private inviteCodeIndex = new Map<string, string>();

  /** lobbyId → alle User, die jemals Mitglied waren (Autorisierung für IPC-Datenzugriffe) */
  private participants = new Map<string, Set<string>>();

  /** Aufgelöste Lobbys, deren Teilnehmer noch kurz Daten-IPC nutzen dürfen (z.B. finales SAVE_META) */
  private recent = new Map<string, { gameId: string; participants: Set<string>; until: number }>();

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
      throw new HubError('ALREADY_IN_LOBBY');
    }

    const host: LobbyPlayer = { userId, username, isHost: true, connected: true };
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
      locked: false,
      createdAt: Date.now(),
    };

    this.lobbies.set(lobby.id, lobby);
    this.userLobbyIndex.set(userId, lobby.id);
    this.participants.set(lobby.id, new Set([userId]));
    if (inviteCode) this.inviteCodeIndex.set(inviteCode, lobby.id);
    console.log(`[Lobby] Erstellt: "${lobby.name}" (${lobby.id}) für Spiel "${gameId}"${isPrivate ? ' [privat]' : ''}`);
    return lobby;
  }

  // ─── Beitreten ─────────────────────────────────────────────────────────────

  joinLobby(userId: string, username: string, lobbyId: string, opts: JoinOptions = {}): Lobby {
    if (this.userLobbyIndex.has(userId)) {
      throw new HubError('ALREADY_IN_LOBBY');
    }

    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) throw new HubError('LOBBY_NOT_FOUND');
    if (opts.gameId && lobby.gameId !== opts.gameId) throw new HubError('GAME_MISMATCH');
    if (lobby.isPrivate && !opts.viaCode) throw new HubError('LOBBY_PRIVATE');
    this.assertStatusJoinable(lobby);
    if (lobby.locked && !opts.bypassLock) throw new HubError('LOBBY_LOCKED');
    if (lobby.players.length >= lobby.maxPlayers) throw new HubError('LOBBY_FULL');

    lobby.players.push({ userId, username, isHost: false, connected: true });
    this.userLobbyIndex.set(userId, lobbyId);
    this.participants.get(lobbyId)?.add(userId);
    if (lobby.status === 'open' && lobby.players.length >= lobby.maxPlayers) {
      lobby.status = 'full';
    }
    console.log(`[Lobby] "${username}" trat Lobby "${lobby.name}" bei`);
    return lobby;
  }

  /** Prüft, ob ein Beitritt grundsätzlich möglich wäre (für Beitrittsanfragen), ohne beizutreten. */
  assertJoinable(userId: string, lobby: Lobby, opts: JoinOptions = {}): void {
    if (this.userLobbyIndex.has(userId)) throw new HubError('ALREADY_IN_LOBBY');
    if (opts.gameId && lobby.gameId !== opts.gameId) throw new HubError('GAME_MISMATCH');
    if (lobby.isPrivate && !opts.viaCode) throw new HubError('LOBBY_PRIVATE');
    this.assertStatusJoinable(lobby);
    if (lobby.players.length >= lobby.maxPlayers) throw new HubError('LOBBY_FULL');
  }

  private assertStatusJoinable(lobby: Lobby): void {
    if (lobby.status === 'closed') throw new HubError('LOBBY_CLOSED');
    if (lobby.status === 'in_progress' && !getGame(lobby.gameId)?.joinInProgress) throw new HubError('LOBBY_IN_PROGRESS');
  }

  // ─── Verlassen / Entfernen ─────────────────────────────────────────────────

  /**
   * Entfernt den User aus seiner aktuellen Lobby.
   * Gibt die aktualisierte Lobby zurück, oder dissolved=true wenn die Lobby aufgelöst wurde.
   */
  leaveLobby(userId: string): { lobby: Lobby | null; dissolved: boolean; lobbyId?: string; hostChanged?: boolean; evicted?: LobbyPlayer[] } {
    const lobbyId = this.userLobbyIndex.get(userId);
    if (!lobbyId) return { lobby: null, dissolved: false };

    this.userLobbyIndex.delete(userId);
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) return { lobby: null, dissolved: false };

    lobby.players = lobby.players.filter((p) => p.userId !== userId);

    if (lobby.players.length === 0) {
      this.removeLobby(lobbyId);
      return { lobby: null, dissolved: true, lobbyId };
    }

    // Host-Rolle weitergeben (Policy pro Spiel)
    let hostChanged = false;
    if (lobby.hostId === userId) {
      const policy = getGame(lobby.gameId)?.hostMigration ?? 'transfer';
      const connected = lobby.players.find((p) => p.connected !== false);
      if (policy === 'dissolve' || (policy === 'next_connected' && !connected)) {
        const evicted = lobby.players;
        this.removeLobby(lobbyId);
        return { lobby: null, dissolved: true, lobbyId, evicted };
      }
      hostChanged = true;
      const newHost = connected ?? lobby.players[0];
      newHost.isHost = true;
      lobby.hostId = newHost.userId;
      console.log(`[Lobby] Host-Übergabe an "${newHost.username}" in "${lobby.name}"`);
    }

    if (lobby.status === 'full') {
      lobby.status = 'open';
    }

    return { lobby, dissolved: false, lobbyId, hostChanged };
  }

  /** Löscht eine Lobby vollständig (Auflösung oder Rollback bei fehlgeschlagenem Start). */
  removeLobby(lobbyId: string): void {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby) return;
    for (const p of lobby.players) {
      if (this.userLobbyIndex.get(p.userId) === lobbyId) this.userLobbyIndex.delete(p.userId);
    }
    this.lobbies.delete(lobbyId);
    if (lobby.inviteCode) this.inviteCodeIndex.delete(lobby.inviteCode);
    const members = this.participants.get(lobbyId);
    this.participants.delete(lobbyId);
    if (members) {
      this.recent.set(lobbyId, { gameId: lobby.gameId, participants: members, until: Date.now() + RECENT_LOBBY_TTL_MS });
    }
    console.log(`[Lobby] Aufgelöst: "${lobby.name}" (${lobbyId})`);
  }

  // ─── Verbindungsstatus (Reconnect-Gnadenfrist) ─────────────────────────────

  setConnected(userId: string, connected: boolean): Lobby | undefined {
    const lobby = this.getLobbyByUserId(userId);
    const player = lobby?.players.find((p) => p.userId === userId);
    if (!lobby || !player) return undefined;
    player.connected = connected;
    if (connected) delete player.disconnectedAt;
    else player.disconnectedAt = Date.now();
    return lobby;
  }

  // ─── Status setzen ─────────────────────────────────────────────────────────

  setStatus(lobbyId: string, status: LobbyStatus): void {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby || lobby.status === 'closed') return;
    lobby.status = status;
  }

  setServer(lobbyId: string, server: Lobby['server'] | undefined): void {
    const lobby = this.lobbies.get(lobbyId);
    if (lobby) lobby.server = server;
  }

  setSettings(lobbyId: string, settings: Record<string, unknown>): Lobby | null {
    const lobby = this.lobbies.get(lobbyId);
    if (!lobby || lobby.status === 'closed') return null;
    lobby.settings = settings;
    return lobby;
  }

  allLobbies(): Lobby[] {
    return [...this.lobbies.values()];
  }

  /** Host setzt den Lobby-Zustand (Relay-Spiele): open/full → in_progress → closed; closed ist endgültig. */
  setStateByHost(requesterId: string, state: 'in_progress' | 'closed'): Lobby {
    const lobby = this.getLobbyByUserId(requesterId);
    if (!lobby) throw new HubError('NOT_IN_LOBBY');
    if (lobby.hostId !== requesterId) throw new HubError('NOT_HOST', 'Nur der Host kann den Lobby-Zustand ändern');
    if (lobby.status === 'closed' || (state === 'in_progress' && lobby.status === 'in_progress')) {
      throw new HubError('INVALID_STATE', 'Ungültiger Zustandswechsel');
    }
    lobby.status = state;
    return lobby;
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
      (l) =>
        l.gameId === gameId &&
        !l.isPrivate &&
        (l.status === 'open' ||
          (l.status === 'in_progress' && !!getGame(gameId)?.joinInProgress && l.players.length < l.maxPlayers))
    );
  }

  getByInviteCode(code: string): Lobby | undefined {
    const lobbyId = this.inviteCodeIndex.get(code.toUpperCase());
    return lobbyId ? this.lobbies.get(lobbyId) : undefined;
  }

  /**
   * Darf der Subprocess dieser Lobby Daten von/für diesen User lesen bzw. schreiben?
   * Nur für das Spiel der Lobby und nur für aktuelle oder frühere Teilnehmer.
   */
  isParticipant(lobbyId: string, gameId: string, userId: string): boolean {
    const lobby = this.lobbies.get(lobbyId);
    if (lobby) return lobby.gameId === gameId && !!this.participants.get(lobbyId)?.has(userId);
    const recent = this.recent.get(lobbyId);
    if (!recent) return false;
    if (recent.until < Date.now()) {
      this.recent.delete(lobbyId);
      return false;
    }
    return recent.gameId === gameId && recent.participants.has(userId);
  }

  // ─── Host-Aktionen ─────────────────────────────────────────────────────────

  /** Host entfernt einen anderen Spieler aus der Lobby. */
  kickPlayer(requesterId: string, targetId: string): Lobby {
    const lobby = this.getLobbyByUserId(requesterId);
    if (!lobby) throw new HubError('NOT_IN_LOBBY');
    if (lobby.hostId !== requesterId) throw new HubError('NOT_HOST', 'Nur der Host kann Spieler entfernen');
    if (requesterId === targetId) throw new HubError('CANNOT_KICK_SELF');

    const target = lobby.players.find((p) => p.userId === targetId);
    if (!target) throw new HubError('PLAYER_NOT_FOUND');

    lobby.players = lobby.players.filter((p) => p.userId !== targetId);
    this.userLobbyIndex.delete(targetId);

    if (lobby.status === 'full') lobby.status = 'open';
    console.log(`[Lobby] "${target.username}" wurde aus "${lobby.name}" gekickt`);
    return lobby;
  }

  /** Host überträgt seine Rolle an einen anderen Spieler in der Lobby. */
  transferHost(requesterId: string, newHostId: string): Lobby {
    const lobby = this.getLobbyByUserId(requesterId);
    if (!lobby) throw new HubError('NOT_IN_LOBBY');
    if (lobby.hostId !== requesterId) throw new HubError('NOT_HOST', 'Nur der Host kann die Rolle übertragen');
    if (requesterId === newHostId) throw new HubError('ALREADY_HOST');

    const newHost = lobby.players.find((p) => p.userId === newHostId);
    if (!newHost) throw new HubError('PLAYER_NOT_FOUND');

    const currentHost = lobby.players.find((p) => p.userId === requesterId);
    if (currentHost) currentHost.isHost = false;

    newHost.isHost = true;
    lobby.hostId = newHostId;
    console.log(`[Lobby] Host-Übergabe an "${newHost.username}" in "${lobby.name}"`);
    return lobby;
  }

  /** Host sperrt/entsperrt die Lobby. */
  setLocked(requesterId: string, locked: boolean): Lobby {
    const lobby = this.getLobbyByUserId(requesterId);
    if (!lobby) throw new HubError('NOT_IN_LOBBY');
    if (lobby.hostId !== requesterId) throw new HubError('NOT_HOST', 'Nur der Host kann die Lobby sperren/entsperren');
    lobby.locked = locked;
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
