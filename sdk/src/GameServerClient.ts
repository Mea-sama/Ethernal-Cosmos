import { EventEmitter } from 'events';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type {
  HubToGameServerEvents,
  GameServerToHubEvents,
  GameServerInfo,
  GameServerPlayer,
  GameServerDataEntry,
  HubErrorPayload,
  Lobby,
  LobbyAssignReason,
  DataVisibility,
  DataWriteScope,
  UserDataEntry,
  UserDataOp,
  UserDataOpResult,
} from '@ethernal/shared';
import { EthernalError, connectError, hubError } from './EthernalClient';

export type { GameServerInfo, GameServerPlayer, GameServerDataEntry } from '@ethernal/shared';

// ─── Types ───────────────────────────────────────────────────────

export interface GameServerClientOptions {
  /** Base URL of the Ethernal Cosmos hub, e.g. "http://localhost:12346" */
  serverUrl: string;
  /** Per-game key (`esk_...`) issued with `POST /admin/game-servers/:gameId/keys`. */
  serverKey: string;
  /** The game this server runs. Its registry entry must have `serverSupport` `optional` or `required`. */
  gameId: string;
  /**
   * Stable ID of this server instance (`[A-Za-z0-9_.:-]`, max 64). Reconnecting with the same ID within the hub's
   * grace period (default 30 s) resumes the server and its lobbies; a second connection with the same ID replaces the first.
   */
  serverId: string;
  /** Maximum number of lobbies served at the same time. */
  capacity: number;
  /** Region tag used for `serverPreference.region` matching, e.g. `'eu'`. */
  region?: string;
  /** Free-form version string (max 32 chars). */
  version?: string;
  /**
   * Timeout in milliseconds for acked requests.
   * @default 5000
   */
  requestTimeout?: number;
  /**
   * Decides on every `lobby:assigned` request. Return `true` to accept, `false` (or `{ accept: false, reason }`) to
   * reject; the hub then tries the next candidate. Without a handler every assignment is accepted.
   * The hub waits `SERVER_ASSIGN_TIMEOUT_MS` (default 5 s) for the answer, so restore state quickly or accept first
   * and restore afterwards. A throwing handler rejects.
   */
  onAssign?: (assignment: LobbyAssignment) => AssignDecision | Promise<AssignDecision>;
}

/** Answer of {@link GameServerClientOptions.onAssign}. */
export type AssignDecision = boolean | { accept: boolean; reason?: string };

/** Why/how a lobby is assigned; `previousServerId`/`lostAt` are only set for `server_rebound`. */
export interface AssignInfo {
  /** `new_lobby`: fresh lobby, initialise. `server_rebound`: takeover of a lobby whose previous server was lost. */
  reason: LobbyAssignReason;
  /** Only with `server_rebound`: the server that was lost. */
  previousServerId?: string;
  /** Only with `server_rebound`: unix ms when that server was lost. */
  lostAt?: number;
}

/** Payload of `lobby:assigned`. */
export interface LobbyAssignment extends AssignInfo {
  lobby: Lobby;
  /** Current members of the lobby. */
  players: GameServerPlayer[];
}

/** Handshake answer: `resumed` is true when the hub still knew this `serverId`; `lobbies` are the lobbies it still owns. */
export interface GameServerHello {
  serverId: string;
  gameId: string;
  resumed: boolean;
  lobbies: Lobby[];
}

/** Optional parts of an authoritative data write. */
export interface GameServerWriteOptions {
  /** Omitted: keep the existing visibility (new keys: `private`). `'public'` marks a leaderboard key (numeric values only count). */
  visibility?: DataVisibility;
  /** `'server'` locks the key for client writes (implied by `'public'`). */
  writeScope?: DataWriteScope;
}

/** Result of {@link GameServerClient.incrementUserData} / {@link GameServerClient.setUserDataIf}. */
export interface GameServerWriteResult {
  key: string;
  value: unknown;
  version: number;
}

/**
 * Event name → listener argument tuple of every event `GameServerClient` emits. Hub events are forwarded 1:1
 * (`lobby:assigned` is emitted after the decision, with `accepted`).
 */
