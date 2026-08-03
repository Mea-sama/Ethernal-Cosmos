# Node.js SDK — `@ethernal/client`

TypeScript SDK for Node.js game servers. Wraps the Hub's REST API and socket.io connection into a typed, promise-based interface.

---

## Installation

```sh
npm install @ethernal/client
```

The package is part of the Ethernal Cosmos npm workspace monorepo (`sdk/`). For external projects, install from the local path or publish to a registry first.

---

## Quick Start

```ts
import { EthernalClient } from '@ethernal/client';

const client = new EthernalClient({ serverUrl: 'https://mea-sama.duckdns.org:12346' });

await client.login('my-bot', 'password123');

client.on('connected', () => console.log('Socket connected'));
client.on('lobbyCreated', (lobby) => console.log('Lobby ready:', lobby.id));

const lobby = await client.createLobby({ gameId: 'chess', name: 'Fast game' });
```

---

## Types

### `EthernalClientOptions`

Constructor options.

```ts
interface EthernalClientOptions {
  /** Full URL of the Hub server. No trailing slash. */
  serverUrl: string;

  /**
   * Timeout in milliseconds for socket request/response pairs.
   * @default 5000
   */
  requestTimeout?: number;
}
```

### `AuthResult`

Returned by `login()` and `register()`.

```ts
interface AuthResult {
  accessToken:  string;   // JWT, expires in 1h
  refreshToken: string;   // Opaque token, expires in 30d
  user: {
    id:       string;     // UUID
    username: string;
  };
}
```

### `Lobby`

```ts
interface Lobby {
  id:          string;                        // UUID
  gameId:      string;                        // Registered game identifier
  name:        string;                        // Display name
  hosted:      boolean;                       // true = server-managed game; false = external app
  status:      'open' | 'full' | 'closed';    // 'open' = joinable; 'full' = max players reached; 'closed' = game ended
  isPrivate:   boolean;
  inviteCode:  string | undefined;            // 6-char alphanumeric; only present when isPrivate=true
  hostId:      string;                        // userId of the host
  players:     Array<{ id: string; username: string }>;
  maxPlayers:  number;                        // Enforced by the server from the game registry; client cannot override
  settings:    Record<string, unknown>;       // Game-defined config (see createLobby)
  createdAt:   string;                        // ISO 8601 timestamp
}
```

### `UserDataEntry`

```ts
interface UserDataEntry {
  gameId:     string;
  key:        string;
  value:      unknown;        // Any JSON-serialisable value
  visibility: DataVisibility;
  updatedAt:  string;         // ISO 8601 timestamp
}
```

### `DataVisibility`

```ts
type DataVisibility = 'private' | 'lobby' | 'public';
```

| Value | Readable by |
|-------|-------------|
| `'private'` | Owner only |
| `'lobby'` | Players in the same lobby |
| `'public'` | Anyone (also used for leaderboards) |

### `LeaderboardEntry`

```ts
interface LeaderboardEntry {
  userId:   string;
  username: string;
  value:    number;   // Numeric value of the key
  rank:     number;   // 1-based rank position
}
```

### `PresenceUser`

```ts
interface PresenceUser {
  userId:       string;
  username:     string;
  lobbyId?:     string;              // Set if the user is currently in a lobby
  gameId?:      string;              // Set if the user is in a game; matches a registered gameId
  lobbyStatus?: 'open' | 'full' | 'closed';  // Set only when lobbyId is present.
                                             // 'open'   = lobby is joinable
                                             // 'full'   = max players reached, no new joins
                                             // 'closed' = game ended or host closed the lobby
}
```

### `RelayMessage<TPayload = unknown>`

```ts
interface RelayMessage<TPayload = unknown> {
  from:    string;   // userId of sender
  type:    string;
  payload: TPayload;
}
```

### `RelayBinaryMessage`

```ts
interface RelayBinaryMessage {
  from:     string;      // userId of sender
  typeCode: number;      // 0..65535
  payload:  Uint8Array;
}
```

