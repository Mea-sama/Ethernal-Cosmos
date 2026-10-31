import type { SessionState } from '@ethernal/shared';

export interface Session {
  sessionId: string;
  socketId: string;
  clientType: 'game' | 'panel';
}

interface UserSessions {
  userId: string;
  username: string;
  sessions: Map<string, Session>; // socketId → Session
  /** Beim Spiel registriert (session:registerGame) — gilt für alle Sessions des Users */
  gameId?: string;
  clientVersion?: string;
  platform?: string;
}

/**
 * Pro-User-Sessionzustand. Ein User kann mehrere Sockets haben (Spiel-Client, Panel);
 * Lobby-Mitgliedschaft und gewähltes Spiel hängen am User, nicht am einzelnen Socket.
 */
class SessionManager {
  private users = new Map<string, UserSessions>();
  /** userId → Timer der Reconnect-Gnadenfrist */
  private graceTimers = new Map<string, NodeJS.Timeout>();

  add(userId: string, username: string, session: Session): UserSessions {
    let u = this.users.get(userId);
    if (!u) {
      u = { userId, username, sessions: new Map() };
      this.users.set(userId, u);
    }
    u.sessions.set(session.socketId, session);
    return u;
  }

  /** Entfernt eine Session; gibt zurück, ob dem User damit keine Session mehr bleibt. */
  remove(userId: string, socketId: string): { remaining: number } {
    const u = this.users.get(userId);
    if (!u) return { remaining: 0 };
    u.sessions.delete(socketId);
    return { remaining: u.sessions.size };
  }

  /** Verwirft den Zustand eines Users ohne Sessions (nur wenn er in keiner Gnadenfrist steckt). */
  dropIfIdle(userId: string): void {
    const u = this.users.get(userId);
    if (u && u.sessions.size === 0 && !this.graceTimers.has(userId)) this.users.delete(userId);
  }

  get(userId: string): UserSessions | undefined {
    return this.users.get(userId);
  }

  gameSessions(userId: string): Session[] {
    return [...(this.users.get(userId)?.sessions.values() ?? [])].filter((s) => s.clientType === 'game');
  }

  hasGameSession(userId: string): boolean {
    return this.gameSessions(userId).length > 0;
  }

  isConnected(userId: string): boolean {
    return (this.users.get(userId)?.sessions.size ?? 0) > 0;
  }

  setGame(userId: string, gameId: string, clientVersion?: string, platform?: string): void {
    const u = this.users.get(userId);
    if (!u) return;
    u.gameId = gameId;
    u.clientVersion = clientVersion;
    u.platform = platform;
  }

  getGameId(userId: string): string | undefined {
    return this.users.get(userId)?.gameId;
  }

  onlineGameUsers(): UserSessions[] {
    return [...this.users.values()].filter((u) => [...u.sessions.values()].some((s) => s.clientType === 'game'));
  }

  stateFor(userId: string, sessionId: string, lobbyId?: string): SessionState {
    const u = this.users.get(userId);
    return { sessionId, userId, username: u?.username ?? '', gameId: u?.gameId, lobbyId };
  }

  // ─── Reconnect-Gnadenfrist ─────────────────────────────────────────────────

  startGrace(userId: string, ms: number, onExpire: () => void): void {
    this.clearGrace(userId);
    const t = setTimeout(() => {
      this.graceTimers.delete(userId);
      onExpire();
    }, ms);
    t.unref();
    this.graceTimers.set(userId, t);
  }

  clearGrace(userId: string): boolean {
    const t = this.graceTimers.get(userId);
    if (!t) return false;
    clearTimeout(t);
    this.graceTimers.delete(userId);
    return true;
  }

  isInGrace(userId: string): boolean {
    return this.graceTimers.has(userId);
  }
}

export const sessionManager = new SessionManager();

export const userRoom = (userId: string): string => `user:${userId}`;
/** Room aller Spiel-Clients (ohne Panel) eines Users — Ziel für Relay und gameState-Zustellung */
export const gameRoom = (userId: string): string => `game:${userId}`;
