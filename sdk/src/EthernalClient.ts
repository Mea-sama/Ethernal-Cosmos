import { EventEmitter } from 'events';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  Lobby,
  UserDataEntry,
  DataVisibility,
  PresenceUser,
  RelayMessage,
  RelayBinaryMessage,
} from '@ethernal/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

export type { Lobby, UserDataEntry, DataVisibility, PresenceUser } from '@ethernal/shared';
export type { RelayMessage, RelayBinaryMessage } from '@ethernal/shared';

export type BinaryPayload = Uint8Array | ArrayBuffer;

export interface EthernalClientOptions {
  /** Base URL of the Ethernal Cosmos hub server, e.g. "http://localhost:12346" */
  serverUrl: string;
  /**
   * Timeout in milliseconds for socket request/response patterns.
   * @default 5000
   */
  requestTimeout?: number;
}

export interface AuthResult {
  user: { userId: string; username: string };
  accessToken: string;
  refreshToken: string;
}

export interface LeaderboardEntry {
  key: string;
  value: unknown;
  visibility: DataVisibility;
  updatedAt: number;
}

type EthernalSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// ─── EthernalClient ───────────────────────────────────────────────────────────

/**
 * Main client for the Ethernal Cosmos platform.
 *
 * @example
 * ```ts
 * const client = new EthernalClient({ serverUrl: 'http://localhost:12346' });
 * await client.login('alice', 'secret');
 * client.on('lobbyUpdated', (lobby) => console.log(lobby));
 * const lobby = await client.createLobby({ gameId: 'chess', name: 'Fast game' });
 * ```
 */
export class EthernalClient extends EventEmitter {
  private readonly serverUrl: string;
  private readonly requestTimeout: number;

