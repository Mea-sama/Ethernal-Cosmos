# C# SDK (ODK) — `EthernalCosmos.Client`

.NET 8 client for the Ethernal Cosmos Hub. It wraps the REST API and the socket.io connection into an async/await API with C# events. Every public type and member has an XML doc comment (enforced at build time, `CS1591` is an error).

Related: [enums](enums.md) · [socket events](socket-events.md) · [social API](social-api.md) · [REST API](rest-api.md)

## Installation

```xml
<ProjectReference Include="..\csharp-sdk\EthernalCosmos.Client\EthernalCosmos.Client.csproj" />
```

Dependencies: `SocketIOClient`, `Microsoft.Extensions.Logging.Abstractions`; JSON via `System.Text.Json`.

## Quick start

```csharp
using EthernalCosmos.Client;
using EthernalCosmos.Client.Models;

await using var client = new EthernalClient(new EthernalClientOptions { ServerUrl = "http://localhost:12346" });

client.LobbyChanged += (lobby, reason) => Console.WriteLine($"{lobby.Name}: {reason}");
client.Message      += m => Console.WriteLine($"{m.From}: {m.Type}");

await client.LoginAsync("my-bot", "password123");   // or RegisterAsync; connects the socket
await client.RegisterGameAsync("chess");            // once per connection, re-sent on reconnect
var lobby = await client.CreateLobbyAsync("Fast game");
await client.SendToLobbyAsync("move", new { from = "e2", to = "e4" });
```

`EthernalClientOptions`: `ServerUrl` (required, no trailing slash) and `RequestTimeout` (default 5 s, applies to socket calls).

## Errors

Every failing call — socket **and** REST — throws `EthernalException`:

```csharp
try { await client.JoinLobbyByCodeAsync("ZZZZZZ"); }
catch (EthernalException ex) when (ex.Error == ErrorCode.LobbyNotFound) { /* typed */ }
catch (EthernalException ex) { Console.WriteLine(ex.Code); }   // raw wire string, e.g. "NEW_CODE"
```

| Member | Meaning |
|--------|---------|
| `Code` | Raw wire code. Always preserved, even if this SDK does not know it. REST failures without a hub code use `HTTP_<status>`. |
| `Error` | `ErrorCode` enum. `ErrorCode.Unknown` for codes this SDK version does not know. |
| `RetryAfterMs` | Set for rate-limit errors. |

The `ErrorDetail` event delivers every `error` socket event as a `HubErrorPayload` (`Code`, `Error`, `Message`, `Event`, `RequestId`, `RetryAfterMs`). `ServerError` is a plain-string channel for transport and parse errors. See [enums](enums.md) for all codes.

## Wire enums

All enums (`LobbyStatus`, `LobbyChangeReason`, `ErrorCode`, `DataVisibility`, `NotificationType`, …) live in `Models/Enums.cs`, which is **generated** from `shared/src/types/enums.ts` (`npm run gen:enums`) — never edit it by hand. They serialize as their exact wire string through `WireEnumConverter<T>`. Strings this SDK does not know become `Unknown` (value `0`) instead of throwing, so older clients keep working when the hub adds values.

```csharp
LobbyStatus.InProgress.Wire();                    // "in_progress"
WireEnumConverter<ErrorCode>.Parse("LOBBY_FULL"); // ErrorCode.LobbyFull
```

Full value lists: [enums.md](enums.md).

## Auth lifecycle

| Method | Description |
|--------|-------------|
| `RegisterAsync(username, password)` | Create an account, store tokens, connect the socket. Returns `AuthResult`. |
| `LoginAsync(username, password)` | Log in and connect. A second login of the same user replaces the first game session (`SessionReplaced`); set `EthernalClientOptions.ClientType = ClientType.Panel` for an additional companion session (overlay, second device) that coexists with the game session and also receives user-targeted events (DMs, `DirectMessageReadStateChanged`, join-request confirmations). |
| `RefreshSocketAuthAsync()` | Renew the access token via the refresh token and pass it to the live socket (`auth:refresh`). |
| `LogoutAsync()` | Revoke this refresh token, disconnect, forget tokens and the registered game. |
| `DisconnectAsync()` | Close the socket only: tokens and game are kept and the hub holds your lobby seat for the game's reconnect grace period. Call `LoginAsync` to resume. |
| `LogoutAllAsync()` | Revoke **all** refresh tokens of the account and disconnect every session. |

