# C# SDK — `EthernalCosmos.Client`

.NET 8 client for Ethernal Cosmos. Wraps the Hub's REST API and socket.io connection into a strongly-typed, async/await interface using C# events.

---

## Installation

Add a project reference to `EthernalCosmos.Client` from the monorepo:

```xml
<ProjectReference Include="..\csharp-sdk\EthernalCosmos.Client\EthernalCosmos.Client.csproj" />
```

**NuGet dependencies** (already declared in the project):
- `SocketIOClient` — socket.io transport
- `System.Text.Json` — JSON serialisation (built into .NET 8)

---

## Quick Start

```csharp
using EthernalCosmos.Client;
using EthernalCosmos.Client.Models;

var client = new EthernalClient(new EthernalClientOptions
{
    ServerUrl = "https://mea-sama.duckdns.org:12346"
});

await client.LoginAsync("my-bot", "password123");

client.Connected     += () => Console.WriteLine("Connected");
client.LobbyUpdated  += lobby => Console.WriteLine($"Lobby: {lobby.Name}");

var lobby = await client.CreateLobbyAsync("chess", "Fast game");
Console.WriteLine($"Invite code: {lobby.InviteCode}");

await client.DisposeAsync();
```

---

## Types

### `EthernalClientOptions`

```csharp
public sealed class EthernalClientOptions
{
    public required string   ServerUrl      { get; init; }  // No trailing slash
    public          TimeSpan RequestTimeout { get; init; }  // Default: 5 seconds
}
```

### `AuthResult`

```csharp
public sealed class AuthResult
{
    public PublicUser User         { get; init; }  // { UserId, Username }
    public string     AccessToken  { get; init; }  // JWT, expires in 1h
    public string     RefreshToken { get; init; }  // Opaque, expires in 30d
}
```

### `Lobby`

```csharp
public sealed class Lobby
{
    public string        Id         { get; init; }
    public string        GameId     { get; init; }
    public string        Name       { get; init; }
    public string        HostId     { get; init; }
    public LobbyPlayer[] Players    { get; init; }  // { UserId, Username, IsHost }
    public int           MaxPlayers { get; init; }
    public string        Status     { get; init; }  // "open" | "full" | "closed"
    public bool          IsPrivate  { get; init; }
    public bool          Hosted     { get; init; }  // true = server-managed game; false = external app
    public string?       InviteCode { get; init; }  // 6-char, e.g. "A1B2C3"; only set when IsPrivate=true
    public Dictionary<string, object?> Settings { get; init; }  // game-defined config (see CreateLobbyAsync)
    public long          CreatedAt  { get; init; }  // Unix ms timestamp
}
```

### `DataVisibility`

```csharp
public enum DataVisibility { Private, Lobby, Public }
```

| Value | Readable by |
|-------|-------------|
| `Private` | Owner only |
| `Lobby` | Players in the same lobby |
| `Public` | Anyone (also used for leaderboards) |

### `UserDataEntry`

```csharp
public sealed class UserDataEntry
{
    public string  Key        { get; init; }
    public object? Value      { get; init; }  // JSON value, cast as needed
    public string  Visibility { get; init; }  // "private" | "lobby" | "public"
    public long    UpdatedAt  { get; init; }  // Unix ms timestamp
}
```

### `PresenceUser`

Represents a currently connected user.

```csharp
public sealed class PresenceUser
{
    public string  UserId      { get; init; }  // UUID
    public string  Username    { get; init; }
    public string? LobbyId     { get; init; }  // Set if the user is currently in a lobby
    public string? GameId      { get; init; }  // Set if the user is in a game; matches a registered gameId
    /// <summary>
    /// Set only when LobbyId is present.
    /// "open"   = lobby is joinable (still has free slots)
    /// "full"   = max players reached, no new joins possible
    /// "closed" = game has ended or the host closed the lobby
    /// </summary>
    public string? LobbyStatus { get; init; }
}
```

### `LeaderboardEntry`