  private socket: EthernalSocket | null = null;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  constructor(options: EthernalClientOptions) {
    super();
    this.serverUrl = options.serverUrl.replace(/\/$/, '');
    this.requestTimeout = options.requestTimeout ?? 5000;
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────

  /** Register a new account and connect the socket. */
  async register(username: string, password: string): Promise<AuthResult> {
    const result = await this.post<AuthResult>('/auth/register', { username, password });
    this.storeTokens(result.accessToken, result.refreshToken);
    this.connectSocket();
    return result;
  }

  /** Log in and connect the socket. */
  async login(username: string, password: string): Promise<AuthResult> {
    const result = await this.post<AuthResult>('/auth/login', { username, password });
    this.storeTokens(result.accessToken, result.refreshToken);
    this.connectSocket();
    return result;
  }

  /** Log out: revoke refresh token and disconnect. */
  async logout(): Promise<void> {
    if (this.refreshToken) {
      await this.post('/auth/logout', { refreshToken: this.refreshToken }).catch(() => {
        /* best-effort */
      });
    }
    this.socket?.disconnect();
    this.socket = null;
    this.accessToken = null;
    this.refreshToken = null;
  }

  // ─── Lobby ────────────────────────────────────────────────────────────────

  /** Create a new lobby and wait for server confirmation. */
  createLobby(data: {
    gameId: string;
    name: string;
    isPrivate?: boolean;
    settings?: Record<string, unknown>;
  }): Promise<Lobby> {
    return this.socketRequest(
      () => this.getSocket().emit('createLobby', data),
      'lobbyCreated',
    );
  }

  /** Join an existing lobby by ID. Resolves with the updated lobby state. */
  joinLobby(lobbyId: string): Promise<Lobby> {
    return this.socketRequest(
      () => this.getSocket().emit('joinLobby', { lobbyId }),
      'lobbyUpdated',
    );
  }

  /** Join a private lobby using a 6-character invite code. */
  joinLobbyByCode(code: string): Promise<Lobby> {
    return this.socketRequest(
      () => this.getSocket().emit('joinLobbyByCode', { code }),
      'lobbyUpdated',
    );
  }

  /** Leave the current lobby. */
  leaveLobby(): void {
    this.getSocket().emit('leaveLobby');
  }

  /** Fetch all open lobbies for a given game. */
  listLobbies(gameId: string): Promise<Lobby[]> {
    return this.socketRequest(
      () => this.getSocket().emit('listLobbies', gameId),
      'lobbyList',
    );
  }

  /** Get a snapshot of the current lobby state. */
  getLobbyInfo(): Promise<Lobby> {
    return this.socketRequest(
      () => this.getSocket().emit('getLobbyInfo'),
      'lobbyInfo',
    );
  }

  /** (Host only) Kick a player from the lobby. */
  kickPlayer(playerId: string): void {
    this.getSocket().emit('kickPlayer', { playerId });
  }

  /** (Host only) Transfer the host role to another player. */
  transferHost(playerId: string): void {
    this.getSocket().emit('transferHost', { playerId });
  }

  // ─── Relay ────────────────────────────────────────────────────────────────

  /** Broadcast a typed message to all other players in the lobby. */
  sendToLobby(type: string, payload: unknown): void {
    this.getSocket().emit('sendToLobby', { type, payload });
  }

  /** Send a typed message directly to one player in the lobby. */
  sendToPlayer(playerId: string, type: string, payload: unknown): void {
    this.getSocket().emit('sendToPlayer', { playerId, type, payload });
  }

  /** Broadcast a binary message to all other players in the lobby. */
  sendToLobbyBinary(typeCode: number, payload: BinaryPayload): void {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    this.getSocket().emit('sendToLobbyBinary', { typeCode, payload: bytes });
  }

  /** Send a binary message directly to one player in the lobby. */
  sendToPlayerBinary(playerId: string, typeCode: number, payload: BinaryPayload): void {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    this.getSocket().emit('sendToPlayerBinary', { playerId, typeCode, payload: bytes });
  }

  /** Subscribe to relay messages with an optional payload type parameter for compile-time typing. */
  onMessage<TPayload = unknown>(listener: (data: RelayMessage<TPayload>) => void): this {
    return this.on('message', listener as (data: RelayMessage) => void);
  }

  /** Subscribe once to the next relay message. */
  onceMessage<TPayload = unknown>(listener: (data: RelayMessage<TPayload>) => void): this {
    return this.once('message', listener as (data: RelayMessage) => void);
  }

  /** Subscribe to incoming binary relay messages. */
  onBinaryMessage(listener: (data: RelayBinaryMessage) => void): this {
    return this.on('messageBinary', listener as (data: RelayBinaryMessage) => void);
  }

  /** Subscribe once to the next incoming binary relay message. */
  onceBinaryMessage(listener: (data: RelayBinaryMessage) => void): this {
    return this.once('messageBinary', listener as (data: RelayBinaryMessage) => void);
  }

  // ─── Game Actions ─────────────────────────────────────────────────────────

  /** Forward a game action to the running game subprocess. */
  sendGameAction(type: string, payload: unknown): void {
    this.getSocket().emit('gameAction', { type, payload });
  }

  // ─── User Data (Socket) ───────────────────────────────────────────────────

  /** Fetch the current user's own KV-data for a game (socket). */
  getUserData(gameId: string): Promise<UserDataEntry[]> {
    return this.socketRequest(
      () => this.getSocket().emit('getUserData', gameId),
      'userData',
      (res: { gameId: string; entries: UserDataEntry[] }) => res.entries,
    );
  }

  /**
   * Fetch visible KV-data for another player (socket).
   * Returns public data, plus lobby-scoped data if both players are in the same lobby.
   */
  getPlayerData(playerId: string, gameId: string): Promise<UserDataEntry[]> {
    return this.socketRequest(
      () => this.getSocket().emit('getPlayerData', { playerId, gameId }),
      'playerData',
      (res: { playerId: string; gameId: string; entries: UserDataEntry[] }) => res.entries,
    );
  }

  // ─── Presence ─────────────────────────────────────────────────────────────

  /** Request the current list of online users. Resolves once the server responds. */
  listPresence(): Promise<PresenceUser[]> {
    return this.socketRequest(
      () => this.getSocket().emit('presence:list'),
      'presence:list',
    );
  }

  // ─── User Data (REST) ─────────────────────────────────────────────────────

  /** Set or update a single KV entry for the current user. */
  async setKey(
    gameId: string,
    key: string,
    value: unknown,
    visibility?: DataVisibility,
  ): Promise<void> {
    await this.authedFetch(`/userdata/${encodeURIComponent(gameId)}/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value, ...(visibility ? { visibility } : {}) }),
    });
  }

  /** Delete a KV entry. */
  async deleteKey(gameId: string, key: string): Promise<void> {
    await this.authedFetch(`/userdata/${encodeURIComponent(gameId)}/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
  }

  /** Set or update multiple KV entries in one call (max 100). */
  async bulkSet(
    gameId: string,
    entries: Array<{ key: string; value: unknown; visibility?: DataVisibility }>,
  ): Promise<void> {
    await this.authedFetch(`/userdata/${encodeURIComponent(gameId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ data: entries }),
    });
  }

  /** Fetch all own KV entries for a game via REST. */
  async getAllData(gameId: string): Promise<UserDataEntry[]> {
    return this.authedFetch<UserDataEntry[]>(`/userdata/${encodeURIComponent(gameId)}`);
  }

  /**
   * Fetch the public numeric leaderboard for a game key.
   * @param order  'desc' (default) or 'asc'
   * @param limit  Max rows returned (default 10, max 100)
   */
  async getLeaderboard(
    gameId: string,
    key: string,
    options?: { order?: 'asc' | 'desc'; limit?: number },
  ): Promise<LeaderboardEntry[]> {
    const params = new URLSearchParams();
    if (options?.order) params.set('order', options.order);
    if (options?.limit != null) params.set('limit', String(options.limit));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.authedFetch<LeaderboardEntry[]>(
      `/leaderboard/${encodeURIComponent(gameId)}/${encodeURIComponent(key)}${qs}`,
    );
  }

  // ─── Internal: Socket ─────────────────────────────────────────────────────

  private connectSocket(): void {
    // Disconnect any existing socket
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }

    // Using an auth callback means socket.io will re-evaluate the token on
    // every (re)connect attempt — so a refreshed access token is used automatically.
    const socket: EthernalSocket = io(this.serverUrl, {
      auth: (cb) => cb({ token: `Bearer ${this.accessToken ?? ''}` }),
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
    });

    socket.on('connect', () => {
      this.emit('connected');
    });

    socket.on('disconnect', (reason) => {
      this.emit('disconnected', reason);
    });

    // If the token expired mid-session, refresh and reconnect
    socket.on('connect_error', async (err) => {
      if (err.message === 'INVALID_TOKEN' && this.refreshToken) {
        socket.disconnect();
        try {
          await this.doRefresh();
          this.connectSocket();
        } catch {
          this.emit('authError', 'Token konnte nicht erneuert werden');
        }
      } else if (err.message === 'UNAUTHENTICATED') {
        this.emit('authError', 'Nicht authentifiziert — bitte zuerst login() aufrufen');
      }
    });

    // Forward all server → client events onto the EthernalClient EventEmitter
    const s = socket as unknown as { on: (event: string, cb: (...args: unknown[]) => void) => void };
    const forward = (event: keyof ServerToClientEvents) => {
      s.on(event, (...args: unknown[]) => {
        this.emit(event as string, ...args);
      });
    };

    forward('lobbyCreated');
    forward('lobbyUpdated');
    forward('lobbyList');
    forward('lobbyInfo');
    forward('gameStarting');
    forward('gameState');
    forward('gameEvent');
    forward('gameOver');
    forward('playerKicked');
    forward('message');
    forward('messageBinary');
    forward('userData');
    forward('playerData');
    forward('presence:joined');
    forward('presence:left');
    forward('presence:list');
    // Note: 'error' events from the socket are handled separately to avoid
    // conflicting with Node's EventEmitter built-in 'error' behaviour.
    socket.on('error', (msg: string) => {
      this.emit('serverError', msg);
    });

    this.socket = socket;
  }

  private getSocket(): EthernalSocket {
    if (!this.socket?.connected) {
      throw new Error('Kein aktiver Socket — bitte zuerst login() oder register() aufrufen');
    }
    return this.socket;
  }

  /**
   * Emit a socket event and resolve when a specific response event fires.
   * Rejects on `error` from the server or when the timeout is reached.
   */
  private socketRequest<TResponse, TReturn = TResponse>(
    emit: () => void,
    successEvent: keyof ServerToClientEvents,
    transform?: (data: TResponse) => TReturn,
  ): Promise<TReturn> {
    return new Promise((resolve, reject) => {
      // Use a loosely-typed handle for dynamic event names
      const sock = this.getSocket() as unknown as {
        once: (event: string, cb: (...args: unknown[]) => void) => void;
        off: (event: string, cb: (...args: unknown[]) => void) => void;
      };

      const timer = setTimeout(() => {
        sock.off('error', onError);
        sock.off(successEvent as string, onSuccess);
        reject(new Error(`Timeout beim Warten auf "${String(successEvent)}"`));
      }, this.requestTimeout);

      const onError = (...args: unknown[]) => {
        clearTimeout(timer);
        sock.off(successEvent as string, onSuccess);
        reject(new Error(typeof args[0] === 'string' ? args[0] : 'Unbekannter Fehler'));
      };

      const onSuccess = (...args: unknown[]) => {
        clearTimeout(timer);
        sock.off('error', onError);
        const data = args[0] as TResponse;
        resolve(transform ? transform(data) : (data as unknown as TReturn));
      };

      sock.once('error', onError);
      sock.once(successEvent as string, onSuccess);
      emit();
    });
  }

  // ─── Internal: HTTP ───────────────────────────────────────────────────────

  private storeTokens(accessToken: string, refreshToken: string): void {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }

  private async doRefresh(): Promise<void> {
    if (!this.refreshToken) throw new Error('Kein Refresh-Token vorhanden');
    const result = await this.post<{ accessToken: string; refreshToken: string }>(
      '/auth/refresh',
      { refreshToken: this.refreshToken },
    );
    this.storeTokens(result.accessToken, result.refreshToken);
  }

  /** Authenticated fetch — auto-refreshes on 401. */
  private async authedFetch<T = void>(path: string, init: RequestInit = {}): Promise<T> {
    const doFetch = async (token: string | null): Promise<Response> => {
      return fetch(this.serverUrl + path, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...((init.headers as Record<string, string>) ?? {}),
        },
      });
    };

    let res = await doFetch(this.accessToken);

    // Attempt a single token refresh on 401
    if (res.status === 401 && this.refreshToken) {
      await this.doRefresh();
      res = await doFetch(this.accessToken);
    }

    if (res.status === 204) return undefined as T;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  /** Unauthenticated POST (used for auth endpoints). */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.serverUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(payload.error ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  // ─── Typed EventEmitter overloads ─────────────────────────────────────────

  on(event: 'connected', listener: () => void): this;
  on(event: 'disconnected', listener: (reason: string) => void): this;
  on(event: 'authError', listener: (message: string) => void): this;
  on(event: 'serverError', listener: (message: string) => void): this;
  on(event: 'lobbyCreated', listener: (lobby: Lobby) => void): this;
  on(event: 'lobbyUpdated', listener: (lobby: Lobby) => void): this;
  on(event: 'lobbyList', listener: (lobbies: Lobby[]) => void): this;
  on(event: 'lobbyInfo', listener: (lobby: Lobby) => void): this;
  on(event: 'gameStarting', listener: (data: { lobbyId: string; gameId: string }) => void): this;
  on(event: 'gameState', listener: (state: unknown) => void): this;
  on(event: 'gameEvent', listener: (event: { type: string; data: unknown }) => void): this;
  on(event: 'gameOver', listener: (result: unknown) => void): this;
  on(event: 'playerKicked', listener: (data: { lobbyId: string }) => void): this;
  on(event: 'message', listener: (data: RelayMessage) => void): this;
  on(event: 'messageBinary', listener: (data: RelayBinaryMessage) => void): this;
  on(event: 'userData', listener: (data: { gameId: string; entries: UserDataEntry[] }) => void): this;
  on(event: 'playerData', listener: (data: { playerId: string; gameId: string; entries: UserDataEntry[] }) => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  once(event: 'connected', listener: () => void): this;
  once(event: 'disconnected', listener: (reason: string) => void): this;
  once(event: 'authError', listener: (message: string) => void): this;
  once(event: 'serverError', listener: (message: string) => void): this;
  once(event: 'lobbyCreated', listener: (lobby: Lobby) => void): this;
  once(event: 'lobbyUpdated', listener: (lobby: Lobby) => void): this;
  once(event: 'lobbyList', listener: (lobbies: Lobby[]) => void): this;
  once(event: 'lobbyInfo', listener: (lobby: Lobby) => void): this;
  once(event: 'gameStarting', listener: (data: { lobbyId: string; gameId: string }) => void): this;
  once(event: 'gameState', listener: (state: unknown) => void): this;
  once(event: 'gameEvent', listener: (event: { type: string; data: unknown }) => void): this;
  once(event: 'gameOver', listener: (result: unknown) => void): this;
  once(event: 'playerKicked', listener: (data: { lobbyId: string }) => void): this;
  once(event: 'message', listener: (data: RelayMessage) => void): this;
  once(event: 'messageBinary', listener: (data: RelayBinaryMessage) => void): this;
  once(event: 'userData', listener: (data: { gameId: string; entries: UserDataEntry[] }) => void): this;
  once(event: 'playerData', listener: (data: { playerId: string; gameId: string; entries: UserDataEntry[] }) => void): this;
  once(event: string, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }
}
