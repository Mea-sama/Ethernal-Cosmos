# Wire enums

Every categorical value that travels over the wire (reasons, statuses, error codes, ...) is an enum. The wire values are plain strings,
so raw socket.io clients are unaffected; the ODKs expose them as typed enums.

- **Node.js**: const objects exported from `@ethernal/client` (value + type): `LobbyChangeReason.ServerRebound === 'server_rebound'`.
- **C#**: enums in `EthernalCosmos.Client.Models`: `LobbyChangeReason.ServerRebound`. Values unknown to an older SDK arrive as `Unknown` (the raw code stays available where relevant, e.g. `EthernalException.Code`).
- Source of truth: `shared/src/types/enums.ts`. This page and `Enums.cs` are generated: `npm run gen:enums` (CI checks they are current).

## LobbyStatus

Lifecycle state of a lobby.

Used in: `Lobby.status`

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `open` | `LobbyStatus.Open` | accepting players |
| `full` | `LobbyStatus.Full` | no free slot |
| `in_progress` | `LobbyStatus.InProgress` | game running (late join only if the game allows it) |
| `closed` | `LobbyStatus.Closed` | ended; kept briefly, then removed |

## LobbyChangeReason

Why a lobby changed; second argument of `lobbyUpdated` (and `lobby:updated` for game servers).

Used in: `lobbyUpdated` (2nd argument), `lobby:updated` (game server)

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `player_joined` | `LobbyChangeReason.PlayerJoined` | a player joined |
| `player_left` | `LobbyChangeReason.PlayerLeft` | a player left voluntarily |
| `host_left` | `LobbyChangeReason.HostLeft` | the host left and the lobby was closed or migrated (see game host-migration policy) |
| `host_transferred` | `LobbyChangeReason.HostTransferred` | host role passed to another player |
| `player_disconnected` | `LobbyChangeReason.PlayerDisconnected` | a player lost connection and is in the reconnect grace period |
| `player_reconnected` | `LobbyChangeReason.PlayerReconnected` | a disconnected player came back |
| `state_changed` | `LobbyChangeReason.StateChanged` | lobby status changed (e.g. open to in_progress or closed) |
| `locked` | `LobbyChangeReason.Locked` | host locked the lobby (join requests required) |
| `unlocked` | `LobbyChangeReason.Unlocked` | host unlocked the lobby |
| `kicked` | `LobbyChangeReason.Kicked` | a player was kicked |
| `settings_changed` | `LobbyChangeReason.SettingsChanged` | lobby settings were changed |
| `server_lost` | `LobbyChangeReason.ServerLost` | the game server connection was lost (resume grace running); after the grace the lobby is rebound, closed or continues serverless |
| `server_resumed` | `LobbyChangeReason.ServerResumed` | the lost game server reconnected in time |
| `server_draining` | `LobbyChangeReason.ServerDraining` | the game server started or stopped draining (see serverStatus) |
| `server_rebound` | `LobbyChangeReason.ServerRebound` | the lobby moved to another game server after the previous one was lost |

## LobbyServerStatus

Health of the game server bound to a lobby (`Lobby.serverStatus`).

Used in: `Lobby.serverStatus`

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `ok` | `LobbyServerStatus.Ok` | server connected and accepting |
| `lost` | `LobbyServerStatus.Lost` | server connection lost, resume grace running |
| `draining` | `LobbyServerStatus.Draining` | server finishes existing lobbies and accepts no new ones |

## ServerMode

Player preference for a game server at `createLobby` (`serverPreference.mode`).

Used in: `createLobby` (`serverPreference.mode`)

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `any` | `ServerMode.Any` | use a game server if the game supports one (default) |
| `none` | `ServerMode.None` | deliberately no game server (only for games with serverSupport `optional`) |

## ServerSupport

Whether a game uses game servers (`GameInfo.serverSupport`).

Used in: `GameInfo.serverSupport`

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `none` | `ServerSupport.None` | game never uses a game server |
| `optional` | `ServerSupport.Optional` | lobbies may use a game server if one is available (client can opt out) |
| `required` | `ServerSupport.Required` | lobbies need a game server; creation fails without one |

## LobbyAssignReason

Why a game server is asked to take a lobby (`lobby:assigned`). `server_rebound` = takeover of a lobby whose previous server was lost; the lobby already has state, settings and players.

