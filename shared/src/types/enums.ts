// Wire-value enums shared by server, game servers and both ODKs. Values are the exact strings sent over the wire.
// The C# enums (csharp-sdk/.../Models/Enums.cs) are generated from this file: `npm run gen:enums`.

/** Lifecycle state of a lobby. */
export const LobbyStatus = {
  Open: 'open',
  Full: 'full',
  InProgress: 'in_progress',
  Closed: 'closed',
} as const;
export type LobbyStatus = (typeof LobbyStatus)[keyof typeof LobbyStatus];

/** Why a lobby changed; second argument of `lobbyUpdated` (and `lobby:updated` for game servers). */
export const LobbyChangeReason = {
  PlayerJoined: 'player_joined',
  PlayerLeft: 'player_left',
  HostLeft: 'host_left',
  HostTransferred: 'host_transferred',
  PlayerDisconnected: 'player_disconnected',
  PlayerReconnected: 'player_reconnected',
  StateChanged: 'state_changed',
  Locked: 'locked',
  Unlocked: 'unlocked',
  Kicked: 'kicked',
  SettingsChanged: 'settings_changed',
  ServerLost: 'server_lost',
  ServerResumed: 'server_resumed',
  ServerDraining: 'server_draining',
  ServerRebound: 'server_rebound',
} as const;
export type LobbyChangeReason = (typeof LobbyChangeReason)[keyof typeof LobbyChangeReason];

/** Health of the game server bound to a lobby (`Lobby.serverStatus`). */
export const LobbyServerStatus = {
  Ok: 'ok',
  Lost: 'lost',
  Draining: 'draining',
} as const;
export type LobbyServerStatus = (typeof LobbyServerStatus)[keyof typeof LobbyServerStatus];

/** Whether a game uses game servers (`GameInfo.serverSupport`). */
export const ServerSupport = {
  None: 'none',
  Optional: 'optional',
  Required: 'required',
} as const;
export type ServerSupport = (typeof ServerSupport)[keyof typeof ServerSupport];

/** Why a game server is asked to take a lobby (`lobby:assigned`). `server_rebound` = takeover of a lobby whose previous server was lost; the lobby already has state, settings and players. */
export const LobbyAssignReason = {
  NewLobby: 'new_lobby',
  ServerRebound: 'server_rebound',
} as const;
export type LobbyAssignReason = (typeof LobbyAssignReason)[keyof typeof LobbyAssignReason];

/** Why the hub tells a game server that a lobby ended (`lobby:closed`). */
export const LobbyClosedReason = {
  Closed: 'closed',
  Dissolved: 'dissolved',
  HostLeft: 'host_left',
  Reassigned: 'reassigned',
} as const;
export type LobbyClosedReason = (typeof LobbyClosedReason)[keyof typeof LobbyClosedReason];

/** Why a player left a lobby (`player:left` for game servers). */
export const PlayerLeftReason = {
  Left: 'left',
  Kicked: 'kicked',
  Timeout: 'timeout',
} as const;
export type PlayerLeftReason = (typeof PlayerLeftReason)[keyof typeof PlayerLeftReason];

/** Reason of `session:replaced`. */
export const SessionReplacedReason = {
  NewSession: 'new_session',
} as const;
export type SessionReplacedReason = (typeof SessionReplacedReason)[keyof typeof SessionReplacedReason];

/** Why a join request was rejected or ended. */
export const JoinRequestRejectReason = {
  Declined: 'declined',
  Timeout: 'timeout',
  HostChanged: 'host_changed',
  LobbyClosed: 'lobby_closed',
  Unlocked: 'unlocked',
  AlreadyInLobby: 'already_in_lobby',
  LobbyFull: 'lobby_full',
  Superseded: 'superseded',
} as const;
export type JoinRequestRejectReason = (typeof JoinRequestRejectReason)[keyof typeof JoinRequestRejectReason];

/** Why a join request was withdrawn (`joinRequestWithdrawn`). */
export const JoinRequestWithdrawReason = {
  Cancelled: 'cancelled',
  Timeout: 'timeout',
} as const;
export type JoinRequestWithdrawReason = (typeof JoinRequestWithdrawReason)[keyof typeof JoinRequestWithdrawReason];

/** Who can read a user data entry. */
export const DataVisibility = {
  Private: 'private',
  Lobby: 'lobby',
  Public: 'public',
} as const;
export type DataVisibility = (typeof DataVisibility)[keyof typeof DataVisibility];

/** Who may write a user data entry. */
export const DataWriteScope = {
  Client: 'client',
  Server: 'server',
} as const;
export type DataWriteScope = (typeof DataWriteScope)[keyof typeof DataWriteScope];

/** How a friend request was initiated. */
export const FriendRequestSource = {
  Name: 'name',
  Lobby: 'lobby',
} as const;
export type FriendRequestSource = (typeof FriendRequestSource)[keyof typeof FriendRequestSource];

/** Answer to a friend request by name (never reveals more). */
export const FriendRequestResult = {
  RequestSent: 'REQUEST_SENT',
  NoSuchPlayer: 'NO_SUCH_PLAYER',
} as const;
export type FriendRequestResult = (typeof FriendRequestResult)[keyof typeof FriendRequestResult];

/** Status a user can set for themselves. */
export const OwnPresenceStatus = {
  Online: 'online',
  Away: 'away',
  Busy: 'busy',
  Invisible: 'invisible',
} as const;
export type OwnPresenceStatus = (typeof OwnPresenceStatus)[keyof typeof OwnPresenceStatus];

