// Wire-value enums shared by server, game servers and both ODKs. Values are the exact strings sent over the wire.
// The C# enums (csharp-sdk/.../Models/Enums.cs) are generated from this file: `npm run gen:enums`.

/** Lifecycle state of a lobby. */
export const LobbyStatus = {
  Open: 'open', // accepting players
  Full: 'full', // no free slot
  InProgress: 'in_progress', // game running (late join only if the game allows it)
  Closed: 'closed', // ended; kept briefly, then removed
} as const;
export type LobbyStatus = (typeof LobbyStatus)[keyof typeof LobbyStatus];

/** Why a lobby changed; second argument of `lobbyUpdated` (and `lobby:updated` for game servers). */
export const LobbyChangeReason = {
  PlayerJoined: 'player_joined', // a player joined
  PlayerLeft: 'player_left', // a player left voluntarily
  HostLeft: 'host_left', // the host left and the lobby was closed or migrated (see game host-migration policy)
  HostTransferred: 'host_transferred', // host role passed to another player
  PlayerDisconnected: 'player_disconnected', // a player lost connection and is in the reconnect grace period
  PlayerReconnected: 'player_reconnected', // a disconnected player came back
  StateChanged: 'state_changed', // lobby status changed (e.g. open to in_progress or closed)
  Locked: 'locked', // host locked the lobby (join requests required)
  Unlocked: 'unlocked', // host unlocked the lobby
  Kicked: 'kicked', // a player was kicked
  SettingsChanged: 'settings_changed', // lobby settings were changed
  ServerLost: 'server_lost', // the game server connection was lost (resume grace running); after the grace the lobby is rebound, closed or continues serverless
  ServerResumed: 'server_resumed', // the lost game server reconnected in time
  ServerDraining: 'server_draining', // the game server started or stopped draining (see serverStatus)
  ServerRebound: 'server_rebound', // the lobby moved to another game server after the previous one was lost
} as const;
export type LobbyChangeReason = (typeof LobbyChangeReason)[keyof typeof LobbyChangeReason];

/** Health of the game server bound to a lobby (`Lobby.serverStatus`). */
export const LobbyServerStatus = {
  Ok: 'ok', // server connected and accepting
  Lost: 'lost', // server connection lost, resume grace running
  Draining: 'draining', // server finishes existing lobbies and accepts no new ones
} as const;
export type LobbyServerStatus = (typeof LobbyServerStatus)[keyof typeof LobbyServerStatus];

/** Player preference for a game server at `createLobby` (`serverPreference.mode`). */
export const ServerMode = {
  Any: 'any', // use a game server if the game supports one (default)
  None: 'none', // deliberately no game server (only for games with serverSupport `optional`)
} as const;
export type ServerMode = (typeof ServerMode)[keyof typeof ServerMode];

/** Whether a game uses game servers (`GameInfo.serverSupport`). */
export const ServerSupport = {
  None: 'none', // game never uses a game server
  Optional: 'optional', // lobbies may use a game server if one is available (client can opt out)
  Required: 'required', // lobbies need a game server; creation fails without one
} as const;
export type ServerSupport = (typeof ServerSupport)[keyof typeof ServerSupport];

/** Why a game server is asked to take a lobby (`lobby:assigned`). `server_rebound` = takeover of a lobby whose previous server was lost; the lobby already has state, settings and players. */
export const LobbyAssignReason = {
  NewLobby: 'new_lobby', // fresh lobby that was just created
  ServerRebound: 'server_rebound', // takeover of a lobby whose previous server was lost: the lobby already has state, settings and players; `previousServerId` and `lostAt` are set and the game state must be recovered or restarted
} as const;
export type LobbyAssignReason = (typeof LobbyAssignReason)[keyof typeof LobbyAssignReason];

/** Why the hub tells a game server that a lobby ended (`lobby:closed`). */
export const LobbyClosedReason = {
  Closed: 'closed', // lobby closed normally
  Dissolved: 'dissolved', // last player left
  HostLeft: 'host_left', // host left and policy closes the lobby
  Reassigned: 'reassigned', // lobby moved to another server
} as const;
export type LobbyClosedReason = (typeof LobbyClosedReason)[keyof typeof LobbyClosedReason];

/** Why a player left a lobby (`player:left` for game servers). */
export const PlayerLeftReason = {
  Left: 'left', // player left voluntarily
  Kicked: 'kicked', // player was kicked
  Timeout: 'timeout', // reconnect grace expired
  AccountDeleted: 'account_deleted', // the account was deleted
} as const;
export type PlayerLeftReason = (typeof PlayerLeftReason)[keyof typeof PlayerLeftReason];

/** Reason of `session:replaced`. */
export const SessionReplacedReason = {
  NewSession: 'new_session', // the same account connected from a new session
  PasswordChanged: 'password_changed', // the password was changed from another session
} as const;
export type SessionReplacedReason = (typeof SessionReplacedReason)[keyof typeof SessionReplacedReason];