### `BinaryPayload`

```ts
type BinaryPayload = Uint8Array | ArrayBuffer;
```

---

## Constructor

```ts
new EthernalClient(options: EthernalClientOptions)
```

`EthernalClient` extends Node.js `EventEmitter`. Call `login()` or `register()` before using any socket-based methods.

---

## Auth Methods

### `register(username, password)`

```ts
register(username: string, password: string): Promise<AuthResult>
```

Creates a new account and connects the socket.

**Constraints**
- `username`: 3–32 characters, only `[a-zA-Z0-9_-]`
- `password`: 8–128 characters

**Throws** if the username is already taken (HTTP 409) or validation fails (HTTP 400).

---

### `login(username, password)`

```ts
login(username: string, password: string): Promise<AuthResult>
```

Authenticates an existing account and connects the socket.

**Throws** on invalid credentials (HTTP 401).

---

### `logout()`

```ts
logout(): Promise<void>
```

Revokes the refresh token on the server and disconnects the socket. Best-effort — does not throw on network errors.

---

## Lobby Methods

### `createLobby(data)`

```ts
createLobby(data: {
  gameId:     string;
  name:       string;
  isPrivate?: boolean;                  // default: false
  settings?:  Record<string, unknown>;  // game-specific config
}): Promise<Lobby>
```

Creates a new lobby and resolves with the created `Lobby` when the server confirms. The caller becomes the host.

**Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `gameId` | `string` | — | Must match a game registered on the server (in `game.registry.ts` or `external-games.ts`). Unknown IDs are rejected with an error event. |
| `name` | `string` | — | Display name shown to other players in the lobby list. |
| `isPrivate` | `boolean` | `false` | If `true`, the lobby is hidden from `listLobbies` and can only be joined via `inviteCode`. |
| `settings` | `Record<string, unknown>` | `{}` | Arbitrary key-value config defined by your game. The Hub does **not** validate or interpret this object — it stores it on the lobby and makes it available to all players via `lobby.settings`. For server-hosted games it is also passed to the subprocess as the `LOBBY_SETTINGS` environment variable. Use it for things like round limits, difficulty, or game mode. |

---

### `joinLobby(lobbyId)`

```ts
joinLobby(lobbyId: string): Promise<Lobby>
```

Joins an existing lobby by UUID. Resolves with the updated lobby state.

---

### `joinLobbyByCode(code)`

```ts
joinLobbyByCode(code: string): Promise<Lobby>
```

Joins a private lobby using its 6-character invite code. Code is case-insensitive.

---

### `leaveLobby()`

```ts
leaveLobby(): void
```

Leaves the current lobby. Fires-and-forgets (no response awaited).

---

### `listLobbies(gameId)`

```ts
listLobbies(gameId: string): Promise<Lobby[]>
```

Returns all open (non-private) lobbies for the given game.

---

### `getLobbyInfo()`

```ts
getLobbyInfo(): Promise<Lobby>
```

Returns a snapshot of the current lobby state.

---

### `kickPlayer(playerId)` _(host only)_

```ts
kickPlayer(playerId: string): void
```

Removes a player from the lobby. The kicked player receives a `playerKicked` event.

---

### `transferHost(playerId)` _(host only)_

```ts
transferHost(playerId: string): void
```

Transfers the host role to another player in the lobby.

---

## Relay Methods

Used to send messages between players through the Hub. The Hub relays without interpreting the payload.
Incoming relay payloads are already JSON-decoded by Socket.IO, so you usually only need TypeScript typing on the receiver side.

### `sendToLobby(type, payload)`

```ts
sendToLobby(type: string, payload: unknown): void
```

Broadcasts a message to all other players in the lobby. Recipients receive a `message` event.

**Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `type` | `string` | An arbitrary string that categorises the message — completely defined by your game (e.g. `'move'`, `'chat'`, `'state-update'`). The Hub relays it unchanged. Receivers switch on this string to handle different message kinds. |
| `payload` | `unknown` | Any JSON-serialisable value. Shape is fully up to your game. |