Used in: `lobby:assigned` (game server)

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `new_lobby` | `LobbyAssignReason.NewLobby` | fresh lobby that was just created |
| `server_rebound` | `LobbyAssignReason.ServerRebound` | takeover of a lobby whose previous server was lost: the lobby already has state, settings and players; `previousServerId` and `lostAt` are set and the game state must be recovered or restarted |

## LobbyClosedReason

Why the hub tells a game server that a lobby ended (`lobby:closed`).

Used in: `lobby:closed` (game server)

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `closed` | `LobbyClosedReason.Closed` | lobby closed normally |
| `dissolved` | `LobbyClosedReason.Dissolved` | last player left |
| `host_left` | `LobbyClosedReason.HostLeft` | host left and policy closes the lobby |
| `reassigned` | `LobbyClosedReason.Reassigned` | lobby moved to another server |

## PlayerLeftReason

Why a player left a lobby (`player:left` for game servers).

Used in: `player:left` (game server)

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `left` | `PlayerLeftReason.Left` | player left voluntarily |
| `kicked` | `PlayerLeftReason.Kicked` | player was kicked |
| `timeout` | `PlayerLeftReason.Timeout` | reconnect grace expired |

## SessionReplacedReason

Reason of `session:replaced`.

Used in: `session:replaced`

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `new_session` | `SessionReplacedReason.NewSession` | the same account connected from a new session |

## JoinRequestRejectReason

Why a join request was rejected or ended.

Used in: `joinRequestRejected`

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `declined` | `JoinRequestRejectReason.Declined` | host declined |
| `timeout` | `JoinRequestRejectReason.Timeout` | host did not answer in time |
| `host_changed` | `JoinRequestRejectReason.HostChanged` | the host changed; request must be repeated |
| `lobby_closed` | `JoinRequestRejectReason.LobbyClosed` | lobby closed |
| `unlocked` | `JoinRequestRejectReason.Unlocked` | lobby was unlocked (join directly) |
| `already_in_lobby` | `JoinRequestRejectReason.AlreadyInLobby` | requester joined another lobby |
| `lobby_full` | `JoinRequestRejectReason.LobbyFull` | no free slot |
| `superseded` | `JoinRequestRejectReason.Superseded` | replaced by a newer request |

## JoinRequestWithdrawReason

Why a join request was withdrawn (`joinRequestWithdrawn`).

Used in: `joinRequestWithdrawn`

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `cancelled` | `JoinRequestWithdrawReason.Cancelled` | requester cancelled |
| `timeout` | `JoinRequestWithdrawReason.Timeout` | request expired |

## DataVisibility

Who can read a user data entry.

Used in: `UserDataEntry.visibility`, `setUserData`

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `private` | `DataVisibility.Private` | only the owner |
| `lobby` | `DataVisibility.Lobby` | owner and lobby members |
| `friends` | `DataVisibility.Friends` | owner and friends |
| `public` | `DataVisibility.Public` | leaderboard key; only a game server can set it |

## DataWriteScope

Who may write a user data entry.

Used in: `UserDataEntry.writeScope`

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `client` | `DataWriteScope.Client` | owner client may write |
| `server` | `DataWriteScope.Server` | only the game server may write |

## FriendRequestSource

How a friend request was initiated.

Used in: `FriendRequestInfo.source`

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `name` | `FriendRequestSource.Name` | sent by username |
| `lobby` | `FriendRequestSource.Lobby` | sent to a player in the same lobby |

## FriendRequestResult

Answer to a friend request by name (never reveals more).

Used in: `friend:request` ack (`result`)

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `REQUEST_SENT` | `FriendRequestResult.RequestSent` | request recorded (also returned for existing players, duplicates and self-requests) |
| `NO_SUCH_PLAYER` | `FriendRequestResult.NoSuchPlayer` | no player with that name |

## OwnPresenceStatus

Status a user can set for themselves.

Used in: `SocialSettings.status`, `social:setSettings`

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `online` | `OwnPresenceStatus.Online` | visible as online |
| `away` | `OwnPresenceStatus.Away` | visible as away |
| `busy` | `OwnPresenceStatus.Busy` | visible as busy |
| `invisible` | `OwnPresenceStatus.Invisible` | appears offline to friends |

## FriendPresenceStatus