/** Reason of `friend:removed` (absent = plain unfriend/block). */
export const FriendRemovedReason = {
  AccountDeleted: 'account_deleted', // the friend deleted their account
} as const;
export type FriendRemovedReason = (typeof FriendRemovedReason)[keyof typeof FriendRemovedReason];

/** Why a join request was rejected or ended. */
export const JoinRequestRejectReason = {
  Declined: 'declined', // host declined
  Timeout: 'timeout', // host did not answer in time
  HostChanged: 'host_changed', // the host changed; request must be repeated
  LobbyClosed: 'lobby_closed', // lobby closed
  Unlocked: 'unlocked', // lobby was unlocked (join directly)
  AlreadyInLobby: 'already_in_lobby', // requester joined another lobby
  LobbyFull: 'lobby_full', // no free slot
  Superseded: 'superseded', // replaced by a newer request
} as const;
export type JoinRequestRejectReason = (typeof JoinRequestRejectReason)[keyof typeof JoinRequestRejectReason];

/** Why a join request was withdrawn (`joinRequestWithdrawn`). */
export const JoinRequestWithdrawReason = {
  Cancelled: 'cancelled', // requester cancelled
  Timeout: 'timeout', // request expired
} as const;
export type JoinRequestWithdrawReason = (typeof JoinRequestWithdrawReason)[keyof typeof JoinRequestWithdrawReason];

/** Who can read a user data entry. */
export const DataVisibility = {
  Private: 'private', // only the owner
  Lobby: 'lobby', // owner and lobby members
  Public: 'public', // everyone (also on leaderboards)
} as const;
export type DataVisibility = (typeof DataVisibility)[keyof typeof DataVisibility];

/** Who may write a user data entry. */
export const DataWriteScope = {
  Client: 'client', // owner client may write
  Server: 'server', // only the game server may write
} as const;
export type DataWriteScope = (typeof DataWriteScope)[keyof typeof DataWriteScope];

/** How a friend request was initiated. */
export const FriendRequestSource = {
  Name: 'name', // sent by username
  Lobby: 'lobby', // sent to a player in the same lobby
} as const;
export type FriendRequestSource = (typeof FriendRequestSource)[keyof typeof FriendRequestSource];

/** Answer to a friend request by name (never reveals more). */
export const FriendRequestResult = {
  RequestSent: 'REQUEST_SENT', // request recorded (also returned for existing players, duplicates and self-requests)
  NoSuchPlayer: 'NO_SUCH_PLAYER', // no player with that name
} as const;
export type FriendRequestResult = (typeof FriendRequestResult)[keyof typeof FriendRequestResult];

/** Status a user can set for themselves. */
export const OwnPresenceStatus = {
  Online: 'online', // visible as online
  Away: 'away', // visible as away
  Busy: 'busy', // visible as busy
  Invisible: 'invisible', // appears offline to friends
} as const;
export type OwnPresenceStatus = (typeof OwnPresenceStatus)[keyof typeof OwnPresenceStatus];

/** Status of a friend as seen by others. */
export const FriendPresenceStatus = {
  Online: 'online', // friend is online
  Away: 'away', // friend is away
  Busy: 'busy', // friend is busy
  Offline: 'offline', // friend is offline or invisible
} as const;
export type FriendPresenceStatus = (typeof FriendPresenceStatus)[keyof typeof FriendPresenceStatus];

/** Why a lobby invite ended (`lobby:inviteCancelled`). */
export const LobbyInviteCancelReason = {
  Cancelled: 'cancelled', // sender cancelled
  Expired: 'expired', // invite timed out
  LobbyClosed: 'lobby_closed', // lobby closed
  LobbyFull: 'lobby_full', // lobby has no free slot
  Left: 'left', // sender left the lobby
  Unfriended: 'unfriended', // friendship ended
} as const;
export type LobbyInviteCancelReason = (typeof LobbyInviteCancelReason)[keyof typeof LobbyInviteCancelReason];

/** Type of a persisted notification. */
export const NotificationType = {
  FriendRequest: 'friend_request', // incoming friend request
  FriendAccepted: 'friend_accepted', // your request was accepted
  FriendRemoved: 'friend_removed', // a friend removed you
  Dm: 'dm', // direct message (collapsed per conversation)
  LobbyInvite: 'lobby_invite', // invited to a lobby
  LobbyInviteCancelled: 'lobby_invite_cancelled', // an invite ended
  FriendOnline: 'friend_online', // a friend came online (only sent while you are online)
  Kicked: 'kicked', // you were kicked from a lobby
  System: 'system', // hub announcement
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
  BlockLimitReached: 'BLOCK_LIMIT_REACHED',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
