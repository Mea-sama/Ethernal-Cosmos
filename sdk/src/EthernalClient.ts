import { EventEmitter } from 'events';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  Lobby,
  LobbyChangeReason,
  UserDataEntry,
  DataVisibility,
  RelayMessage,
  RelayBinaryMessage,
  JoinRequestRejectReason,
  ErrorCode,
  HubErrorPayload,
  GameInfo,
  SessionState,
  HelloPayload,
  BulkDataEntry,
  FriendInfo,
  FriendRequestResult,
  FriendRequestsResult,
  FriendPresence,
  SocialSettings,
  SocialSnapshot,
  HubNotification,
  NotificationBacklog,
  NotificationCounts,
  NotificationListResult,
  DirectMessage,
  DmConversation,
  DmHistoryResult,
  LobbyInvite,
  FriendLobbyInfo,
} from '@ethernal/shared';

// ─── Types ───────────────────────────────────────────────────────

export type { Lobby, LobbyChangeReason, UserDataEntry, DataVisibility, JoinRequestRejectReason } from '@ethernal/shared';
export type {
  FriendInfo, FriendRequestInfo, FriendRequestResult, FriendRequestsResult, FriendPresence, FriendPresenceStatus,
  OwnPresenceStatus, SocialSettings, SocialSnapshot, HubNotification, NotificationType, NotificationBacklog,
  NotificationCounts, NotificationListResult, DirectMessage, DmConversation, DmHistoryResult, LobbyInvite,
  LobbyInviteCancelReason, FriendLobbyInfo,
} from '@ethernal/shared';
export type { RelayMessage, RelayBinaryMessage, ErrorCode, HubErrorPayload, GameInfo, SessionState, HelloPayload, BulkDataEntry } from '@ethernal/shared';

/** Error thrown by every SDK call; `code` is a stable machine-readable value (see ErrorCode). */
export class EthernalError extends Error {
  constructor(public readonly code: ErrorCode | 'TIMEOUT' | 'NOT_CONNECTED', message: string, public readonly retryAfterMs?: number) {
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
 * const lobby = await client.registerGame('chess');
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
    this.registeredGameId = null;
    this.accessToken = null;
    this.refreshToken = null;
  }