/** Status of a friend as seen by others. */
export const FriendPresenceStatus = {
  Online: 'online',
  Away: 'away',
  Busy: 'busy',
  Offline: 'offline',
} as const;
export type FriendPresenceStatus = (typeof FriendPresenceStatus)[keyof typeof FriendPresenceStatus];

/** Why a lobby invite ended (`lobby:inviteCancelled`). */
export const LobbyInviteCancelReason = {
  Cancelled: 'cancelled',
  Expired: 'expired',
  LobbyClosed: 'lobby_closed',
  LobbyFull: 'lobby_full',
  Left: 'left',
  Unfriended: 'unfriended',
} as const;
export type LobbyInviteCancelReason = (typeof LobbyInviteCancelReason)[keyof typeof LobbyInviteCancelReason];

/** Type of a persisted notification. */
export const NotificationType = {
  FriendRequest: 'friend_request',
  FriendAccepted: 'friend_accepted',
  FriendRemoved: 'friend_removed',
  Dm: 'dm',
  LobbyInvite: 'lobby_invite',
  LobbyInviteCancelled: 'lobby_invite_cancelled',
  FriendOnline: 'friend_online',
  Kicked: 'kicked',
  System: 'system',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

/** Stable machine-readable error codes (the `message` text is for display only). */
export const ErrorCode = {
  InvalidInput: 'INVALID_INPUT',
  RateLimited: 'RATE_LIMITED',
  Internal: 'INTERNAL',
  NotFound: 'NOT_FOUND',
  Unauthenticated: 'UNAUTHENTICATED',
  InvalidToken: 'INVALID_TOKEN',
  InvalidCredentials: 'INVALID_CREDENTIALS',
  UsernameTaken: 'USERNAME_TAKEN',
  UserNotFound: 'USER_NOT_FOUND',
  InvalidRefreshToken: 'INVALID_REFRESH_TOKEN',
  RefreshTokenRevoked: 'REFRESH_TOKEN_REVOKED',
  RefreshTokenExpired: 'REFRESH_TOKEN_EXPIRED',
  GameNotRegistered: 'GAME_NOT_REGISTERED',
  UnknownGame: 'UNKNOWN_GAME',
  ClientOutdated: 'CLIENT_OUTDATED',
  LeaveLobbyFirst: 'LEAVE_LOBBY_FIRST',
  GameMismatch: 'GAME_MISMATCH',
  AlreadyInLobby: 'ALREADY_IN_LOBBY',
  NotInLobby: 'NOT_IN_LOBBY',
  LobbyNotFound: 'LOBBY_NOT_FOUND',
  LobbyClosed: 'LOBBY_CLOSED',
  LobbyLocked: 'LOBBY_LOCKED',
  LobbyFull: 'LOBBY_FULL',
  LobbyPrivate: 'LOBBY_PRIVATE',
  InvalidInviteCode: 'INVALID_INVITE_CODE',
  InviteCodeNotFound: 'INVITE_CODE_NOT_FOUND',
  NotHost: 'NOT_HOST',
  AlreadyHost: 'ALREADY_HOST',
  CannotKickSelf: 'CANNOT_KICK_SELF',
  PlayerNotFound: 'PLAYER_NOT_FOUND',
  LobbyStartFailed: 'LOBBY_START_FAILED',
  LobbyInProgress: 'LOBBY_IN_PROGRESS',
  InstanceLimit: 'INSTANCE_LIMIT',
  InvalidState: 'INVALID_STATE',
  CannotTargetSelf: 'CANNOT_TARGET_SELF',
  PayloadTooLarge: 'PAYLOAD_TOO_LARGE',
  InvalidMessageType: 'INVALID_MESSAGE_TYPE',
  AuthExpired: 'AUTH_EXPIRED',
  InvalidServerKey: 'INVALID_SERVER_KEY',
  GameServerNotAllowed: 'GAME_SERVER_NOT_ALLOWED',
  NoGameServerAvailable: 'NO_GAME_SERVER_AVAILABLE',
  NotLobbyServer: 'NOT_LOBBY_SERVER',
  ServerUnavailable: 'SERVER_UNAVAILABLE',
  SettingsTooLarge: 'SETTINGS_TOO_LARGE',
  JoinRequestNotFound: 'JOIN_REQUEST_NOT_FOUND',
  PlayerNotInLobby: 'PLAYER_NOT_IN_LOBBY',
  PlayerUnreachable: 'PLAYER_UNREACHABLE',
  InvalidLobbyContext: 'INVALID_LOBBY_CONTEXT',
  InvalidBinaryTypecode: 'INVALID_BINARY_TYPECODE',
  InvalidBinaryPayload: 'INVALID_BINARY_PAYLOAD',
  BinaryPayloadTooLarge: 'BINARY_PAYLOAD_TOO_LARGE',
  GameNotRunning: 'GAME_NOT_RUNNING',
  DataReadOnly: 'DATA_READ_ONLY',
  DataQuotaExceeded: 'DATA_QUOTA_EXCEEDED',
  DataValueTooLarge: 'DATA_VALUE_TOO_LARGE',
  DataKeyNotFound: 'DATA_KEY_NOT_FOUND',
  NotFriends: 'NOT_FRIENDS',
  FriendRequestNotFound: 'FRIEND_REQUEST_NOT_FOUND',
  FriendLimitReached: 'FRIEND_LIMIT_REACHED',
  RequestLimitReached: 'REQUEST_LIMIT_REACHED',
  FriendOffline: 'FRIEND_OFFLINE',
  FriendNotInLobby: 'FRIEND_NOT_IN_LOBBY',
  InviteNotFound: 'INVITE_NOT_FOUND',
  MessageTooLong: 'MESSAGE_TOO_LONG',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