---

### `sendToPlayer(playerId, type, payload)`

```ts
sendToPlayer(playerId: string, type: string, payload: unknown): void
```

Sends a message to a single player in the lobby. Recipient receives a `message` event.

`type` and `payload` follow the same conventions as `sendToLobby` — arbitrary strings and JSON values defined by your game.

### `onMessage(listener)`

```ts
onMessage<TPayload = unknown>(listener: (data: RelayMessage<TPayload>) => void): this
```

Convenience helper for the `message` event.

### `onceMessage(listener)`

```ts
onceMessage<TPayload = unknown>(listener: (data: RelayMessage<TPayload>) => void): this
```

Same as `onMessage()`, but only for the next incoming relay message.

---

### `sendToLobbyBinary(typeCode, payload)`

```ts
sendToLobbyBinary(typeCode: number, payload: BinaryPayload): void
```

Broadcasts a binary payload to all other players in the lobby. Recipients receive `messageBinary`.

---

### `sendToPlayerBinary(playerId, typeCode, payload)`

```ts
sendToPlayerBinary(playerId: string, typeCode: number, payload: BinaryPayload): void
```

Sends a binary payload to one player in the lobby. Recipient receives `messageBinary`.

---

### `onBinaryMessage(listener)`

```ts
onBinaryMessage(listener: (data: RelayBinaryMessage) => void): this
```

Convenience helper for the `messageBinary` event.

### `onceBinaryMessage(listener)`

```ts
onceBinaryMessage(listener: (data: RelayBinaryMessage) => void): this
```

Same as `onBinaryMessage()`, but only for the next incoming binary relay message.

---

### `sendGameAction(type, payload)`

```ts
sendGameAction(type: string, payload: unknown): void
```

Forwards a game action to the running game subprocess. Only relevant if the game's registry entry has an `entryScript` (i.e. `lobby.hosted === true` and a server process manages game logic). For relay-only games (external apps or hosted games without a subprocess) this event is silently ignored — use `sendToLobby` instead.

---

## User Data — Socket Methods

### `getUserData(gameId)`

```ts
getUserData(gameId: string): Promise<UserDataEntry[]>
```

Returns all KV entries owned by the current user for the given game.

---

### `getPlayerData(playerId, gameId)`

```ts
getPlayerData(playerId: string, gameId: string): Promise<UserDataEntry[]>
```

Returns visible KV entries for another user. Returns:
- `public` entries always
- `lobby` entries only if both users are currently in the same lobby

---

### `listPresence()`

```ts
listPresence(): Promise<PresenceUser[]>
```

Returns all currently connected users with their presence state. This is a one-shot request — the server sends the full list once and the Promise resolves.

For live updates, subscribe to the `'presence:joined'` and `'presence:left'` events instead. These fire automatically without needing to poll.

---

## User Data — REST Methods

These methods use HTTP and are suitable for bulk operations outside a game session.

### `setKey(gameId, key, value, visibility?)`

```ts
setKey(
  gameId:      string,
  key:         string,
  value:       unknown,
  visibility?: DataVisibility,   // default: 'private'
): Promise<void>
```

Creates or updates a single KV entry.

**Constraints**
- `gameId`: 1–32 chars, `[a-z0-9-]`
- `key`: 1–64 chars, `[a-zA-Z0-9_.-]`
- `value`: any JSON-serialisable value

**`visibility` — when to use which value**

| Value | Readable by | Typical use |
|-------|-------------|-------------|
| `'private'` | Owner only | Personal progress, inventory, settings |
| `'lobby'` | Players in the same active lobby | Current match score, draft picks — visible to opponents during play but not to the public |
| `'public'` | Anyone | Cumulative stats like `wins`, `rank`, `elo` — these keys also appear in leaderboards |

If `visibility` is omitted it defaults to `'private'`.

---

### `deleteKey(gameId, key)`

```ts
deleteKey(gameId: string, key: string): Promise<void>
```