```csharp
public sealed class LeaderboardEntry
{
    public string  Key        { get; init; }
    public object? Value      { get; init; }
    public string  Visibility { get; init; }
    public long    UpdatedAt  { get; init; }
}
```

### `RelayMessage`

```csharp
public sealed class RelayMessage
{
    public string  From    { get; init; }   // userId of sender
    public string  Type    { get; init; }
    public object? Payload { get; init; }
}
```

---

## Constructor

```csharp
var client = new EthernalClient(new EthernalClientOptions { ServerUrl = "..." });
```

`EthernalClient` implements `IAsyncDisposable`. Always dispose when done to disconnect the socket cleanly.

---

## Auth Methods

### `RegisterAsync`

```csharp
Task<AuthResult> RegisterAsync(string username, string password, CancellationToken ct = default)
```

Creates a new account and connects the socket.

**Constraints**
- `username`: 3–32 chars, only `[a-zA-Z0-9_-]`
- `password`: 8–128 chars

---

### `LoginAsync`

```csharp
Task<AuthResult> LoginAsync(string username, string password, CancellationToken ct = default)
```

Authenticates and connects the socket.

---

### `LogoutAsync`

```csharp
Task LogoutAsync(CancellationToken ct = default)
```

Revokes the refresh token and disconnects the socket. Best-effort — does not throw on network errors.

---

## Lobby Methods

### `CreateLobbyAsync`

```csharp
Task<Lobby> CreateLobbyAsync(
    string gameId,
    string name,
    bool isPrivate = false,
    Dictionary<string, object?>? settings = null,
    CancellationToken ct = default)
```

Creates a new lobby. The caller becomes the host. Resolves once the server confirms.

**Parameters**

| Parameter | Description |
|-----------|-------------|
| `gameId` | Must match a game registered on the server (in `game.registry.ts` or `external-games.ts`). Unknown IDs are rejected with a `ServerError` event. |
| `name` | Display name shown in the lobby list to other players. |
| `isPrivate` | If `true`, the lobby is hidden from `ListLobbiesAsync` and can only be joined via `InviteCode`. |
| `settings` | Arbitrary key-value config defined by your game. The Hub does **not** validate or interpret this — it stores it on the lobby and makes it available to all players via `lobby.Settings`. For server-hosted games it is also forwarded to the subprocess as the `LOBBY_SETTINGS` environment variable. Pass `null` for defaults. |

---

### `JoinLobbyAsync`

```csharp
Task<Lobby> JoinLobbyAsync(string lobbyId, CancellationToken ct = default)
```

Joins an existing lobby by UUID.

---

### `JoinLobbyByCodeAsync`

```csharp
Task<Lobby> JoinLobbyByCodeAsync(string code, CancellationToken ct = default)
```

Joins a private lobby using its 6-character invite code.

---

### `LeaveLobbyAsync`

```csharp
Task LeaveLobbyAsync()
```

Leaves the current lobby.

---

### `ListLobbiesAsync`

```csharp
Task<Lobby[]> ListLobbiesAsync(string gameId, CancellationToken ct = default)
```

Returns all open lobbies for a game.

---

### `GetLobbyInfoAsync`

```csharp
Task<Lobby> GetLobbyInfoAsync(CancellationToken ct = default)
```

Returns a snapshot of the current lobby state.

---

### `KickPlayerAsync` _(host only)_

```csharp
Task KickPlayerAsync(string playerId)
```

---

### `TransferHostAsync` _(host only)_

```csharp
Task TransferHostAsync(string playerId)
```

---

## Relay Methods

### `SendToLobbyAsync`

```csharp
Task SendToLobbyAsync(string type, object? payload = null)
```

Broadcasts a message to all other players in the lobby. Recipients receive the `Message` event.

**Parameters**

| Parameter | Description |
|-----------|-------------|
| `type` | An arbitrary string that categorises the message — completely defined by your game (e.g. `"move"`, `"chat"`, `"state-update"`). The Hub relays it unchanged. Receivers switch on this string to handle different message kinds. |
| `payload` | Any JSON-serialisable value. Shape is fully up to your game. |