export type GameServerClientEvents = {
  /** Handshake finished (also after every automatic reconnect: check `hello.resumed`). */
  hello: [hello: GameServerHello];
  /** A lobby was assigned and answered; `accepted` tells what this client answered. */
  'lobby:assigned': [assignment: LobbyAssignment, accepted: boolean];
  'lobby:updated': Parameters<HubToGameServerEvents['lobby:updated']>;
  'lobby:closed': Parameters<HubToGameServerEvents['lobby:closed']>;
  'player:joined': Parameters<HubToGameServerEvents['player:joined']>;
  'player:left': Parameters<HubToGameServerEvents['player:left']>;
  'player:disconnected': Parameters<HubToGameServerEvents['player:disconnected']>;
  'player:reconnected': Parameters<HubToGameServerEvents['player:reconnected']>;
  /** A player's `sendGameAction`, forwarded to this server. */
  'player:action': Parameters<HubToGameServerEvents['player:action']>;
  /** Socket connected (before `hello`). */
  connected: [];
  /** Socket lost; the SDK reconnects automatically and the hub keeps the lobbies for its resume grace period. */
  disconnected: [reason: string];
  /** The hub refused a (re)connect, e.g. `INVALID_SERVER_KEY` or `RATE_LIMITED` (`error.retryAfterMs`). */
  connectError: [error: EthernalError];
};

type GsSocket = Socket<HubToGameServerEvents, GameServerToHubEvents>;
type RawSocket = { on(e: string, cb: (...a: any[]) => void): void; emit(e: string, ...a: unknown[]): void };

// ─── GameServerClient ─────────────────────────────────────────────

/**
 * Client for the hub's `/gameserver` namespace: run the authoritative logic of lobbies on your own server.
 * One instance serves many lobbies (up to `capacity`); a lobby has at most one server.
 *
 * Every request method returns a promise that rejects with {@link EthernalError} (`NOT_LOBBY_SERVER` for lobbies that
 * are not assigned to this server, `NOT_ALLOWED` for data writes of non-members, …). Hub events arrive through the
 * `EventEmitter` API, typed via {@link GameServerClientEvents}.
 *
 * @example
 * ```ts
 * const gs = new GameServerClient({ serverUrl, serverKey, gameId: 'chess', serverId: 'eu-1', capacity: 20, region: 'eu' });
 * gs.on('lobby:assigned', ({ lobby, reason }) => console.log(lobby.id, reason));
 * gs.on('player:action', async ({ lobbyId, userId, type, payload }) => {
 *   await gs.sendToLobby(lobbyId, 'moved', { userId, type, payload });
 * });
 * await gs.connect();
 * ```
 */
export class GameServerClient extends EventEmitter {
  private readonly opts: GameServerClientOptions;
  private readonly requestTimeout: number;
  private socket: GsSocket | null = null;
  /** Lobbies this server currently serves (assigned and not yet closed), by lobby ID. */
  readonly lobbies = new Map<string, Lobby>();

  constructor(options: GameServerClientOptions) {
    super();
    this.opts = { ...options, serverUrl: options.serverUrl.replace(/\/$/, '') };
    this.requestTimeout = options.requestTimeout ?? 5000;
  }

  // ─── Connection ───────────────────────────────────────────────────────────

