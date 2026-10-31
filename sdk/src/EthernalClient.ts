import { EventEmitter } from 'events';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  Lobby,
  UserDataEntry,
  DataVisibility,
  JoinRequestRejectReason,
  ServerMode,
  ErrorCode,
  HubErrorPayload,
  GameInfo,
  SessionState,
  BulkDataEntry,
  FriendInfo,
  FriendRequestResult,
  FriendRequestsResult,
  FriendPresence,
  SocialSettings,
  SocialSnapshot,
  NotificationCounts,
  NotificationListResult,
  DirectMessage,
  DmConversation,
  DmHistoryResult,
  LobbyInvite,
  FriendLobbyInfo,
  PublicUser,
  RelayMessage,
  RelayBinaryMessage,
} from '@ethernal/shared';

// ─── Types ───────────────────────────────────────────────────────

export type { Lobby, UserDataEntry } from '@ethernal/shared';
export type {
  FriendInfo, FriendRequestInfo, FriendRequestsResult, FriendPresence,
  SocialSettings, SocialSnapshot, HubNotification, NotificationBacklog,
  NotificationCounts, NotificationListResult, DirectMessage, DmConversation, DmHistoryResult, LobbyInvite,
  FriendLobbyInfo,
} from '@ethernal/shared';
export type { RelayMessage, RelayBinaryMessage, HubErrorPayload, GameInfo, SessionState, HelloPayload, BulkDataEntry } from '@ethernal/shared';

/**
 * Error thrown (as a rejected promise) by every SDK call.
 *
 * `code` is a stable machine-readable value: compare it with the `ErrorCode` constants, e.g.
 * `e.code === ErrorCode.LobbyFull`. The SDK adds three client-side codes:
 * `'TIMEOUT'` (no answer within `requestTimeout`), `'NOT_CONNECTED'` (no live socket) and
 * `'HTTP_ERROR'` (REST error without a hub error code). `message` is for display only.
 */
