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
| `KickPlayerAsync(playerId)` | Host only. The kicked player gets `PlayerKicked`. |
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
| `GetPlayerDataAsync(playerId, gameId)` | Entries of another player in your lobby that you may see (`lobby`/`public` visibility). |
| `SetUserDataAsync(gameId, key, value, visibility?)` | Write one key. |
| `BulkSetUserDataAsync(gameId, entries)` | `IEnumerable<(string Key, object? Value, DataVisibility? Visibility)>`. |
| `DeleteUserDataAsync(gameId, key)` | Idempotent delete. |

REST (same data):

| Method | Description |
|--------|-------------|
| `SetKeyAsync(gameId, key, value, visibility?)` | Set or update one key. |
| `DeleteKeyAsync(gameId, key)` | Delete a key. |
| `BulkSetAsync(gameId, entries)` | Up to 100 entries per call. |
| `GetAllDataAsync(gameId)` | All own entries. |
| `GetLeaderboardAsync(gameId, key, order = "desc", limit = 10)` | Public numeric leaderboard (`LeaderboardEntry[]`). |

`DataVisibility`: `Private`, `Lobby`, `Public`. `UserDataEntry` also reports `WriteScope` (`Client`, `Server` — server-written keys cannot be changed by clients) and `Version`. `Value` is `object?` backed by `JsonElement`: `((JsonElement)entry.Value!).GetInt32()`. Events `UserData` (`UserDataPayload`) and `PlayerData` (`PlayerDataPayload`) deliver pushed data.

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
- Auth/data: `AuthResult`, `PublicUser`, `UserDataEntry`, `UserDataPayload`, `PlayerDataPayload`, `LeaderboardEntry`.
- Relay/game: `RelayMessage`, `RelayBinaryMessage`, `GameStartingData`, `PlayerKickedData`.
- Join requests: `JoinRequestReceivedData`, `JoinRequestPendingData`, `JoinRequestAcceptedData`, `JoinRequestRejectedData`, `JoinRequestWithdrawnData`, `JoinRequestInfo`, `JoinRequestsResult`.
- Social: `FriendInfo`, `FriendRequestInfo`, `FriendRequestsResult`, `FriendRequestAccepted`, `FriendRequestDeclined`, `FriendPresence`, `SocialSettings`, `SocialSnapshot`, `HubNotification`, `NotificationBacklog`, `NotificationCounts`, `NotificationListResult`, `NotificationMarkResult`, `DirectMessage`, `DmConversation`, `DmConversationUnread`, `DmHistoryResult`, `DmReadState`, `DmUnreadResult`, `DmDeliveredData`, `DmReadData`, `DmTypingData`, `LobbyInvite`, `LobbyInviteCancelledData`, `LobbyInviteDeclinedData`, `FriendLobbyInfo`, `JoinFriendResult`.
- Errors: `EthernalException`, `HubErrorPayload`.

## Tests

`csharp-sdk/EthernalCosmos.Client.Tests` runs the SDK against a real hub process (`node server/dist/index.js`), so build the hub first:

```bash
npm ci && npm run build
dotnet test csharp-sdk
```

A meta-test fails when a public `EthernalClient` member is neither exercised by the tests nor mentioned in this document.