  /**
   * Connect to the `/gameserver` namespace and resolve with the hub's `hello` once the server is ready for assignments.
   * Reconnects automatically afterwards (same `serverId` ⇒ resume within the hub's grace period, see `hello.resumed`).
   * @throws {EthernalError} `INVALID_SERVER_KEY`, `UNKNOWN_GAME`, `GAME_SERVER_NOT_ALLOWED` (game has `serverSupport: none`),
   *   `INVALID_INPUT`, `RATE_LIMITED` (`retryAfterMs`), `TIMEOUT`
   */
  connect(): Promise<GameServerHello> {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    const { serverUrl, serverKey, gameId, serverId, region, capacity, version } = this.opts;
    const socket: GsSocket = io(`${serverUrl}/gameserver`, {
      auth: { serverKey, gameId, serverId, capacity, ...(region ? { region } : {}), ...(version ? { version } : {}) },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionAttempts: Infinity,
    });
    this.socket = socket;

    const first = new Promise<GameServerHello>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('hello', onHello);
        socket.off('connect_error', onError);
      };
      const timer = setTimeout(() => {
        cleanup();
        this.abort(socket);
        reject(new EthernalError('TIMEOUT', 'Timeout beim Warten auf die Verbindung zum Hub'));
      }, this.requestTimeout);
      const onHello = (hello: GameServerHello) => {
        cleanup();
        resolve(hello);
      };
      const onError = (err: Error & { data?: unknown }) => {
        cleanup();
        this.abort(socket);
        reject(connectError(err) ?? new EthernalError(err.message as never, err.message));
      };
      socket.on('hello', onHello);
      socket.on('connect_error', onError);
    });

    const raw = socket as unknown as RawSocket;
    raw.on('connect', () => this.emit('connected'));
    raw.on('disconnect', (reason: string) => this.emit('disconnected', reason));
    raw.on('connect_error', (err: Error & { data?: unknown }) => {
      const e = connectError(err);
      if (e) this.emit('connectError', e);
    });
    raw.on('hello', (hello: GameServerHello) => {
      this.lobbies.clear();
      for (const lobby of hello.lobbies) this.lobbies.set(lobby.id, lobby);
      this.emit('hello', hello);
    });
    raw.on('lobby:assigned', (assignment: LobbyAssignment, ack: (r: { accept: boolean; reason?: string }) => void) => {
      void this.decide(assignment).then((d) => {
        if (d.accept) this.lobbies.set(assignment.lobby.id, assignment.lobby);
        ack(d);
        this.emit('lobby:assigned', assignment, d.accept);
      });
    });
    raw.on('lobby:updated', (data: { lobby: Lobby }) => {
      if (this.lobbies.has(data.lobby.id)) this.lobbies.set(data.lobby.id, data.lobby);
      this.emit('lobby:updated', data);
    });
    raw.on('lobby:closed', (data: { lobbyId: string }) => {
      this.lobbies.delete(data.lobbyId);
      this.emit('lobby:closed', data);
    });
    for (const event of ['player:joined', 'player:left', 'player:disconnected', 'player:reconnected', 'player:action'] as const) {
      raw.on(event, (data: unknown) => this.emit(event, data));
    }
    return first;
  }

  /** Close the connection. The hub starts its resume grace period for the lobbies; connect with the same `serverId` to resume. */
  disconnect(): void {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.lobbies.clear();
    this.emit('disconnected', 'io client disconnect');
  }

  /** Whether the socket is currently connected. */
  isConnected(): boolean {
    return !!this.socket?.connected;
  }

  // ─── Lobby actions ────────────────────────────────────────────────────────

  /**
   * Send a typed message to all members of a lobby (they receive `message` from sender `server`).
   * @param type 1–64 chars `[A-Za-z0-9_.:-]`
   * @returns the lobby-wide sequence number
   * @throws {EthernalError} `NOT_LOBBY_SERVER`, `INVALID_MESSAGE_TYPE`, `PAYLOAD_TOO_LARGE`
   */
  async sendToLobby(lobbyId: string, type: string, payload?: unknown): Promise<number> {
    return (await this.call<{ seq: number }>('lobby:relay', { lobbyId, type, payload })).seq;
  }

  /**
   * Send a typed message to one lobby member.
   * @throws {EthernalError} `PLAYER_NOT_IN_LOBBY`, plus those of {@link sendToLobby}
   */
  async sendToPlayer(lobbyId: string, userId: string, type: string, payload?: unknown): Promise<number> {
    return (await this.call<{ seq: number }>('lobby:relay', { lobbyId, toUserId: userId, type, payload })).seq;
  }

  /**
   * Push the authoritative game state: members receive `gameState`. With `toUserId` only that player does.
   * @throws {EthernalError} `NOT_LOBBY_SERVER`, `PLAYER_NOT_IN_LOBBY`, `PAYLOAD_TOO_LARGE`
   */
  async sendState(lobbyId: string, state: unknown, toUserId?: string): Promise<void> {
    await this.call('lobby:state', { lobbyId, state, ...(toUserId ? { toUserId } : {}) });
  }

  /**
   * Remove a player from the lobby. They receive `playerKicked { lobbyId, reason? }` and cannot rejoin this lobby
   * (`KICKED_FROM_LOBBY`) until the host lifts the kick with `unkickPlayer`.
   * @param reason optional text (max 200 chars) shown to the kicked player
   * @throws {EthernalError} `NOT_LOBBY_SERVER`, `PLAYER_NOT_FOUND`
   */
  async kickPlayer(lobbyId: string, userId: string, reason?: string): Promise<void> {
    await this.call('lobby:kick', { lobbyId, userId, ...(reason !== undefined ? { reason } : {}) });
  }

  /**
   * Set the lobby status: `'in_progress'` (match started) or `'closed'` (lobby dissolved).
   * @throws {EthernalError} `NOT_LOBBY_SERVER`, `INVALID_STATE`
   */
  async setLobbyState(lobbyId: string, state: 'in_progress' | 'closed'): Promise<Lobby> {
    return (await this.call<{ lobby: Lobby }>('lobby:setState', { lobbyId, state })).lobby;
  }

  /**
   * Replace the lobby settings; members get `lobbyUpdated` with reason `settings_changed`.
   * @throws {EthernalError} `NOT_LOBBY_SERVER`, `SETTINGS_TOO_LARGE`, `INVALID_INPUT`
   */
  async setLobbySettings(lobbyId: string, settings: Record<string, unknown>): Promise<Lobby> {
    return (await this.call<{ lobby: Lobby }>('lobby:setSettings', { lobbyId, settings })).lobby;
  }

  /**
   * End the match: members receive `gameOver` with `result` and the lobby closes.
   * @throws {EthernalError} `NOT_LOBBY_SERVER`, `INVALID_STATE` (already closed)
   */
  async gameOver(lobbyId: string, result?: unknown): Promise<void> {
    await this.call('lobby:gameOver', { lobbyId, ...(result !== undefined ? { result } : {}) });
  }

  /** Close the lobby without a result. @throws {EthernalError} `NOT_LOBBY_SERVER` */
  async closeLobby(lobbyId: string): Promise<void> {
    await this.call('lobby:close', { lobbyId });
  }

  // ─── Server status ────────────────────────────────────────────────────────

  /**
   * Report draining and/or capacity. With no fields it is a plain round trip (see {@link heartbeat}).
   * @returns the hub's view of this server
   */
  async updateStatus(status: { draining?: boolean; capacity?: number } = {}): Promise<GameServerInfo> {
    return (await this.call<{ info: GameServerInfo }>('server:status', status)).info;
  }

  /**
   * Stop receiving new lobbies; running lobbies continue (their `serverStatus` becomes `draining`).
   * Wait for `lobby:closed` events (see {@link lobbies}) before shutting down.
   */
  async drain(): Promise<GameServerInfo> {
    return this.updateStatus({ draining: true });
  }

  /** Accept new lobbies again after {@link drain}. */
  async undrain(): Promise<GameServerInfo> {
    return this.updateStatus({ draining: false });
  }

  /**
   * Application-level liveness probe: a round trip to the hub that returns the current server info (`load`, `draining`).
   * Transport keep-alive (socket.io ping/pong) runs automatically; the hub detects a dead server within its ping timeout.
   */
  async heartbeat(): Promise<GameServerInfo> {
    return this.updateStatus();
  }

  // ─── Authoritative player data ────────────────────────────────────────────
  // `userId` must be a (current or former) member of a lobby bound to this server, up to 60 s after it closed;
  // anything else fails with `NOT_ALLOWED`. Writes are server-scoped and audited.

  /**
   * Write one key of a player. `visibility: 'public'` creates a leaderboard key that clients can never overwrite.
   * @throws {EthernalError} `NOT_ALLOWED`, `DATA_VALUE_TOO_LARGE`, `DATA_QUOTA_EXCEEDED`, `INVALID_INPUT`
   */
  async setUserData(lobbyId: string, userId: string, key: string, value: unknown, options: GameServerWriteOptions = {}): Promise<void> {
    await this.call('data:set', { lobbyId, userId, key, value, ...options });
  }

  /** Write 1–100 keys of a player all-or-nothing. Errors: see {@link setUserData}. */
  async bulkSetUserData(lobbyId: string, userId: string, entries: GameServerDataEntry[]): Promise<void> {
    await this.call('data:bulk', { lobbyId, userId, entries });
  }

  /** Read all keys of a player for this game (including private ones). @throws {EthernalError} `NOT_ALLOWED` */
  async getUserData(lobbyId: string, userId: string): Promise<UserDataEntry[]> {
    return (await this.call<{ entries: UserDataEntry[] }>('data:get', { lobbyId, userId })).entries;
  }

  /**
   * Atomically add `by` to a numeric key (missing = 0), e.g. a win counter behind a leaderboard.
   * @throws {EthernalError} `NOT_ALLOWED`, `INVALID_INPUT` (existing value not a number / overflow)
   */
  async incrementUserData(lobbyId: string, userId: string, key: string, by: number, options: GameServerWriteOptions = {}): Promise<GameServerWriteResult> {
    return this.call<GameServerWriteResult>('data:increment', { lobbyId, userId, key, by, ...options });
  }

  /**
   * Compare-and-set on the key's version (`0` = key must not exist).
   * @throws {EthernalError} `VERSION_CONFLICT` with `error.data.current`, `NOT_ALLOWED`
   */
  async setUserDataIf(lobbyId: string, userId: string, key: string, value: unknown, expectedVersion: number, options: GameServerWriteOptions = {}): Promise<GameServerWriteResult> {
    return this.call<GameServerWriteResult>('data:setIf', { lobbyId, userId, key, value, expectedVersion, ...options });
  }

  /**
   * Run 1–100 operations (`set`, `increment`, `setIf`, `delete`) on a player's keys all-or-nothing.
   * @returns one result per op, in order
   * @throws {EthernalError} `VERSION_CONFLICT`, `NOT_ALLOWED`, `INVALID_INPUT`
   */
  async transactUserData(lobbyId: string, userId: string, ops: UserDataOp[]): Promise<UserDataOpResult[]> {
    return (await this.call<{ results: UserDataOpResult[] }>('data:transact', { lobbyId, userId, ops })).results;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private abort(socket: GsSocket): void {
    socket.removeAllListeners();
    socket.disconnect();
    if (this.socket === socket) this.socket = null;
  }

  private async decide(assignment: LobbyAssignment): Promise<{ accept: boolean; reason?: string }> {
    const handler = this.opts.onAssign;
    if (!handler) return { accept: true };
    try {
      const d = await handler(assignment);
      return typeof d === 'boolean' ? { accept: d } : d;
    } catch (e) {
      return { accept: false, reason: e instanceof Error ? e.message : 'handler failed' };
    }
  }

  /** Emit with an ack callback; rejects with EthernalError on failure or timeout. */
  private call<T = Record<string, never>>(event: string, data: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const sock = this.socket;
      if (!sock?.connected) {
        reject(new EthernalError('NOT_CONNECTED', 'Kein aktiver Socket — bitte zuerst connect() aufrufen'));
        return;
      }
      const timer = setTimeout(() => reject(new EthernalError('TIMEOUT', `Timeout beim Warten auf "${event}"`)), this.requestTimeout);
      (sock as unknown as RawSocket).emit(event, data, (res: { ok: boolean; error?: HubErrorPayload } & Record<string, unknown>) => {
        clearTimeout(timer);
        if (res.ok) {
          const { ok: _ok, ...rest } = res;
          resolve(rest as unknown as T);
        } else reject(hubError(res.error!));
      });
    });
  }

  // ─── Typed EventEmitter overloads ─────────────────────────────────────────

  on<K extends keyof GameServerClientEvents>(event: K, listener: (...args: GameServerClientEvents[K]) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  once<K extends keyof GameServerClientEvents>(event: K, listener: (...args: GameServerClientEvents[K]) => void): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  off<K extends keyof GameServerClientEvents>(event: K, listener: (...args: GameServerClientEvents[K]) => void): this;
  off(event: string | symbol, listener: (...args: any[]) => void): this;
  off(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }
}