export class EthernalError extends Error {
  constructor(
    public readonly code: ErrorCode | 'TIMEOUT' | 'NOT_CONNECTED' | 'HTTP_ERROR',
    message: string,
    /** Set for `RATE_LIMITED`: retry no earlier than this many milliseconds from now. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'EthernalError';
  }
}

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

/** Result of `register()` and `login()`. */
export interface AuthResult {
  user: PublicUser;
  /** Short-lived JWT (default 1 h). Renewed automatically by the SDK. */
  accessToken: string;
  /** Opaque, rotating refresh token. */
  refreshToken: string;
}

/** One row of {@link EthernalClient.getLeaderboard}, already sorted (rank = array index + 1). */
export interface LeaderboardEntry {
  userId: string;
  username: string;
  value: number;
  /** unix ms */
  updatedAt: number;
}

/** Options of the relay send methods. */
export interface RelaySendOptions {
  /** Also deliver the message to the sender (all of the sender's sessions). For `sendToPlayer*` it allows targeting yourself. @default false */
  echo?: boolean;
}

/** Lobby creation options. */
export interface CreateLobbyOptions {
  /** Display name. */
  name: string;
  /** Private lobbies are hidden from `listLobbies()` and get a 6-character `inviteCode`. @default false */
  isPrivate?: boolean;
  /** Game-defined settings (opaque to the hub; limited by the game's `maxSettingsBytes`). */
  settings?: Record<string, unknown>;
  /** Games with `serverSupport` 'optional'/'required': `{ mode: 'none' }` = no game server, `{ mode: 'any', region? }` = ask for one. */
  serverPreference?: { mode?: ServerMode; region?: string };
}

/**
 * Event name → listener argument tuple of every event `EthernalClient` emits.
 * All hub → client socket events are forwarded 1:1, plus the lifecycle events below
 * (the legacy socket `error` string event is emitted as `serverError`).
 */
export type EthernalClientEvents =
  { [K in keyof ServerToClientEvents as K extends 'error' ? never : K]: Parameters<ServerToClientEvents[K]> } & {
    /** Socket (re)connected. */
    connected: [];
    /** Socket lost; `reason` is the socket.io reason. The SDK reconnects automatically (except after logout). */
    disconnected: [reason: string];
    /** Authentication could not be renewed / the socket was rejected. */
    authError: [message: string];
    /** Legacy human-readable error text pushed by the hub. Prefer `errorDetail` / rejected promises. */
    serverError: [message: string];
  };

type EthernalSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// ─── EthernalClient ───────────────────────────────────────────────────────────

/**
 * Main client for the Ethernal Cosmos platform: auth, session, lobbies, relay, user data and social.
 *
 * Every request method returns a promise that rejects with {@link EthernalError}. Server → client
 * events are exposed through the `EventEmitter` API (typed via {@link EthernalClientEvents}).
 *
 * @example
 * ```ts
 * const client = new EthernalClient({ serverUrl: 'http://localhost:12346' });
 * await client.login('alice', 'secret');
 * client.on('lobbyUpdated', (lobby, reason) => console.log(lobby.id, reason));
 * await client.registerGame('chess');
 * const lobby = await client.createLobby({ name: 'Fast game' });
 * ```
 */
export class EthernalClient extends EventEmitter {
  private readonly serverUrl: string;
  private readonly requestTimeout: number;

  private socket: EthernalSocket | null = null;
  private registeredGameId: string | null = null;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private abortJoinRace: ((error: EthernalError) => void) | null = null;

  constructor(options: EthernalClientOptions) {
    super();
    this.serverUrl = options.serverUrl.replace(/\/$/, '');
    this.requestTimeout = options.requestTimeout ?? 5000;
  }

  // ─── Auth ─────────────────────────────────────────────────────────────────

  /**
   * Register a new account and connect the socket. Resolves once the socket is connected.
   * @param username 3–32 characters, `[a-zA-Z0-9_-]`
   * @param password 8–128 characters
   * @throws {EthernalError} `USERNAME_TAKEN`, `INVALID_INPUT`, `RATE_LIMITED`
   */
  async register(username: string, password: string): Promise<AuthResult> {
    const result = await this.post<AuthResult>('/auth/register', { username, password });
    this.storeTokens(result.accessToken, result.refreshToken);
    await this.connectSocket();
    return result;
  }

  /**
   * Log in and connect the socket. Resolves once the socket is connected.
   * @throws {EthernalError} `INVALID_CREDENTIALS`, `INVALID_INPUT`, `RATE_LIMITED`
   */
  async login(username: string, password: string): Promise<AuthResult> {
    const result = await this.post<AuthResult>('/auth/login', { username, password });
    this.storeTokens(result.accessToken, result.refreshToken);
    await this.connectSocket();
    return result;
  }

  /** Log out: revoke the refresh token (best effort), disconnect and forget all session state. Never throws. */
  async logout(): Promise<void> {
    if (this.refreshToken) {
      await this.post('/auth/logout', { refreshToken: this.refreshToken }).catch(() => {
        /* best-effort */
      });
    }
    this.reset();
  }

  /**
   * Revoke all refresh tokens of this account and disconnect every session of the user (all devices).
   * @throws {EthernalError} `HTTP_ERROR` / `INVALID_TOKEN` if the access token is no longer valid
   */
  async logoutAll(): Promise<void> {
    await this.authedFetch('/auth/logout-all', { method: 'POST', body: '{}' });
    this.reset();
  }

  /**
   * Renew the tokens (rotates the refresh token) and hand the new access token to the live socket
   * (`auth:refresh`). The SDK calls this automatically when the hub warns with `AUTH_EXPIRED`.
   * @throws {EthernalError} `INVALID_REFRESH_TOKEN` | `REFRESH_TOKEN_REVOKED` | `REFRESH_TOKEN_EXPIRED` | `NOT_CONNECTED`
   */
  async refreshSocketAuth(): Promise<void> {
    await this.doRefresh();
    await this.call('auth:refresh', { token: this.accessToken });
  }

  /**
   * Close the socket without logging out: tokens and the registered game are kept, the hub keeps the
   * lobby seat for the game's reconnect grace period. Call `login()` again to resume.
   */
  disconnect(): void {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.emit('disconnected', 'io client disconnect');
  }

  // ─── Session ──────────────────────────────────────────────────────────────

  /**
   * Register the game this client plays. Required once per connection (after login) before
   * lobbies, relay or game actions can be used. The SDK re-registers automatically after a reconnect.
   * @throws {EthernalError} `UNKNOWN_GAME`, `CLIENT_OUTDATED`, `LEAVE_LOBBY_FIRST`
   */
  async registerGame(gameId: string, opts: { clientVersion?: string; platform?: string } = {}): Promise<{ game: GameInfo; state: SessionState }> {
    const res = await this.call<{ game: GameInfo; state: SessionState }>('session:registerGame', { gameId, ...opts });
    this.registeredGameId = gameId;
    return res;
  }

  /** Pull the current session state (game + lobby), e.g. after a reconnect. `lobby` is only set while you are in one. */
  getSessionState(): Promise<{ state: SessionState; lobby?: Lobby }> {
    return this.call('session:getState');
  }

  // ─── Lobby ────────────────────────────────────────────────────────────────

  /**
   * Create a lobby for the registered game; the caller becomes host.
   * @throws {EthernalError} `GAME_NOT_REGISTERED`, `ALREADY_IN_LOBBY`, `SETTINGS_TOO_LARGE`, `INVALID_INPUT`,
   *   `LOBBY_START_FAILED`, `INSTANCE_LIMIT`, `NO_GAME_SERVER_AVAILABLE` (required game server unavailable)
   */
  async createLobby(data: CreateLobbyOptions): Promise<Lobby> {
    return (await this.call<{ lobby: Lobby }>('createLobby', data)).lobby;
  }

  /**
   * Join a public lobby of the registered game by ID.
   * @throws {EthernalError} `LOBBY_NOT_FOUND`, `LOBBY_FULL`, `LOBBY_LOCKED`, `LOBBY_CLOSED`, `LOBBY_IN_PROGRESS`,
   *   `LOBBY_PRIVATE`, `GAME_MISMATCH`, `ALREADY_IN_LOBBY`
   */
  async joinLobby(lobbyId: string): Promise<Lobby> {
    return (await this.call<{ lobby: Lobby }>('joinLobby', { lobbyId })).lobby;
  }

  /**
   * Join a lobby (also a private one) with its 6-character invite code.
   * @throws {EthernalError} `INVALID_INVITE_CODE`, `INVITE_CODE_NOT_FOUND`, `LOBBY_FULL`, `LOBBY_LOCKED`, `ALREADY_IN_LOBBY`
   */
  async joinLobbyByCode(code: string): Promise<Lobby> {
    return (await this.call<{ lobby: Lobby }>('joinLobbyByCode', { code })).lobby;
  }

  /**
   * Leave the current lobby (hands the host role on if you were host).
   * @throws {EthernalError} `NOT_IN_LOBBY`
   */
  async leaveLobby(): Promise<void> {
    await this.call('leaveLobby');
  }

  /** Open public lobbies of the registered game. @throws {EthernalError} `GAME_NOT_REGISTERED` */
  async listLobbies(): Promise<Lobby[]> {
    return (await this.call<{ lobbies: Lobby[] }>('listLobbies')).lobbies;
  }

  /** Snapshot of the current lobby. @throws {EthernalError} `NOT_IN_LOBBY` */
  async getLobbyInfo(): Promise<Lobby> {
    return (await this.call<{ lobby: Lobby }>('getLobbyInfo')).lobby;
  }

  /**
   * (Host only) Kick a player; they receive `playerKicked`.
   * @throws {EthernalError} `NOT_HOST`, `CANNOT_KICK_SELF`, `PLAYER_NOT_FOUND`
   */
  async kickPlayer(playerId: string): Promise<void> {
    await this.call('kickPlayer', { playerId });
  }

  /**
   * (Host only) Hand the host role to another player.
   * @throws {EthernalError} `NOT_HOST`, `ALREADY_HOST`, `PLAYER_NOT_FOUND`
   */
  async transferHost(playerId: string): Promise<void> {
    await this.call('transferHost', { playerId });
  }

  /**
   * (Host only) Lock the lobby: further joins (also by invite code) need an accepted join request.
   * @throws {EthernalError} `NOT_HOST`, `NOT_IN_LOBBY`
   */
  async lockLobby(): Promise<void> {
    await this.call('lockLobby');
  }

  /**
   * (Host only) Unlock the lobby. Pending join requests are rejected with `unlocked`.
   * @throws {EthernalError} `NOT_HOST`, `NOT_IN_LOBBY`
   */
  async unlockLobby(): Promise<void> {
    await this.call('unlockLobby');
  }

  /**
   * (Host only) Set the lobby state for games without a game subprocess/server:
   * `'in_progress'` (match started) or `'closed'` (match over; the lobby is dissolved).
   * @throws {EthernalError} `NOT_HOST`, `INVALID_STATE`, `INVALID_INPUT`
   */
  async setLobbyState(state: 'in_progress' | 'closed'): Promise<Lobby> {
    const res = await this.call<{ lobby: Lobby }>('setLobbyState', { state });
    return res.lobby;
  }

  /**
   * Request to join a locked lobby by ID. Resolves with the lobby once the host accepts (you are
   * then already a member). If the lobby is not locked, you join immediately.
   * @throws {EthernalError} `LOBBY_LOCKED` when the host declined / the request timed out (~15 s) / the lobby changed;
   *   `LOBBY_NOT_FOUND`, `LOBBY_FULL`, `ALREADY_IN_LOBBY`, `GAME_MISMATCH`, `TIMEOUT`
   */
  requestJoinLobby(lobbyId: string): Promise<Lobby> {
    return this.joinRequestRace('requestJoinLobby', { lobbyId });
  }

  /** Like {@link requestJoinLobby}, addressed by invite code. Also `INVALID_INVITE_CODE`, `INVITE_CODE_NOT_FOUND`. */
  requestJoinLobbyByCode(code: string): Promise<Lobby> {
    return this.joinRequestRace('requestJoinLobbyByCode', { code });
  }

  /**
   * Withdraw your own pending join request; the pending {@link requestJoinLobby} promise rejects
   * with `JOIN_REQUEST_NOT_FOUND`. The host receives `joinRequestWithdrawn` (reason `cancelled`).
   * @throws {EthernalError} `JOIN_REQUEST_NOT_FOUND`
   */
  async cancelJoinRequest(lobbyId: string): Promise<void> {
    await this.call('cancelJoinRequest', { lobbyId });
    this.abortJoinRace?.(new EthernalError('JOIN_REQUEST_NOT_FOUND', 'Beitrittsanfrage zurückgezogen'));
  }

  /**
   * (Host only) Accept or reject a pending join request (see the `joinRequestReceived` event).
   * @throws {EthernalError} `NOT_HOST`, `JOIN_REQUEST_NOT_FOUND`, `LOBBY_FULL`
   */
  async respondJoinRequest(requesterId: string, accept: boolean): Promise<void> {
    await this.call('respondJoinRequest', { requesterId, accept });
  }

  // ─── Relay ────────────────────────────────────────────────────────────────

  /**
   * Broadcast a typed JSON message to all other lobby members (they receive `message`).
   * @param type 1–64 chars `[A-Za-z0-9_.:-]`
   * @throws {EthernalError} `NOT_IN_LOBBY`, `INVALID_MESSAGE_TYPE`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`
   */
  async sendToLobby(type: string, payload: unknown, opts: RelaySendOptions = {}): Promise<void> {
    await this.call('sendToLobby', { type, payload, ...(opts.echo ? { echo: true } : {}) });
  }

  /**
   * Send a typed JSON message to one lobby member (they receive `message`).
   * @throws {EthernalError} `PLAYER_NOT_IN_LOBBY`, `PLAYER_UNREACHABLE`, `CANNOT_TARGET_SELF` (unless `echo`), plus those of {@link sendToLobby}
   */
  async sendToPlayer(playerId: string, type: string, payload: unknown, opts: RelaySendOptions = {}): Promise<void> {
    await this.call('sendToPlayer', { playerId, type, payload, ...(opts.echo ? { echo: true } : {}) });
  }

  /**
   * Broadcast a binary message to all other lobby members (they receive `messageBinary`).
   * @param typeCode integer 0..65535
   * @throws {EthernalError} `INVALID_BINARY_TYPECODE`, `INVALID_BINARY_PAYLOAD`, `BINARY_PAYLOAD_TOO_LARGE`, `NOT_IN_LOBBY`
   */
  async sendToLobbyBinary(typeCode: number, payload: BinaryPayload, opts: RelaySendOptions = {}): Promise<void> {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    await this.call('sendToLobbyBinary', { typeCode, payload: bytes, ...(opts.echo ? { echo: true } : {}) });
  }

  /** Send a binary message to one lobby member. Errors: see {@link sendToPlayer} and {@link sendToLobbyBinary}. */
  async sendToPlayerBinary(playerId: string, typeCode: number, payload: BinaryPayload, opts: RelaySendOptions = {}): Promise<void> {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    await this.call('sendToPlayerBinary', { playerId, typeCode, payload: bytes, ...(opts.echo ? { echo: true } : {}) });
  }

  /** Subscribe to relay messages (`message` event) with a compile-time payload type. */
  onMessage<TPayload = unknown>(listener: (data: RelayMessage<TPayload>) => void): this {
    return this.on('message', listener as (data: RelayMessage) => void);
  }

  /** Subscribe once to the next relay message. */
  onceMessage<TPayload = unknown>(listener: (data: RelayMessage<TPayload>) => void): this {
    return this.once('message', listener as (data: RelayMessage) => void);
  }

  /** Subscribe to incoming binary relay messages (`messageBinary` event). */
  onBinaryMessage(listener: (data: RelayBinaryMessage) => void): this {
    return this.on('messageBinary', listener);
  }

  /** Subscribe once to the next incoming binary relay message. */
  onceBinaryMessage(listener: (data: RelayBinaryMessage) => void): this {
    return this.once('messageBinary', listener);
  }

  // ─── Game Actions ─────────────────────────────────────────────────────────

  /**
   * Forward a game action to the lobby's game subprocess or game server.
   * @throws {EthernalError} `NOT_IN_LOBBY`, `GAME_NOT_RUNNING` (relay-only games have no game logic), `INVALID_MESSAGE_TYPE`
   */
  async sendGameAction(type: string, payload: unknown): Promise<void> {
    await this.call('gameAction', { type, payload });
  }

  // ─── User Data (Socket) ───────────────────────────────────────────────────

  /** Own KV data of a game (socket). @throws {EthernalError} `UNKNOWN_GAME` */
  async getUserData(gameId: string): Promise<UserDataEntry[]> {
    return (await this.call<{ entries: UserDataEntry[] }>('getUserData', gameId)).entries;
  }

  /**
   * Visible KV data of another player: `public` entries, plus `lobby` entries if you share a lobby.
   * @throws {EthernalError} `UNKNOWN_GAME`, `USER_NOT_FOUND`
   */
  async getPlayerData(playerId: string, gameId: string): Promise<UserDataEntry[]> {
    return (await this.call<{ entries: UserDataEntry[] }>('getPlayerData', { playerId, gameId })).entries;
  }

  /**
   * Write one own key (socket). Keys the game marks as server-written are read-only for clients.
   * @param visibility @default 'private'
   * @throws {EthernalError} `DATA_READ_ONLY`, `DATA_QUOTA_EXCEEDED`, `DATA_VALUE_TOO_LARGE`, `UNKNOWN_GAME`, `INVALID_INPUT`
   */
  async setUserData(gameId: string, key: string, value: unknown, visibility?: DataVisibility): Promise<void> {
    await this.call('setUserData', { gameId, key, value, ...(visibility ? { visibility } : {}) });
  }

  /** Atomically write several own keys (socket); all or nothing. Errors: see {@link setUserData}. */
  async bulkSetUserData(gameId: string, entries: BulkDataEntry[]): Promise<void> {
    await this.call('bulkSetUserData', { gameId, entries });
  }

  /** Delete one own key (socket). @throws {EthernalError} `DATA_READ_ONLY`, `DATA_KEY_NOT_FOUND` */
  async deleteUserData(gameId: string, key: string): Promise<void> {
    await this.call('deleteUserData', { gameId, key });
  }

  // ─── Social: Friends ──────────────────────────────────────────────────────
  // There are no public profiles. Presence, lobbies and messages are only visible between friends.
  // Every event has a pull equivalent (see docs/social-api.md); `syncSocial()` returns everything at once.

  /**
   * Send a friend request by exact username. Deliberately answers only `REQUEST_SENT` or
   * `NO_SUCH_PLAYER` (also for blocked/self/already-friends) so usernames cannot be probed.
   * @throws {EthernalError} `FRIEND_LIMIT_REACHED`, `REQUEST_LIMIT_REACHED`, `RATE_LIMITED`
   */
  async requestFriendByName(username: string): Promise<FriendRequestResult> {
    return (await this.call<{ result: FriendRequestResult }>('friend:request', { username })).result;
  }

  /**
   * Send a friend request to a member of your current lobby.
   * @throws {EthernalError} `NOT_IN_LOBBY`, `PLAYER_NOT_IN_LOBBY`, `FRIEND_LIMIT_REACHED`, `REQUEST_LIMIT_REACHED`
   */
  async requestFriendFromLobby(userId: string): Promise<FriendRequestResult> {
    return (await this.call<{ result: FriendRequestResult }>('friend:request', { userId })).result;
  }

  /**
   * Accept or decline an incoming friend request.
   * @throws {EthernalError} `FRIEND_REQUEST_NOT_FOUND`, `FRIEND_LIMIT_REACHED`
   */
  async respondFriendRequest(requestId: string, accept: boolean): Promise<void> {
    await this.call('friend:respond', { requestId, accept });
  }

  /** Cancel one of your outgoing friend requests. @throws {EthernalError} `FRIEND_REQUEST_NOT_FOUND` */
  async cancelFriendRequest(requestId: string): Promise<void> {
    await this.call('friend:cancel', { requestId });
  }

  /** Remove a friend. @throws {EthernalError} `NOT_FRIENDS` */
  async removeFriend(friendId: string): Promise<void> {
    await this.call('friend:remove', { friendId });
  }

  /** All friends (`userId` + `username`). */
  async listFriends(): Promise<FriendInfo[]> {
    return (await this.call<{ friends: FriendInfo[] }>('friend:list')).friends;
  }

  /** Pending incoming and outgoing friend requests. */
  async listFriendRequests(): Promise<FriendRequestsResult> {
    return this.call<FriendRequestsResult>('friend:requests');
  }

  /** Current presence of all friends (pull variant of the `friend:presence` event). */
  async getFriendsPresence(): Promise<FriendPresence[]> {
    return (await this.call<{ presence: FriendPresence[] }>('presence:friends')).presence;
  }

  /** Own social settings. */
  async getSocialSettings(): Promise<SocialSettings> {
    return (await this.call<{ settings: SocialSettings }>('social:getSettings')).settings;
  }

  /**
   * Patch own social settings: `status` (online/away/busy/invisible), `showLastSeen`,
   * `dmReadReceipts`, `mutedNotificationTypes`. Returns the full settings after the change.
   * @throws {EthernalError} `INVALID_INPUT`
   */
  async setSocialSettings(patch: Partial<SocialSettings>): Promise<SocialSettings> {
    return (await this.call<{ settings: SocialSettings }>('social:setSettings', patch)).settings;
  }

  /**
   * One consistent snapshot of the whole social state (friends, presence, requests, invites, unread counts).
   * Pass the `etag` of the last snapshot to get `{ notModified: true, etag }` cheaply when nothing changed.
   */
  async syncSocial(etag?: string): Promise<SocialSnapshot | { notModified: true; etag: string }> {
    const { ok: _ok, ...rest } = await this.call<{ ok?: boolean }>('social:sync', etag ? { etag } : {});
    return rest as unknown as SocialSnapshot | { notModified: true; etag: string };
  }

  /**
   * Lobby info of a friend (`null` if they are in none). The lobby ID is only included for non-private lobbies.
   * @throws {EthernalError} `NOT_FRIENDS`
   */
  async getFriendLobby(friendId: string): Promise<FriendLobbyInfo | null> {
    return (await this.call<{ lobby: FriendLobbyInfo | null }>('social:friendLobby', { friendId })).lobby;
  }

  // ─── Social: Notifications ────────────────────────────────────────────────

  /**
   * Persisted notifications, newest first. `since` = unix ms lower bound; page with `cursor` = previous `nextCursor`.
   * @throws {EthernalError} `INVALID_INPUT` (bad cursor/since)
   */
  async listNotifications(opts: { since?: number; unreadOnly?: boolean; limit?: number; cursor?: string } = {}): Promise<NotificationListResult> {
    return this.call<NotificationListResult>('notification:list', opts);
  }

  /**
   * Mark notifications read by `ids` and/or everything created up to `upTo` (unix ms).
   * @returns how many were newly marked and the remaining unread count
   * @throws {EthernalError} `INVALID_INPUT` if neither `ids` nor `upTo` is given
   */
  async markNotificationsRead(input: { ids?: string[]; upTo?: number }): Promise<{ marked: number; unread: number }> {
    return this.call('notification:markRead', input);
  }

  /** Unread/total counts, total and per notification type. */
  async getNotificationCounts(): Promise<NotificationCounts> {
    return this.call<NotificationCounts>('notification:counts');
  }

  // ─── Social: Direct messages (friends only) ──────────────────────────────

  /**
   * Send a text DM (max 1000 chars, plain text — escape on display). Stored for 30 days. The
   * recipient gets `dm:received` (and a `dm` notification if offline).
   * @throws {EthernalError} `NOT_FRIENDS`, `MESSAGE_TOO_LONG`, `INVALID_INPUT` (empty), `RATE_LIMITED`
   */
  async sendDirectMessage(toUserId: string, text: string): Promise<DirectMessage> {
    return (await this.call<{ message: DirectMessage }>('dm:send', { toUserId, text })).message;
  }

  /**
   * Conversation history, oldest first. Page backwards with `before` = previous `nextBefore`.
   * @throws {EthernalError} `NOT_FRIENDS`, `INVALID_INPUT`
   */
  async getDmHistory(withUserId: string, opts: { before?: number; limit?: number } = {}): Promise<DmHistoryResult> {
    return this.call<DmHistoryResult>('dm:history', { withUserId, ...opts });
  }

  /** All conversations with last message and unread count. */
  async listConversations(): Promise<DmConversation[]> {
    return (await this.call<{ conversations: DmConversation[] }>('dm:conversations')).conversations;
  }

  /**
   * Mark all messages from `withUserId` as read (the sender gets `dm:read` if read receipts are enabled).
   * @returns number of messages marked
   */
  async markConversationRead(withUserId: string): Promise<number> {
    return (await this.call<{ marked: number }>('dm:markRead', { withUserId })).marked;
  }

  /** Ephemeral typing indicator; the friend receives `dm:typing`. @throws {EthernalError} `NOT_FRIENDS` */
  async sendTyping(toUserId: string): Promise<void> {
    await this.call('dm:typing', { toUserId });
  }

  // ─── Social: Lobby invites & joining friends ─────────────────────────────

  /**
   * Invite an online friend (same game) to your lobby; they receive `lobby:inviteReceived`. Expires after 5 minutes.
   * @throws {EthernalError} `NOT_IN_LOBBY`, `NOT_FRIENDS`, `FRIEND_OFFLINE`, `GAME_MISMATCH`, `ALREADY_IN_LOBBY`,
   *   `LOBBY_FULL`, `LOBBY_CLOSED`, `NOT_HOST` (lobby setting `inviteHostOnly`)
   */
  async inviteFriend(friendId: string): Promise<LobbyInvite> {
    return (await this.call<{ invite: LobbyInvite }>('lobby:invite', { friendId })).invite;
  }

  /** Withdraw an invite you sent. @throws {EthernalError} `INVITE_NOT_FOUND` */
  async cancelLobbyInvite(inviteId: string): Promise<void> {
    await this.call('lobby:cancelInvite', { inviteId });
  }

  /**
   * Accept an invite and join the lobby (works for private lobbies).
   * @throws {EthernalError} `INVITE_NOT_FOUND`, `GAME_MISMATCH`, `LOBBY_FULL`, `LOBBY_CLOSED`, `ALREADY_IN_LOBBY`
   */
  async acceptLobbyInvite(inviteId: string): Promise<Lobby> {
    return (await this.call<{ lobby: Lobby }>('lobby:acceptInvite', { inviteId })).lobby;
  }

  /** Decline an invite (the inviter gets `lobby:inviteDeclined`). @throws {EthernalError} `INVITE_NOT_FOUND` */
  async declineLobbyInvite(inviteId: string): Promise<void> {
    await this.call('lobby:declineInvite', { inviteId });
  }

  /** Active (unexpired) invites addressed to you. */
  async listLobbyInvites(): Promise<LobbyInvite[]> {
    return (await this.call<{ invites: LobbyInvite[] }>('lobby:invites')).invites;
  }

  /**
   * Join a friend's lobby: joins directly if open (`pending: false`, `lobby` set), sends a join
   * request if locked (`pending: true`; await `joinRequestAccepted`/`joinRequestRejected`), and
   * requires an invite if private.
   * @throws {EthernalError} `NOT_FRIENDS`, `FRIEND_NOT_IN_LOBBY`, `LOBBY_PRIVATE`, `GAME_MISMATCH`, `LOBBY_FULL`, `ALREADY_IN_LOBBY`
   */
  async joinFriend(friendId: string): Promise<{ pending: boolean; lobby?: Lobby }> {
    return this.call('lobby:joinFriend', { friendId });
  }

  // ─── User Data (REST) ─────────────────────────────────────────────────────

  /**
   * Set or update a single KV entry of the current user (REST).
   * @param visibility @default 'private'
   * @throws {EthernalError} hub code (`INVALID_INPUT`, `DATA_READ_ONLY`, `DATA_QUOTA_EXCEEDED`, `DATA_VALUE_TOO_LARGE`, `UNKNOWN_GAME`) or `HTTP_ERROR`
   */
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

  /** Delete a KV entry (REST); a missing key is not an error. */
  async deleteKey(gameId: string, key: string): Promise<void> {
    await this.authedFetch(`/userdata/${encodeURIComponent(gameId)}/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
  }

  /** Set or update 1–100 KV entries in one request (REST); all or nothing. */
  async bulkSet(
    gameId: string,
    entries: Array<{ key: string; value: unknown; visibility?: DataVisibility }>,
  ): Promise<void> {
    await this.authedFetch(`/userdata/${encodeURIComponent(gameId)}`, {
      method: 'PATCH',
      body: JSON.stringify(entries),
    });
  }

  /** Fetch all own KV entries for a game (REST). */
  async getAllData(gameId: string): Promise<UserDataEntry[]> {
    return this.authedFetch<UserDataEntry[]>(`/userdata/${encodeURIComponent(gameId)}`);
  }

  /**
   * Fetch the public numeric leaderboard for a game key.
   * @param options.order 'desc' (default) or 'asc'
   * @param options.limit max rows (default 10, max 100)
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

  private reset(): void {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.registeredGameId = null;
    this.accessToken = null;
    this.refreshToken = null;
  }

  /** Creates the socket; resolves on the first successful connect (or after `requestTimeout`). */
  private connectSocket(): Promise<void> {
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

    const ready = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.requestTimeout);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    socket.on('connect', () => {
      this.emit('connected');
      if (this.registeredGameId) {
        this.registerGame(this.registeredGameId).catch((e) => this.emit('serverError', String(e.message ?? e)));
      }
    });

    socket.on('disconnect', (reason) => {
      this.emit('disconnected', reason);
    });

    // Server warns before dropping a socket whose access token expired: renew in place
    socket.on('errorDetail', (detail) => {
      if (detail.code !== 'AUTH_EXPIRED' || !this.refreshToken) return;
      void this.refreshSocketAuth().catch(() => this.emit('authError', 'Token konnte nicht erneuert werden'));
    });

    // If the token expired mid-session, refresh and reconnect
    socket.on('connect_error', async (err) => {
      if (err.message === 'INVALID_TOKEN' && this.refreshToken) {
        socket.disconnect();
        try {
          await this.doRefresh();
          void this.connectSocket();
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

    forward('hello');
    forward('session:resumed');
    forward('session:replaced');
    forward('errorDetail');
    forward('lobbyCreated');
    forward('lobbyUpdated');
    forward('lobbyList');
    forward('lobbyInfo');
    forward('gameStarting');
    forward('gameState');
    forward('gameEvent');
    forward('gameOver');
    forward('gameCrashed');
    forward('playerKicked');
    forward('message');
    forward('messageBinary');
    forward('userData');
    forward('playerData');
    forward('friend:presence');
    forward('friend:requestReceived');
    forward('friend:requestAccepted');
    forward('friend:requestDeclined');
    forward('friend:requestCancelled');
    forward('friend:removed');
    forward('notification');
    forward('notification:backlog');
    forward('dm:received');
    forward('dm:delivered');
    forward('dm:read');
    forward('dm:typing');
    forward('lobby:inviteReceived');
    forward('lobby:inviteCancelled');
    forward('lobby:inviteDeclined');
    forward('joinRequestReceived');
    forward('joinRequestPending');
    forward('joinRequestAccepted');
    forward('joinRequestRejected');
    forward('joinRequestWithdrawn');
    // Note: 'error' events from the socket are handled separately to avoid
    // conflicting with Node's EventEmitter built-in 'error' behaviour.
    socket.on('error', (msg: string) => {
      this.emit('serverError', msg);
    });

    this.socket = socket;
    return ready;
  }

  private getSocket(): EthernalSocket {
    if (!this.socket?.connected) {
      throw new EthernalError('NOT_CONNECTED', 'Kein aktiver Socket — bitte zuerst login() oder register() aufrufen');
    }
    return this.socket;
  }

  /** Emit a socket event with an ack callback; rejects with EthernalError on failure or timeout. */
  private call<T = Record<string, never>>(event: string, ...args: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
      let sock: EthernalSocket;
      try {
        sock = this.getSocket();
      } catch (e) {
        reject(e);
        return;
      }
      const timer = setTimeout(
        () => reject(new EthernalError('TIMEOUT', `Timeout beim Warten auf "${event}"`)),
        this.requestTimeout,
      );
      const ack = (res: { ok: boolean; error?: HubErrorPayload } & Record<string, unknown>) => {
        clearTimeout(timer);
        if (res.ok) resolve(res as unknown as T);
        else reject(new EthernalError(res.error!.code, res.error!.message, res.error!.retryAfterMs));
      };
      (sock as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit(event, ...args, ack);
    });
  }

  /**
   * Sends a join request and resolves/rejects on the host's eventual answer
   * ('joinRequestAccepted' / 'joinRequestRejected'); the server allows ~15s for the host.
   */
  private joinRequestRace(event: string, data: Record<string, unknown>): Promise<Lobby> {
    const JOIN_REQUEST_TIMEOUT_MS = 16_000;
    return new Promise((resolve, reject) => {
      let sock: {
        once: (event: string, cb: (...args: unknown[]) => void) => void;
        off: (event: string, cb: (...args: unknown[]) => void) => void;
        emit: (event: string, ...args: unknown[]) => void;
      };
      try {
        sock = this.getSocket() as unknown as typeof sock;
      } catch (e) {
        reject(e);
        return;
      }
      const cleanup = () => {
        clearTimeout(timer);
        this.abortJoinRace = null;
        sock.off('joinRequestAccepted', onAccepted);
        sock.off('joinRequestRejected', onRejected);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new EthernalError('TIMEOUT', 'Timeout beim Warten auf die Beitrittsanfrage'));
      }, JOIN_REQUEST_TIMEOUT_MS);
      const onAccepted = (...args: unknown[]) => {
        cleanup();
        resolve((args[0] as { lobby: Lobby }).lobby);
      };
      const onRejected = (...args: unknown[]) => {
        cleanup();
        const d = args[0] as { reason: JoinRequestRejectReason };
        reject(new EthernalError('LOBBY_LOCKED', `Beitrittsanfrage abgelehnt (${d.reason})`));
      };
      this.abortJoinRace = (e) => {
        cleanup();
        reject(e);
      };
      sock.once('joinRequestAccepted', onAccepted);
      sock.once('joinRequestRejected', onRejected);
      sock.emit(event, data, (res: { ok: boolean; error?: HubErrorPayload; lobby?: Lobby }) => {
        if (!res.ok) {
          cleanup();
          reject(new EthernalError(res.error!.code, res.error!.message, res.error!.retryAfterMs));
        } else if (res.lobby) {
          cleanup();
          resolve(res.lobby);
        }
      });
    });
  }

  // ─── Internal: HTTP ───────────────────────────────────────────────────────

  private storeTokens(accessToken: string, refreshToken: string): void {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }

  private async doRefresh(): Promise<void> {
    if (!this.refreshToken) throw new EthernalError('INVALID_REFRESH_TOKEN', 'Kein Refresh-Token vorhanden');
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
      let code: string | undefined;
      try {
        code = (JSON.parse(body) as { code?: string }).code;
      } catch {
        /* not JSON */
      }
      throw new EthernalError((code as ErrorCode | undefined) ?? 'HTTP_ERROR', `HTTP ${res.status}: ${body}`);
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
      const payload = await res.json().catch(() => ({ error: res.statusText })) as { error?: string; code?: ErrorCode };
      throw new EthernalError(payload.code ?? 'HTTP_ERROR', payload.error ?? `HTTP ${res.status}`);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  // ─── Typed EventEmitter overloads ─────────────────────────────────────────

  on<K extends keyof EthernalClientEvents>(event: K, listener: (...args: EthernalClientEvents[K]) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  once<K extends keyof EthernalClientEvents>(event: K, listener: (...args: EthernalClientEvents[K]) => void): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }

  off<K extends keyof EthernalClientEvents>(event: K, listener: (...args: EthernalClientEvents[K]) => void): this;
  off(event: string | symbol, listener: (...args: any[]) => void): this;
  off(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }
}