---

### `SendToPlayerAsync`

```csharp
Task SendToPlayerAsync(string playerId, string type, object? payload = null)
```

Sends a direct message to one player. Recipient receives the `Message` event.

`Type` and `Payload` follow the same conventions as `SendToLobbyAsync` — arbitrary strings and JSON values defined by your game.

---

### `SendGameActionAsync`

```csharp
Task SendGameActionAsync(string type, object? payload = null)
```

Forwards a game action to the running game subprocess. Only relevant if the game's registry entry has an `entryScript` (i.e. `lobby.Hosted == true` and a server process manages game logic). For relay-only games (external apps or hosted games without a subprocess) this event is silently ignored — use `SendToLobbyAsync` instead.

---

## User Data — Socket Methods

### `GetUserDataAsync`

```csharp
Task<UserDataEntry[]> GetUserDataAsync(string gameId, CancellationToken ct = default)
```

Returns all own KV entries for a game.

---

### `GetPlayerDataAsync`

```csharp
Task<UserDataEntry[]> GetPlayerDataAsync(string playerId, string gameId, CancellationToken ct = default)
```

Returns visible KV entries for another user (`public` always; `lobby` if in same lobby).

---

## Presence Methods

### `ListPresenceAsync`

```csharp
Task<PresenceUser[]> ListPresenceAsync(CancellationToken ct = default)
```

Returns all currently connected users with their presence state. This is a one-shot request — the server sends the full list once and the Task resolves.

For live updates, subscribe to `PresenceJoined` and `PresenceLeft` instead — those fire automatically without polling.

---

## User Data — REST Methods

### `SetKeyAsync`

```csharp
Task SetKeyAsync(
    string gameId,
    string key,
    object? value,
    DataVisibility? visibility = null,
    CancellationToken ct = default)
```

Creates or updates a single KV entry.

**`visibility` — when to use which value**

| Value | Readable by | Typical use |
|-------|-------------|-------------|
| `Private` | Owner only | Personal progress, inventory, settings |
| `Lobby` | Players in the same active lobby | Current match score, draft picks — visible to opponents during play but not to the public |
| `Public` | Anyone | Cumulative stats like wins, rank, elo — these keys also appear in leaderboards |

Passing `null` for `visibility` defaults to `Private`.

---

### `DeleteKeyAsync`

```csharp
Task DeleteKeyAsync(string gameId, string key, CancellationToken ct = default)
```

Deletes a single KV entry.

---

### `BulkSetAsync`

```csharp
Task BulkSetAsync(
    string gameId,
    IEnumerable<(string Key, object? Value, DataVisibility? Visibility)> entries,
    CancellationToken ct = default)
```

Sets multiple keys in one request. Max **100 entries** per call.

**Example**

```csharp
await client.BulkSetAsync("chess", [
    ("wins",   42,   DataVisibility.Public),
    ("losses", 3,    DataVisibility.Public),
    ("draws",  null, null),               // null visibility uses server default (private)
]);
```

---

### `GetAllDataAsync`

```csharp
Task<UserDataEntry[]> GetAllDataAsync(string gameId, CancellationToken ct = default)
```

Returns all own KV entries for a game via REST.

---

### `GetLeaderboardAsync`

```csharp
Task<LeaderboardEntry[]> GetLeaderboardAsync(
    string gameId,
    string key,
    string order = "desc",
    int    limit = 10,
    CancellationToken ct = default)
```

Returns the ranked leaderboard for a key. Only keys stored with `DataVisibility.Public` **and** a numeric value are eligible. Querying a key that doesn't exist or isn't public returns an empty array.

**Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `order` | `string` | `"desc"` | `"desc"` = highest first, `"asc"` = lowest first |
| `limit` | `int` | `10` | Max rows (max: 100) |

---

## Events

Subscribe to events before calling `LoginAsync` / `RegisterAsync` to avoid missing the initial `Connected` event.