Status of a friend as seen by others.

Used in: `friend:presence`

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `online` | `FriendPresenceStatus.Online` | friend is online |
| `away` | `FriendPresenceStatus.Away` | friend is away |
| `busy` | `FriendPresenceStatus.Busy` | friend is busy |
| `offline` | `FriendPresenceStatus.Offline` | friend is offline or invisible |

## LobbyInviteCancelReason

Why a lobby invite ended (`lobby:inviteCancelled`).

Used in: `lobby:inviteCancelled`

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `cancelled` | `LobbyInviteCancelReason.Cancelled` | sender cancelled |
| `expired` | `LobbyInviteCancelReason.Expired` | invite timed out |
| `lobby_closed` | `LobbyInviteCancelReason.LobbyClosed` | lobby closed |
| `lobby_full` | `LobbyInviteCancelReason.LobbyFull` | lobby has no free slot |
| `left` | `LobbyInviteCancelReason.Left` | sender left the lobby |
| `unfriended` | `LobbyInviteCancelReason.Unfriended` | friendship ended |

## NotificationType

Type of a persisted notification.

Used in: `notification`, `SocialSettings.mutedNotificationTypes`

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `friend_request` | `NotificationType.FriendRequest` | incoming friend request |
| `friend_accepted` | `NotificationType.FriendAccepted` | your request was accepted |
| `friend_removed` | `NotificationType.FriendRemoved` | a friend removed you |
| `dm` | `NotificationType.Dm` | direct message (collapsed per conversation) |
| `lobby_invite` | `NotificationType.LobbyInvite` | invited to a lobby |
| `lobby_invite_cancelled` | `NotificationType.LobbyInviteCancelled` | an invite ended |
| `friend_online` | `NotificationType.FriendOnline` | a friend came online (only sent while you are online) |
| `kicked` | `NotificationType.Kicked` | you were kicked from a lobby |
| `system` | `NotificationType.System` | hub announcement |

## ErrorCode

Stable machine-readable error codes (the `message` text is for display only).

Used in: `errorDetail`, ack errors, REST error `code`