  /** Revoke all refresh tokens of this account and disconnect every session. */
  async logoutAll(): Promise<void> {
    await this.authedFetch('/auth/logout-all', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    this.socket?.disconnect();
    this.socket = null;
    this.registeredGameId = null;
    this.accessToken = null;
    this.refreshToken = null;
  }

  /** Renew the access token and hand it to the live socket (`auth:refresh`). */
  async refreshSocketAuth(): Promise<void> {
    await this.doRefresh();
    await this.call('auth:refresh', { token: this.accessToken });
  }

  // ─── Lobby ────────────────────────────────────────────────────────────────

  /**
   * Register the game this client plays. Required once per connection (after login) before
   * lobbies, relay or game actions can be used. Lobbies are bound to this game.
   */
  async registerGame(gameId: string, opts: { clientVersion?: string; platform?: string } = {}): Promise<{ game: GameInfo; state: SessionState }> {
    const res = await this.call<{ game: GameInfo; state: SessionState }>('session:registerGame', { gameId, ...opts });
    this.registeredGameId = gameId;
    return res;
  }

  /** Pull the current session state (game + lobby), e.g. after a reconnect. */
  getSessionState(): Promise<{ state: SessionState; lobby?: Lobby }> {
    return this.call('session:getState');
  }

  /** Create a new lobby for the registered game. */
  async createLobby(data: { name: string; isPrivate?: boolean; settings?: Record<string, unknown>; serverPreference?: { mode?: 'any' | 'none'; region?: string } }): Promise<Lobby> {
    return (await this.call<{ lobby: Lobby }>('createLobby', data)).lobby;
  }

  /** Join a public lobby of the registered game by ID. */
  async joinLobby(lobbyId: string): Promise<Lobby> {
    return (await this.call<{ lobby: Lobby }>('joinLobby', { lobbyId })).lobby;
  }

  /** Join a lobby (also private/locked-free) using a 6-character invite code. */
  async joinLobbyByCode(code: string): Promise<Lobby> {
    return (await this.call<{ lobby: Lobby }>('joinLobbyByCode', { code })).lobby;
  }

  /** Leave the current lobby. */
  async leaveLobby(): Promise<void> {
    await this.call('leaveLobby');
  }

  /** Fetch open public lobbies of the registered game. */
  async listLobbies(): Promise<Lobby[]> {
    return (await this.call<{ lobbies: Lobby[] }>('listLobbies')).lobbies;
  }

  /** Get a snapshot of the current lobby state. */
  async getLobbyInfo(): Promise<Lobby> {
    return (await this.call<{ lobby: Lobby }>('getLobbyInfo')).lobby;
  }

  /** (Host only) Kick a player from the lobby. */
  async kickPlayer(playerId: string): Promise<void> {
    await this.call('kickPlayer', { playerId });
  }

  /** (Host only) Transfer the host role to another player. */
  async transferHost(playerId: string): Promise<void> {
    await this.call('transferHost', { playerId });
  }

  /** (Host only) Lock the lobby — further joins (including via invite code) require an accepted join request. */
  async lockLobby(): Promise<void> {
    await this.call('lockLobby');
  }

  /** (Host only) Unlock the lobby. */
  /** Host: Lobby-Status setzen (für Spiele ohne Subprocess). */
  async setLobbyState(state: 'in_progress' | 'closed'): Promise<Lobby> {
    const res = await this.call<{ lobby: Lobby }>('setLobbyState', { state });
    return res.lobby;
  }

  async unlockLobby(): Promise<void> {
    await this.call('unlockLobby');
  }

  /**
   * Request to join a locked lobby by ID. Resolves once the host accepts (with the joined
   * Lobby) or rejects when the host declines, the request times out, or the lobby closes.
   */
  requestJoinLobby(lobbyId: string): Promise<Lobby> {
    return this.joinRequestRace('requestJoinLobby', { lobbyId });
  }

  /** Request to join a locked lobby using its invite code. See {@link requestJoinLobby}. */
  requestJoinLobbyByCode(code: string): Promise<Lobby> {
    return this.joinRequestRace('requestJoinLobbyByCode', { code });
  }

  /** Withdraw your own pending join request before the host has responded. */
  async cancelJoinRequest(lobbyId: string): Promise<void> {
    await this.call('cancelJoinRequest', { lobbyId });
  }

  /** (Host only) Accept or reject a pending join request (see the 'joinRequestReceived' event). */
  async respondJoinRequest(requesterId: string, accept: boolean): Promise<void> {
    await this.call('respondJoinRequest', { requesterId, accept });
  }

  // ─── Relay ────────────────────────────────────────────────────────────────

  /** Broadcast a typed message to all other players in the lobby. */
  async sendToLobby(type: string, payload: unknown): Promise<void> {
    await this.call('sendToLobby', { type, payload });
  }

  /** Send a typed message directly to one player in the lobby. */
  async sendToPlayer(playerId: string, type: string, payload: unknown): Promise<void> {
    await this.call('sendToPlayer', { playerId, type, payload });
  }

  /** Broadcast a binary message to all other players in the lobby. */
  async sendToLobbyBinary(typeCode: number, payload: BinaryPayload): Promise<void> {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    await this.call('sendToLobbyBinary', { typeCode, payload: bytes });
  }

  /** Send a binary message directly to one player in the lobby. */
  async sendToPlayerBinary(playerId: string, typeCode: number, payload: BinaryPayload): Promise<void> {
    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
    await this.call('sendToPlayerBinary', { playerId, typeCode, payload: bytes });
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
  async sendGameAction(type: string, payload: unknown): Promise<void> {
    await this.call('gameAction', { type, payload });
  }

  // ─── User Data (Socket) ───────────────────────────────────────────────────

  /** Fetch the current user's own KV-data for a game (socket). */
  async getUserData(gameId: string): Promise<UserDataEntry[]> {
    return (await this.call<{ entries: UserDataEntry[] }>('getUserData', gameId)).entries;
  }

  /** Fetch visible KV-data for another player (public, or lobby-scoped if you share a lobby). */
  async getPlayerData(playerId: string, gameId: string): Promise<UserDataEntry[]> {
    return (await this.call<{ entries: UserDataEntry[] }>('getPlayerData', { playerId, gameId })).entries;
  }

  /** Write one own key via socket. Server-scoped keys are read-only for clients (DATA_READ_ONLY). */
  async setUserData(gameId: string, key: string, value: unknown, visibility?: DataVisibility): Promise<void> {
    await this.call('setUserData', { gameId, key, value, ...(visibility ? { visibility } : {}) });
  }

  /** Atomically write several own keys via socket. */
  async bulkSetUserData(gameId: string, entries: BulkDataEntry[]): Promise<void> {
    await this.call('bulkSetUserData', { gameId, entries });
  }

  /** Delete one own key via socket. */
  async deleteUserData(gameId: string, key: string): Promise<void> {
    await this.call('deleteUserData', { gameId, key });
  }

  // ─── Social: Friends ──────────────────────────────────────────────────────
  // There are no public profiles. Presence, lobbies and messages are only visible between friends.
  // Every event has a pull equivalent (see docs/social-api.md) — `syncSocial()` returns everything at once.

  /** Send a friend request by exact username. Only answers REQUEST_SENT or NO_SUCH_PLAYER (never leaks more). */
  async requestFriendByName(username: string): Promise<FriendRequestResult> {
    return (await this.call<{ result: FriendRequestResult }>('friend:request', { username })).result;
  }

  /** Send a friend request to a member of your current lobby. */
  async requestFriendFromLobby(userId: string): Promise<FriendRequestResult> {
    return (await this.call<{ result: FriendRequestResult }>('friend:request', { userId })).result;
  }

  async respondFriendRequest(requestId: string, accept: boolean): Promise<void> {
    await this.call('friend:respond', { requestId, accept });
  }

  async cancelFriendRequest(requestId: string): Promise<void> {
    await this.call('friend:cancel', { requestId });
  }

  async removeFriend(friendId: string): Promise<void> {
    await this.call('friend:remove', { friendId });
  }

  async listFriends(): Promise<FriendInfo[]> {
    return (await this.call<{ friends: FriendInfo[] }>('friend:list')).friends;
  }

  async listFriendRequests(): Promise<FriendRequestsResult> {
    return this.call<FriendRequestsResult>('friend:requests');
  }

  /** Current presence of all friends (pull variant of the `friend:presence` event). */
  async getFriendsPresence(): Promise<FriendPresence[]> {
    return (await this.call<{ presence: FriendPresence[] }>('presence:friends')).presence;
  }

  async getSocialSettings(): Promise<SocialSettings> {
    return (await this.call<{ settings: SocialSettings }>('social:getSettings')).settings;
  }

  /** Set own status (online/away/busy/invisible), last-seen visibility, DM read receipts, muted notification types. */
  async setSocialSettings(patch: Partial<SocialSettings>): Promise<SocialSettings> {
    return (await this.call<{ settings: SocialSettings }>('social:setSettings', patch)).settings;
  }

  /** One consistent snapshot of the whole social state. Pass the last `etag` to get `{ notModified: true }` cheaply. */
  async syncSocial(etag?: string): Promise<SocialSnapshot | { notModified: true; etag: string }> {
    return this.call('social:sync', etag ? { etag } : {});
  }

  /** Lobby info of a friend (only for friends; the lobby ID is only included for non-private lobbies). */
  async getFriendLobby(friendId: string): Promise<FriendLobbyInfo | null> {
    return (await this.call<{ lobby: FriendLobbyInfo | null }>('social:friendLobby', { friendId })).lobby;
  }

  // ─── Social: Notifications ────────────────────────────────────────────────

  async listNotifications(opts: { since?: number; unreadOnly?: boolean; limit?: number; cursor?: string } = {}): Promise<NotificationListResult> {
    return this.call<NotificationListResult>('notification:list', opts);
  }

  /** Mark notifications read by `ids` and/or everything created up to `upTo` (unix ms). */
  async markNotificationsRead(input: { ids?: string[]; upTo?: number }): Promise<{ marked: number; unread: number }> {
    return this.call('notification:markRead', input);
  }

  async getNotificationCounts(): Promise<NotificationCounts> {
    return this.call<NotificationCounts>('notification:counts');
  }

  // ─── Social: Direct messages (friends only) ──────────────────────────────

  /** Send a text DM (max 1000 chars, plain text — escape on display). Stored for 30 days. */
  async sendDirectMessage(toUserId: string, text: string): Promise<DirectMessage> {
    return (await this.call<{ message: DirectMessage }>('dm:send', { toUserId, text })).message;
  }

  /** Conversation history, oldest first. Page backwards with `before` = previous `nextBefore`. */
  async getDmHistory(withUserId: string, opts: { before?: number; limit?: number } = {}): Promise<DmHistoryResult> {
    return this.call<DmHistoryResult>('dm:history', { withUserId, ...opts });
  }

  async listConversations(): Promise<DmConversation[]> {
    return (await this.call<{ conversations: DmConversation[] }>('dm:conversations')).conversations;
  }

  async markConversationRead(withUserId: string): Promise<number> {
    return (await this.call<{ marked: number }>('dm:markRead', { withUserId })).marked;
  }

  /** Ephemeral typing indicator. */
  async sendTyping(toUserId: string): Promise<void> {
    await this.call('dm:typing', { toUserId });
  }

  // ─── Social: Lobby invites & joining friends ─────────────────────────────

  /** Invite an online friend (same game) to your lobby. Expires after 5 minutes. */
  async inviteFriend(friendId: string): Promise<LobbyInvite> {
    return (await this.call<{ invite: LobbyInvite }>('lobby:invite', { friendId })).invite;
  }

  async cancelLobbyInvite(inviteId: string): Promise<void> {
    await this.call('lobby:cancelInvite', { inviteId });
  }

  /** Accept an invite and join the lobby (works for private lobbies). */
  async acceptLobbyInvite(inviteId: string): Promise<Lobby> {
    return (await this.call<{ lobby: Lobby }>('lobby:acceptInvite', { inviteId })).lobby;
  }

  async declineLobbyInvite(inviteId: string): Promise<void> {
    await this.call('lobby:declineInvite', { inviteId });
  }

  /** Active (unexpired) invites addressed to you. */
  async listLobbyInvites(): Promise<LobbyInvite[]> {
    return (await this.call<{ invites: LobbyInvite[] }>('lobby:invites')).invites;
  }

  /** Join a friend's lobby: direct join if open, join request if locked, requires an invite if private. */
  async joinFriend(friendId: string): Promise<{ pending: boolean; lobby?: Lobby }> {
    return this.call('lobby:joinFriend', { friendId });
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
      const sock = this.getSocket() as unknown as {
        once: (event: string, cb: (...args: unknown[]) => void) => void;
        off: (event: string, cb: (...args: unknown[]) => void) => void;
        emit: (event: string, ...args: unknown[]) => void;
      };
      const cleanup = () => {
        clearTimeout(timer);
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
  on(event: 'hello', listener: (data: HelloPayload) => void): this;
  on(event: 'session:resumed', listener: (data: { state: SessionState; lobby: Lobby }) => void): this;
  on(event: 'session:replaced', listener: (data: { reason: 'new_session' }) => void): this;
  on(event: 'errorDetail', listener: (error: HubErrorPayload) => void): this;
  on(event: 'lobbyCreated', listener: (lobby: Lobby) => void): this;
  on(event: 'lobbyUpdated', listener: (lobby: Lobby, reason?: LobbyChangeReason) => void): this;
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
  once(event: 'lobbyUpdated', listener: (lobby: Lobby, reason?: LobbyChangeReason) => void): this;
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