Deletes a single KV entry. No-op (204) if the key does not exist.

---

### `bulkSet(gameId, entries)`

```ts
bulkSet(
  gameId:  string,
  entries: Array<{
    key:         string;
    value:       unknown;
    visibility?: DataVisibility;
  }>,
): Promise<void>
```

Sets multiple keys in one HTTP request. Max **100 entries** per call.

---

### `getAllData(gameId)`

```ts
getAllData(gameId: string): Promise<UserDataEntry[]>
```

Returns all own KV entries for a game via REST (equivalent to `getUserData` via socket).

---

### `getLeaderboard(gameId, key, options?)`

```ts
getLeaderboard(
  gameId:  string,
  key:     string,
  options?: {
    order?: 'asc' | 'desc';   // default: 'desc' (highest first)
    limit?: number;            // default: 10, max: 100
  },
): Promise<LeaderboardEntry[]>
```

Returns the ranked leaderboard for a key. Only keys that were stored with `visibility: 'public'` **and** have a numeric value are eligible. Querying a key that doesn't exist or isn't public returns an empty array.

**Example**

```ts
const top10 = await client.getLeaderboard('chess', 'wins', { limit: 10 });
// [{ userId, username, value: 42, rank: 1 }, ...]
```

---

## EventEmitter Events

`EthernalClient` extends `EventEmitter`. All server→client socket events are forwarded, plus lifecycle events.

### Lifecycle

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | — | Socket connected to the Hub |
| `disconnected` | `reason: string` | Socket disconnected |
| `authError` | `message: string` | Token refresh failed or socket rejected |

### Lobby Events

| Event | Payload | Description |
|-------|---------|-------------|
| `lobbyCreated` | `Lobby` | Confirmation after `createLobby()` |
| `lobbyUpdated` | `Lobby` | A player joined/left; lobby state changed |
| `lobbyList` | `Lobby[]` | Response to `listLobbies()` |
| `lobbyInfo` | `Lobby` | Response to `getLobbyInfo()` |
| `playerKicked` | `{ lobbyId: string }` | You were removed from the lobby |

### Game Events

| Event | Payload | Description |
|-------|---------|-------------|
| `gameStarting` | `{ lobbyId: string; gameId: string }` | Game subprocess is starting |
| `gameState` | `unknown` | Full game state broadcast from subprocess |
| `gameEvent` | `{ type: string; data: unknown }` | Single game event from subprocess |
| `gameOver` | `unknown` | Game session ended, result payload |

### Relay Events

| Event | Payload | Description |
|-------|---------|-------------|
| `message` | `RelayMessage<TPayload = unknown>` | Message from another player via relay. Use `onMessage<T>()` if you want a typed payload on the receiver side. |
| `messageBinary` | `RelayBinaryMessage` | Binary message from another player via relay. Use for packed high-frequency data paths. |

### User Data Events

| Event | Payload | Description |
|-------|---------|-------------|
| `userData` | `{ gameId: string; entries: UserDataEntry[] }` | Response to `getUserData()` |
| `playerData` | `{ playerId: string; gameId: string; entries: UserDataEntry[] }` | Response to `getPlayerData()` |

### Presence Events

| Event | Payload | Description |
|-------|---------|-------------|
| `presence:list` | `PresenceUser[]` | Response to `listPresence()` |
| `presence:joined` | `PresenceUser` | A user connected or changed lobby/game state |
| `presence:left` | `{ userId: string }` | A user disconnected |

**Example**

```ts
client.on('presence:joined', (user) => {
  console.log(`${user.username} is now online`);
});

client.on('lobbyUpdated', (lobby) => {
  if (lobby.players.length === 2) startGame(lobby);
});

client.on('authError', (msg) => {
  console.error('Auth error:', msg);
  process.exit(1);
});
```

---

## Token Refresh

The SDK automatically refreshes the access token when a `connect_error` with message `'INVALID_TOKEN'` is received. The socket reconnects transparently with the new token. If the refresh itself fails, an `'authError'` event is emitted.