| Wire value | Node.js / C# member | Meaning |
|---|---|---|
| `INVALID_INPUT` | `ErrorCode.InvalidInput` |  |
| `RATE_LIMITED` | `ErrorCode.RateLimited` |  |
| `INTERNAL` | `ErrorCode.Internal` |  |
| `NOT_FOUND` | `ErrorCode.NotFound` |  |
| `UNAUTHENTICATED` | `ErrorCode.Unauthenticated` |  |
| `INVALID_TOKEN` | `ErrorCode.InvalidToken` |  |
| `INVALID_CREDENTIALS` | `ErrorCode.InvalidCredentials` |  |
| `USERNAME_TAKEN` | `ErrorCode.UsernameTaken` |  |
| `USER_NOT_FOUND` | `ErrorCode.UserNotFound` |  |
| `INVALID_REFRESH_TOKEN` | `ErrorCode.InvalidRefreshToken` |  |
| `REFRESH_TOKEN_REVOKED` | `ErrorCode.RefreshTokenRevoked` |  |
| `REFRESH_TOKEN_EXPIRED` | `ErrorCode.RefreshTokenExpired` |  |
| `GAME_NOT_REGISTERED` | `ErrorCode.GameNotRegistered` |  |
| `UNKNOWN_GAME` | `ErrorCode.UnknownGame` |  |
| `CLIENT_OUTDATED` | `ErrorCode.ClientOutdated` |  |
| `LEAVE_LOBBY_FIRST` | `ErrorCode.LeaveLobbyFirst` |  |
| `GAME_MISMATCH` | `ErrorCode.GameMismatch` |  |
| `ALREADY_IN_LOBBY` | `ErrorCode.AlreadyInLobby` |  |
| `NOT_IN_LOBBY` | `ErrorCode.NotInLobby` |  |
| `LOBBY_NOT_FOUND` | `ErrorCode.LobbyNotFound` |  |
| `LOBBY_CLOSED` | `ErrorCode.LobbyClosed` |  |
| `LOBBY_LOCKED` | `ErrorCode.LobbyLocked` |  |
| `LOBBY_FULL` | `ErrorCode.LobbyFull` |  |
| `LOBBY_PRIVATE` | `ErrorCode.LobbyPrivate` |  |
| `INVALID_INVITE_CODE` | `ErrorCode.InvalidInviteCode` |  |
| `INVITE_CODE_NOT_FOUND` | `ErrorCode.InviteCodeNotFound` |  |
| `KICKED_FROM_LOBBY` | `ErrorCode.KickedFromLobby` |  |
| `NOT_HOST` | `ErrorCode.NotHost` |  |
| `ALREADY_HOST` | `ErrorCode.AlreadyHost` |  |
| `CANNOT_KICK_SELF` | `ErrorCode.CannotKickSelf` |  |
| `PLAYER_NOT_FOUND` | `ErrorCode.PlayerNotFound` |  |
| `LOBBY_START_FAILED` | `ErrorCode.LobbyStartFailed` |  |
| `LOBBY_IN_PROGRESS` | `ErrorCode.LobbyInProgress` |  |
| `INSTANCE_LIMIT` | `ErrorCode.InstanceLimit` |  |
| `INVALID_STATE` | `ErrorCode.InvalidState` |  |
| `CANNOT_TARGET_SELF` | `ErrorCode.CannotTargetSelf` |  |
| `PAYLOAD_TOO_LARGE` | `ErrorCode.PayloadTooLarge` |  |
| `INVALID_MESSAGE_TYPE` | `ErrorCode.InvalidMessageType` |  |
| `AUTH_EXPIRED` | `ErrorCode.AuthExpired` |  |
| `INVALID_SERVER_KEY` | `ErrorCode.InvalidServerKey` |  |
| `GAME_SERVER_NOT_ALLOWED` | `ErrorCode.GameServerNotAllowed` |  |
| `NO_GAME_SERVER_AVAILABLE` | `ErrorCode.NoGameServerAvailable` |  |
| `NOT_LOBBY_SERVER` | `ErrorCode.NotLobbyServer` |  |
| `SERVER_UNAVAILABLE` | `ErrorCode.ServerUnavailable` |  |
| `SETTINGS_TOO_LARGE` | `ErrorCode.SettingsTooLarge` |  |
| `JOIN_REQUEST_NOT_FOUND` | `ErrorCode.JoinRequestNotFound` |  |
| `PLAYER_NOT_IN_LOBBY` | `ErrorCode.PlayerNotInLobby` |  |
| `PLAYER_UNREACHABLE` | `ErrorCode.PlayerUnreachable` |  |
| `INVALID_LOBBY_CONTEXT` | `ErrorCode.InvalidLobbyContext` |  |
| `INVALID_BINARY_TYPECODE` | `ErrorCode.InvalidBinaryTypecode` |  |
| `INVALID_BINARY_PAYLOAD` | `ErrorCode.InvalidBinaryPayload` |  |
| `BINARY_PAYLOAD_TOO_LARGE` | `ErrorCode.BinaryPayloadTooLarge` |  |
| `GAME_NOT_RUNNING` | `ErrorCode.GameNotRunning` |  |
| `DATA_READ_ONLY` | `ErrorCode.DataReadOnly` |  |
| `DATA_QUOTA_EXCEEDED` | `ErrorCode.DataQuotaExceeded` |  |
| `DATA_VALUE_TOO_LARGE` | `ErrorCode.DataValueTooLarge` |  |
| `DATA_KEY_NOT_FOUND` | `ErrorCode.DataKeyNotFound` |  |
| `NOT_FRIENDS` | `ErrorCode.NotFriends` |  |
| `FRIEND_REQUEST_NOT_FOUND` | `ErrorCode.FriendRequestNotFound` |  |
| `FRIEND_LIMIT_REACHED` | `ErrorCode.FriendLimitReached` |  |
| `REQUEST_LIMIT_REACHED` | `ErrorCode.RequestLimitReached` |  |
| `FRIEND_OFFLINE` | `ErrorCode.FriendOffline` |  |
| `FRIEND_NOT_IN_LOBBY` | `ErrorCode.FriendNotInLobby` |  |
| `INVITE_NOT_FOUND` | `ErrorCode.InviteNotFound` |  |
| `MESSAGE_TOO_LONG` | `ErrorCode.MessageTooLong` |  |
| `NOT_ALLOWED` | `ErrorCode.NotAllowed` |  |
| `VERSION_CONFLICT` | `ErrorCode.VersionConflict` |  |