Access tokens are short-lived. When the hub reports `AUTH_EXPIRED` the SDK refreshes the token and re-authenticates the socket automatically, so the session survives. If that fails, `AuthError` is raised and you should log in again. Use `RefreshSocketAuthAsync` to refresh proactively. `Connected`/`Disconnected` track the transport; `Disconnected` is raised exactly once per lost connection, and with `"io client disconnect"` after a local `DisconnectAsync`, `LogoutAsync` or dispose; on reconnect the SDK re-registers the game and the hub resumes your lobby (`SessionResumed`).

```csharp
client.AuthError    += msg => Console.WriteLine("log in again: " + msg);
client.Disconnected += reason => Console.WriteLine("lost: " + reason);
```

## Session

```csharp
RegisterGameResult g = await client.RegisterGameAsync("chess", clientVersion: "1.2.0", platform: "windows");
g.Game.ServerSupport;   // ServerSupport.None | Optional | Required
g.Game.Regions;         // string[]? e.g. ["eu","us"]
SessionStateResult s = await client.GetSessionStateAsync();   // s.State.LobbyId, s.Lobby
```

`Hello` (`HelloPayload`) fires after every connect with protocol version, capabilities and — after a reconnect — the lobby you are still in. `SessionResumed` (`SessionResumedData`: `State` + `Lobby`) fires when a lobby membership is restored; `SessionReplaced` (`SessionReplacedData.Reason`) when a newer session took over.

## Lobbies

```csharp
Task<Lobby> CreateLobbyAsync(string name, bool isPrivate = false, Dictionary<string, object?>? settings = null,
                             CancellationToken ct = default, ServerMode? serverMode = null, string? serverRegion = null)
```