### Lifecycle

| Event | Delegate | Description |
|-------|----------|-------------|
| `Connected` | `Action` | Socket connected |
| `Disconnected` | `Action<string>` | Socket disconnected; `string` = reason |
| `AuthError` | `Action<string>` | Token refresh failed or socket rejected; `string` = message |
| `ServerError` | `Action<string>` | Server-side error message |

### Lobby

| Event | Delegate | Description |
|-------|----------|-------------|
| `LobbyCreated` | `Action<Lobby>` | Confirmation after `CreateLobbyAsync` |
| `LobbyUpdated` | `Action<Lobby>` | A player joined/left |
| `LobbyList` | `Action<Lobby[]>` | Response to `ListLobbiesAsync` |
| `LobbyInfo` | `Action<Lobby>` | Response to `GetLobbyInfoAsync` |
| `PlayerKicked` | `Action<PlayerKickedData>` | You were removed from the lobby |

### Game

| Event | Delegate | Description |
|-------|----------|-------------|
| `GameStarting` | `Action<GameStartingData>` | Game subprocess is starting; payload: `{ LobbyId, GameId }` |
| `GameState` | `Action<JsonElement>` | Full game state from subprocess (shape is game-specific) |
| `GameEvent` | `Action<JsonElement>` | Single game event from subprocess |
| `GameOver` | `Action<JsonElement>` | Game session ended |

### Relay & Data

| Event | Delegate | Description |
|-------|----------|-------------|
| `Message` | `Action<RelayMessage>` | Message from another player; `{ From, Type, Payload }` |
| `UserData` | `Action<UserDataPayload>` | Response to `GetUserDataAsync`; `{ GameId, Entries }` |
| `PlayerData` | `Action<PlayerDataPayload>` | Response to `GetPlayerDataAsync`; `{ PlayerId, GameId, Entries }` |

### Presence

All presence events are emitted to **all connected clients** — not scoped to a lobby. They fire automatically; no polling needed.

| Event | Delegate | Description |
|-------|----------|-------------|
| `PresenceJoined` | `Action<PresenceUser>` | A user connected **or** their presence state changed (e.g. joined/left a lobby, game started/ended). Re-fires with the full updated `PresenceUser` object every time something changes, so you can upsert by `UserId`. |
| `PresenceLeft` | `Action<string>` | A user disconnected. Argument is the `userId`. Remove them from your local presence list. |
| `PresenceList` | `Action<PresenceUser[]>` | Response to `ListPresenceAsync`. Full snapshot of all online users at that moment. |

---

## Lifecycle Example

```csharp
await using var client = new EthernalClient(new EthernalClientOptions
{
    ServerUrl = "https://mea-sama.duckdns.org:12346",
});

// Subscribe before login
client.Connected    += () => Console.WriteLine("Connected to Hub");
client.AuthError    += msg => Console.Error.WriteLine($"Auth error: {msg}");
client.LobbyUpdated += lobby =>
{
    Console.WriteLine($"Players: {lobby.Players.Length}/{lobby.MaxPlayers}");
    if (lobby.Players.Length == 2) StartGame(lobby);
};
client.Message += msg =>
{
    if (msg.Type == "move") HandleMove(msg.Payload);
};

await client.LoginAsync("game-bot", "hunter2");

var lobby = await client.CreateLobbyAsync(
    gameId:    "chess",
    name:      "Bot game",
    isPrivate: false,
    settings:  new()
);

Console.WriteLine($"Waiting for opponent… code: {lobby.InviteCode}");
```

---

## Notes

- `Value` fields on `UserDataEntry` and `LeaderboardEntry` are typed as `object?` and backed by `System.Text.Json.JsonElement`. Cast using `((JsonElement)entry.Value).GetInt32()`, `.GetString()`, etc.
- The socket automatically attempts reconnection on disconnect.
- Token refresh on `INVALID_TOKEN` is **not** automatically implemented in the C# SDK — handle the `AuthError` event and call `LoginAsync` again if needed.