| Method | Description |
|--------|-------------|
| `CreateLobbyAsync` | You become host. `settings` is free-form game config. `serverMode` ([`ServerMode`](enums.md#servermode): `Any` or `None`) and `serverRegion` express a game-server preference for games with `ServerSupport` optional/required; a required game without an available server fails with `NO_GAME_SERVER_AVAILABLE`. |
| `JoinLobbyAsync(lobbyId)` / `JoinLobbyByCodeAsync(code)` | Join a public lobby / any lobby by invite code. |
| `LeaveLobbyAsync()` | Leave the current lobby. |
| `ListLobbiesAsync()` | Public, joinable lobbies of the registered game (`Lobby.ServerBound`, `Region`, `Joinable` are set in listings). Result also raises `LobbyList`. |
| `GetLobbyInfoAsync()` | Your current lobby (members see `Server` and `ServerStatus`). Also raises `LobbyInfo`. |
| `KickPlayerAsync(playerId, reason?)` | Host only. The kicked player gets `PlayerKicked` (`LobbyId`, optional `Reason`, max. 200 chars) and cannot rejoin this lobby: `JoinLobbyAsync` throws `KICKED_FROM_LOBBY` (`ErrorCode.KickedFromLobby`). |
| `UnkickPlayerAsync(playerId)` | Host only. Lifts the kick so the player may join again (idempotent). |
| `TransferHostAsync(playerId)` | Host only. |
| `LockLobbyAsync()` / `UnlockLobbyAsync()` | Host only. A locked lobby requires accepted join requests. |
| `SetLobbyStateAsync(LobbyStatus state)` | Host only; `LobbyStatus.InProgress` or `LobbyStatus.Closed` (other values are rejected with `INVALID_INPUT`). |

Lobby changes:

```csharp
client.LobbyCreated += lobby => { };                       // you created one
client.LobbyUpdated += lobby => { };                       // any change
client.LobbyChanged += (lobby, reason) =>                  // same, with the reason
{
    if (reason == LobbyChangeReason.ServerRebound) { /* game server replaced, lobby unchanged */ }
};
```

`LobbyChangeReason` includes `PlayerJoined`, `PlayerLeft`, `HostLeft`, `HostTransferred`, `PlayerDisconnected`, `PlayerReconnected`, `StateChanged`, `Locked`, `Unlocked`, `Kicked`, `SettingsChanged`, `ServerLost`, `ServerResumed`, `ServerDraining`, `ServerRebound` — see [enums.md](enums.md); `reason` is `null` for hubs that do not send one.

### Join requests

For locked lobbies, `RequestJoinLobbyAsync(lobbyId)` / `RequestJoinLobbyByCodeAsync(code)` send a request and complete when the host accepts (you are then already a member) or throw `EthernalException` otherwise (the matching event is raised too):

| Outcome | Exception code | Event |
|---------|----------------|-------|
| Declined, expired, host changed, lobby closed | `LOBBY_LOCKED` (`ErrorCode.LobbyLocked`) | `JoinRequestRejected` (`.Reason`) |
| ↳ expiry (`ExpiresAt`, hub `joinRequestTimeoutMs`) | `LOBBY_LOCKED` | `JoinRequestRejected` (`Timeout`); host: `JoinRequestWithdrawn` (`Timeout`) |
| Cancelled via `CancelJoinRequestAsync(lobbyId)` (any session of the user) | `JOIN_REQUEST_NOT_FOUND` | `JoinRequestWithdrawn` (`Cancelled`) on host **and** all requester sessions |

`CancelJoinRequestAsync` throws `JOIN_REQUEST_NOT_FOUND` when no request is open. The host answers with `RespondJoinRequestAsync(requesterId, accept)`. After a reconnect pull the state with `GetJoinRequestsAsync()` → `JoinRequestsResult` (`Incoming` as host, `Outgoing` as requester; each `JoinRequestInfo` has `LobbyId`, `RequesterId`, `Username`, `ExpiresAt`).

Events: host — `JoinRequestReceived` (`.ExpiresAt`), `JoinRequestWithdrawn` (`.LobbyId`, `.Reason`); requester — `JoinRequestPending` (`.ExpiresAt`), `JoinRequestAccepted` (`.Lobby`), `JoinRequestRejected` (`.Reason`: `JoinRequestRejectReason`), `JoinRequestWithdrawn` (cancel confirmation).

## Relay

Messages are relayed unchanged by the hub to the other lobby members. By default they never go back to the sender; pass `echo: true` (all four send methods) to receive your own message too (all own sessions, via `Message`/`MessageBinary`) and to allow `SendToPlayerAsync` to yourself.

```csharp
await client.SendToLobbyAsync("chat", new { text = "hi" });
await client.SendToPlayerAsync(playerId, "whisper", new { text = "psst" });
await client.SendToLobbyBinaryAsync(typeCode: 7, bytes);
await client.SendToPlayerBinaryAsync(playerId, 7, bytes);
await client.SendToLobbyAsync("state", new { x = 1 }, echo: true);   // sender receives it as well

client.Message += m =>
{
    var chat = m.PayloadAs<ChatDto>();          // or m.TryPayloadAs(out ChatDto? c)
    Console.WriteLine($"#{m.Seq} {m.From} {m.Type}");
};
client.MessageBinary += m => Console.WriteLine($"{m.TypeCode}: {m.Payload.Length} bytes");
```

`RelayMessage` / `RelayBinaryMessage` carry `From`, the per-lobby sequence number `Seq` and the payload. Binary payloads travel as `byte[]`.

## Game actions (hosted games)

`SendGameActionAsync(type, payload)` forwards an action to the game process of a hosted lobby. Results arrive as `GameStarting` (`GameStartingData`), `GameState`, `GameEvent` and `GameOver` (all `JsonElement`). For games without a game process the action is ignored — use the relay.

## User data

Socket:

| Method | Description |
|--------|-------------|
| `GetUserDataAsync(gameId)` | Own entries (`UserDataEntry[]`). |
| `GetPlayerDataAsync(playerId, gameId)` | Entries of another player you may see: `lobby` entries when you share their lobby, `friends` entries when you are friends. Without either relation the call throws `NOT_ALLOWED`; `public` entries are never returned (use the leaderboard). |
| `SetUserDataAsync(gameId, key, value, visibility?)` | Write one key. Clients may use `Private`, `Lobby` and `Friends`; `Public` throws `NOT_ALLOWED` (public keys are written by game servers, see [`GameServerClient`](#gameserverclient)). |
| `BulkSetUserDataAsync(gameId, entries)` | `IEnumerable<(string Key, object? Value, DataVisibility? Visibility)>`. |
| `DeleteUserDataAsync(gameId, key)` | Idempotent delete. |
| `IncrementUserDataAsync(gameId, key, by, visibility?)` | Atomically add `by` to a numeric key (missing = 0); returns `UserDataWriteResult` (`Value`, `Version`). |
| `SetUserDataIfAsync(gameId, key, value, expectedVersion, visibility?)` | Compare-and-set (`0` = key must not exist). On mismatch throws `VERSION_CONFLICT`; `ex.Conflict.Current` holds the current `Value` and `Version`. |
| `TransactUserDataAsync(gameId, ops)` | 1–100 `UserDataOp` (`Set`, `Increment`, `SetIf`, `Delete` factories) all-or-nothing; returns one `UserDataOpResult` per op. |

REST (same data):

| Method | Description |
|--------|-------------|
| `SetKeyAsync(gameId, key, value, visibility?)` | Set or update one key. |
| `DeleteKeyAsync(gameId, key)` | Delete a key. |
| `BulkSetAsync(gameId, entries)` | Up to 100 entries per call. |
| `GetAllDataAsync(gameId)` | All own entries. |
| `GetLeaderboardAsync(gameId, key, order = "desc", limit = 10, ct, offset?, friendsOnly = false)` | Leaderboard of a `Public` numeric key (`LeaderboardEntry[]`: `Rank`, `UserId`, `Username`, `Value`, `UpdatedAt`). `offset` pages, `friendsOnly` = `scope=friends` (you and your friends). Only games with server support have leaderboards (others: `NOT_FOUND`). |
| `GetLeaderboardWithMeAsync(gameId, key, order, limit, ct, offset?, friendsOnly, around = false, range?)` | Same, as `LeaderboardResult { Entries, Me, Total }`. `Me` is your own row/rank (null when unranked; also works when you are hidden). `around: true` returns a window of `range` (1–50) rows around you instead of the top. |

`DataVisibility`: `Private`, `Lobby`, `Friends`, `Public`. `Public` is server-write-only and feeds the leaderboard; players can opt out of leaderboards with `SetSocialSettingsAsync(leaderboardVisible: false)`. `UserDataEntry` also reports `WriteScope` (`Client`, `Server` — server-written keys cannot be changed by clients) and `Version`. `Value` is `object?` backed by `JsonElement`: `((JsonElement)entry.Value!).GetInt32()`. Events `UserData` (`UserDataPayload`) and `PlayerData` (`PlayerDataPayload`) deliver pushed data.

## Social

Friends, presence, notifications, DMs and invites; details of the wire protocol in [social-api.md](social-api.md).

### Friends

```csharp
FriendRequestResult r = await client.RequestFriendByNameAsync("alice");
// RequestSent or NoSuchPlayer — the hub never reveals anything else about an account
await client.RequestFriendFromLobbyAsync(playerUserId);   // player in your lobby

var open = await client.ListFriendRequestsAsync();        // .Incoming / .Outgoing (FriendRequestInfo)
await client.RespondFriendRequestAsync(open.Incoming[0].Id, accept: true);
await client.CancelFriendRequestAsync(requestId);         // outgoing
await client.RemoveFriendAsync(friendId);
FriendInfo[] friends = await client.ListFriendsAsync();
```

Events: `FriendRequestReceived` (`FriendRequestInfo`), `FriendRequestAccepted`, `FriendRequestDeclined`, `FriendRequestCancelled` (request id), `FriendRemoved` (user id).

### Presence and settings

```csharp
FriendPresence[] p = await client.GetFriendsPresenceAsync();   // never contains a lobby id
client.FriendPresenceChanged += pr => Console.WriteLine($"{pr.Username}: {pr.Status}");

SocialSettings s = await client.SetSocialSettingsAsync(
    status: OwnPresenceStatus.Invisible, showLastSeen: false, dmReadReceipts: false,
    mutedNotificationTypes: new[] { NotificationType.Dm });   // only non-null arguments change
await client.GetSocialSettingsAsync();
```

`SocialSettings.LeaderboardVisible` (default true; set with `leaderboardVisible:`) controls whether you appear in leaderboards.

`FriendPresenceStatus`: `Online`, `Away`, `Busy`, `Offline` (`FriendPresence.GameId`/`LobbyJoinable` tell whether the friend is playing); own status (`OwnPresenceStatus`): `Online`, `Away`, `Busy`, `Invisible`. Online friends get a `NotificationType.FriendOnline` notification when you become visible.

`SyncSocialAsync(etag)` returns the complete state (`SocialSnapshot`: friends, presence, requests, invites, unread counts, settings) in one call. Pass the previous `Etag` to get `NotModified == true` when nothing changed:

```csharp
var snap = await client.SyncSocialAsync();
var again = await client.SyncSocialAsync(snap.Etag);   // again.NotModified
```

`GetFriendLobbyAsync(friendId)` returns a `FriendLobbyInfo?` (`LobbyId` is null for private lobbies).

### Notifications

```csharp
client.NotificationBacklogReceived += b => Console.WriteLine(b.UnreadCount);   // right after connect
client.NotificationReceived        += n => Console.WriteLine(n.Type);

var page = await client.ListNotificationsAsync(limit: 20, unreadOnly: true);   // page.NextCursor
await client.MarkNotificationsReadAsync(ids: new[] { page.Notifications[0].Id });
await client.MarkNotificationsReadAsync(upTo: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
NotificationCounts c = await client.GetNotificationCountsAsync();             // Unread, Total, ByType
```

`HubNotification.Payload` is a `JsonElement` whose shape depends on `Type`, e.g. `friend_request` → `{ requestId, fromUserId, fromUsername, source }`.

### Direct messages

```csharp
DirectMessage m = await client.SendDirectMessageAsync(friendId, "hello");   // m.DeliveredAt != null if online
client.DirectMessageReceived  += dm => { };
client.DirectMessageDelivered += d  => { };   // offline recipient connected: d.MessageIds
client.DirectMessageRead      += r  => { };   // r.UpToSeq (if the friend enabled read receipts)
client.DirectMessageTyping    += t  => { };

await client.SendTypingAsync(friendId);
DmHistoryResult h = await client.GetDmHistoryAsync(friendId, limit: 50);          // newest first
var older = await client.GetDmHistoryAsync(friendId, before: h.NextBefore);       // paging
DmConversation[] convs = await client.ListConversationsAsync();                   // last message + unread
int marked = await client.MarkConversationReadAsync(friendId);
```

Read cursor / unread badges (`seq` values are per message, `long`):

```csharp
DmUnreadResult u = await client.GetDmUnreadAsync();    // u.TotalUnread; per chat: UnreadCount, FirstUnreadSeq, LastSeq, LastMessageAt
// Open a chat: last 10 messages (limit optional) + read state from BEFORE opening, then everything is marked read
DmHistoryResult chat = await client.OpenDmConversationAsync(friendId);
// chat.LastReadSeq, chat.FirstUnreadSeq (draw the "new messages" divider), chat.UnreadCount, chat.PeerLastReadSeq (null if the friend disabled read receipts)
DmReadState s = await client.MarkDmReadAsync(friendId, upToSeq: 42);   // partial; omit upToSeq for all
// s.Marked, s.LastReadSeq, s.UnreadCount (this chat), s.TotalUnread (app badge)
client.DirectMessageReadStateChanged += st => { };    // read cursor moved, also from your other sessions -> clear the badge
```

`GetDmHistoryAsync` also returns `LastReadSeq`, `FirstUnreadSeq`, `UnreadCount` and `PeerLastReadSeq`; `ListConversationsAsync` entries carry `LastReadSeq`. `MarkConversationReadAsync` remains as a shortcut that returns only the marked count.

### Blocks

| Method | Description |
|--------|-------------|
| `BlockUserAsync(userId)` | Idempotent. Removes the friendship and pending requests/invites in both directions; their later friend requests are ignored. Returns `BlockedUserInfo` (`UserId`, `Username`, `BlockedAt`). Throws `BLOCK_LIMIT_REACHED` at the cap. |
| `UnblockUserAsync(userId)` | Idempotent. Does not restore the friendship. |
| `GetBlockedUsersAsync()` | Your blocked users (`BlockedUserInfo[]`). |

### Lobby invites and joining friends

```csharp
LobbyInvite inv = await client.InviteFriendAsync(friendId);   // needs a lobby of your own game
await client.CancelLobbyInviteAsync(inv.InviteId);
// the friend:
client.LobbyInviteReceived += i => client.AcceptLobbyInviteAsync(i.InviteId);   // returns the Lobby
await client.DeclineLobbyInviteAsync(inviteId);
LobbyInvite[] open = await client.ListLobbyInvitesAsync();

JoinFriendResult j = await client.JoinFriendAsync(friendId);  // j.Lobby, or j.Pending for locked lobbies
```

Events: `LobbyInviteReceived`, `LobbyInviteCancelled` (`.Reason`: `LobbyInviteCancelReason`), `LobbyInviteDeclined`.

## Account

| Method | Description |
|--------|-------------|
| `ChangePasswordAsync(currentPassword, newPassword)` | Invalidates all tokens of the account and disconnects your other sessions (`SessionReplaced`, reason `PasswordChanged`). The new tokens are stored in the client, which keeps its socket; the returned `AuthResult` carries them too. Wrong password: `INVALID_CREDENTIALS`. |
| `DeleteAccountAsync(password)` | Permanently deletes the account and all its data (GDPR); every session is disconnected and the client is logged out. |
| `ExportAccountDataAsync()` | Everything the hub stores about you as `AccountExport` (`Profile`, `UserData`, `Friends`, `Messages`, `Notifications`, `Settings`, `Blocks`). |

## Errors and rate limits

Every failing call throws `EthernalException` with a stable `Code` / `Error` ([`ErrorCode`](enums.md#errorcode)) and a message. `RATE_LIMITED` (`ErrorCode.RateLimited`) additionally sets `RetryAfterMs` (wait that long before retrying): for REST calls (429), for socket acks and for refused connections (`LoginAsync`/`RegisterAsync` when `maxSessionsPerUser` / `maxConnectionsPerIp` is hit, and `GameServerClient.ConnectAsync`). `ex.ErrorData` holds the structured error `data` when the hub sent one; `ex.Conflict` is parsed for `VERSION_CONFLICT`.

```csharp
try { await client.CreateLobbyAsync("x"); }
catch (EthernalException ex) when (ex.Error == ErrorCode.RateLimited) { await Task.Delay(ex.RetryAfterMs ?? 1000); }
```

## GameServerClient

`GameServerClient` (same assembly) lets a **game server** — a service running the authoritative logic of many lobbies of one game — talk to the hub's `/gameserver` namespace. Protocol: [game-server-protocol.md](game-server-protocol.md). The game needs `serverSupport` `optional` or `required`; keys are issued with the admin API.

```csharp
await using var server = new GameServerClient(new GameServerClientOptions
{
    ServerUrl = "http://localhost:12346", ServerKey = "esk_...", GameId = "chess",
    ServerId = "chess-eu-1", Region = "eu", Capacity = 20,
});
server.LobbyAssigned += a => Console.WriteLine($"{a.Lobby.Id} {a.Reason} (previous {a.PreviousServerId}, lost at {a.LostAt})");
server.PlayerAction  += async a => await server.RelayToLobbyAsync(a.LobbyId, "moved", a.Payload);
GameServerHello hello = await server.ConnectAsync();   // hello.Resumed, hello.Lobbies
```

| Member | Description |
|--------|-------------|
| `GameServerClientOptions` | `ServerUrl`, `ServerKey`, `GameId`, `ServerId`, `Region`, `Capacity`, `Version`, `RequestTimeout`. |
| `ConnectAsync()` | Connect and wait for `hello`. The same `ServerId` within the hub's resume grace (`SERVER_RESUME_GRACE_MS`) resumes the server and its lobbies (`Resumed == true`). Throws `EthernalException` with `INVALID_SERVER_KEY`, `UNKNOWN_GAME`, `GAME_SERVER_NOT_ALLOWED`, `INVALID_INPUT` or `RATE_LIMITED` (`RetryAfterMs`). |
| `DisconnectAsync()` / `DisposeAsync()` | Close the socket. The hub holds the lobbies for the grace period; afterwards it rebinds them to another server of the game. |
| `ServerId`, `IsConnected`, `Lobbies` | Own id, connection state and a snapshot of the lobbies assigned to this server. |
| `AssignmentHandler` | `Func<AssignInfo, Task<AssignmentDecision>>`; return `AssignmentDecision.Accept` or `AssignmentDecision.Reject(reason)` (the hub waits `SERVER_ASSIGN_TIMEOUT_MS`). Default: accept. |
| `RelayAsync(lobbyId, type, payload, toUserId)` | Typed message to all members (`RelayToLobbyAsync`) or one member (`RelayToPlayerAsync`); returns the sequence number. Players receive it as `Message`. There is no `echo` for servers: a server is not a member and never receives its own messages. |
| `SendStateAsync(lobbyId, state, toUserId?)` | State to all / one member (`GameState` event). |
| `KickPlayerAsync(lobbyId, userId, reason?)` | Kick with reason; the player gets `PlayerKicked` and cannot rejoin until the host calls `UnkickPlayerAsync`. |
| `SetLobbyStateAsync(lobbyId, state)` | `LobbyStatus.InProgress` or `Closed`. |
| `SetLobbySettingsAsync(lobbyId, settings)` | Replace the lobby settings. |
| `GameOverAsync(lobbyId, result?)` / `CloseLobbyAsync(lobbyId)` | Announce the result (`GameOver` event) and close / close silently. |
| `ReportStatusAsync(draining?, capacity?)` | Heartbeat and status; returns `GameServerInfo` (`Load`, `Capacity`, `Draining`, ...). |
| `DrainAsync(draining = true)` | A draining server gets no new lobbies; members see `ServerStatus == Draining`. |
| `SetDataAsync`, `BulkSetDataAsync`, `GetDataAsync`, `IncrementDataAsync`, `SetDataIfAsync`, `TransactDataAsync` | Authoritative player data (`lobbyId`, `userId`, ...), same semantics as the client calls plus `Public` visibility and `DataWriteScope.Server`. The player must be (or just have been, up to 60 s) a member of a lobby bound to this server, otherwise `NOT_ALLOWED`. |

Events (all typed): `Connected`, `Disconnected(string)`, `Hello`, `LobbyAssigned` (`AssignInfo`: `Lobby`, `Players`, `Reason`, `PreviousServerId`, `LostAt`), `LobbyUpdated`, `LobbyClosed`, `PlayerJoined`, `PlayerLeft`, `PlayerDisconnected`, `PlayerReconnected`, `PlayerAction` (`PayloadAs<T>()`), `ServerError`.

`AssignInfo.Reason` is `LobbyAssignReason.NewLobby` (fresh, empty state) or `ServerRebound` — a **takeover** of a lobby whose server was lost; the hub keeps no game state, so restore it from your own storage using `Lobby.Id` (`PreviousServerId` and `LostAt` identify the lost server).

## Event reference

| Group | Events |
|-------|--------|
| Connection | `Connected`, `Disconnected(string)`, `AuthError(string)`, `ServerError(string)`, `Hello`, `ErrorDetail` |
| Session | `SessionResumed`, `SessionReplaced` |
| Lobby | `LobbyCreated`, `LobbyUpdated`, `LobbyChanged`, `LobbyList`, `LobbyInfo`, `PlayerKicked` |
| Join requests | `JoinRequestReceived`, `JoinRequestPending`, `JoinRequestAccepted`, `JoinRequestRejected`, `JoinRequestWithdrawn` |
| Game | `GameStarting`, `GameState`, `GameEvent`, `GameOver` |
| Relay & data | `Message`, `MessageBinary`, `UserData`, `PlayerData` |
| Friends | `FriendPresenceChanged`, `FriendRequestReceived`, `FriendRequestAccepted`, `FriendRequestDeclined`, `FriendRequestCancelled`, `FriendRemoved` |
| Notifications / DMs | `NotificationReceived`, `NotificationBacklogReceived`, `DirectMessageReceived`, `DirectMessageDelivered`, `DirectMessageRead`, `DirectMessageReadStateChanged`, `DirectMessageTyping` |
| Invites | `LobbyInviteReceived`, `LobbyInviteCancelled`, `LobbyInviteDeclined` |

Handlers run on the socket thread; keep them short and marshal to your UI/game thread. Call `DisposeAsync()` (or `await using`) when done.

## Models

Plain immutable classes in `EthernalCosmos.Client.Models` (see the XML docs for every member):

- Lobby: `Lobby` (`Id`, `GameId`, `Name`, `HostId`, `Players`, `MaxPlayers`, `Status`, `IsPrivate`, `Hosted`, `InviteCode`, `Settings`, `Locked`, `CreatedAt`, `Server`, `ServerStatus`, `ServerBound`, `Region`, `Joinable`), `LobbyPlayer` (`Connected` is false during the reconnect grace period), `LobbyServerBinding`.
- Session: `HelloPayload`, `SessionState`, `SessionStateResult`, `RegisterGameResult`, `GameInfo`, `SessionResumedData`, `SessionReplacedData`.
- Auth/data: `AuthResult`, `PublicUser`, `UserDataEntry`, `UserDataPayload`, `PlayerDataPayload`, `LeaderboardEntry`, `LeaderboardResult`, `UserDataWriteResult`, `UserDataOp`, `UserDataOpResult`, `VersionConflict`, `VersionConflictState`.
- Game server: `GameServerClientOptions`, `GameServerHello`, `GameServerInfo`, `GameServerPlayer`, `AssignInfo`, `AssignmentDecision`, `GameServerLobbyUpdate`, `GameServerLobbyClosed`, `GameServerPlayerJoined`, `GameServerPlayerLeft`, `GameServerPlayerPresence`, `PlayerAction`, `GameServerDataEntry`.
- Account/blocks: `BlockedUserInfo`, `AccountExport`, `AccountProfile`, `ExportedUserData`.
- Relay/game: `RelayMessage`, `RelayBinaryMessage`, `GameStartingData`, `PlayerKickedData`.
- Join requests: `JoinRequestReceivedData`, `JoinRequestPendingData`, `JoinRequestAcceptedData`, `JoinRequestRejectedData`, `JoinRequestWithdrawnData`, `JoinRequestInfo`, `JoinRequestsResult`.
- Social: `FriendInfo`, `FriendRequestInfo`, `FriendRequestsResult`, `FriendRequestAccepted`, `FriendRequestDeclined`, `FriendPresence`, `SocialSettings`, `SocialSnapshot`, `HubNotification`, `NotificationBacklog`, `NotificationCounts`, `NotificationListResult`, `NotificationMarkResult`, `DirectMessage`, `DmConversation`, `DmConversationUnread`, `DmHistoryResult`, `DmReadState`, `DmUnreadResult`, `DmDeliveredData`, `DmReadData`, `DmTypingData`, `LobbyInvite`, `LobbyInviteCancelledData`, `LobbyInviteDeclinedData`, `FriendLobbyInfo`, `JoinFriendResult`.
- Errors: `EthernalException` (`Code`, `Error`, `RetryAfterMs`, `ErrorData`, `Conflict`), `HubErrorPayload`.

## Tests

`csharp-sdk/EthernalCosmos.Client.Tests` runs the SDK against a real hub process (`node server/dist/index.js`), so build the hub first:

```bash
npm ci && npm run build
dotnet test csharp-sdk
```

`GameServerTests` start sample game servers (`GameServerClient`) against the hub, issue keys with `ADMIN_TOKEN=admin-test` and cover two simultaneous lobbies, data authorization, drain, resume and the `ServerRebound` takeover. A meta-test fails when a public `EthernalClient` or `GameServerClient` member is neither exercised by the tests nor mentioned in this document.
