# Socket Events Reference

The Hub uses [socket.io](https://socket.io) over WebSocket. All games (both browser-based and Node.js) communicate via the same socket.

---

## Connection

### URL

```
wss://mea-sama.duckdns.org:12346
```

### Authentication

Pass a Bearer token in the socket.io `auth` option:

```js
// Browser (plain socket.io)
const socket = io('https://mea-sama.duckdns.org:12346', {
  auth: { token: 'Bearer ' + accessToken },
});

// Node.js (via SDK — handled automatically)
await client.login('username', 'password');
// SDK connects internally
```

### Connection Errors

The server emits a `connect_error` with a descriptive `message` string:

| `err.message` | Cause | Action |
|---------------|-------|--------|
| `'UNAUTHENTICATED'` | No `auth.token` provided | Call `login()` first |
| `'INVALID_TOKEN'` | Token expired or malformed | Refresh the token and reconnect |

The Node.js SDK handles `'INVALID_TOKEN'` automatically by refreshing and reconnecting.

---

## Client → Server Events

Events emitted by the game client to the Hub.

### Lobby

#### `createLobby`

```ts
socket.emit('createLobby', {
  gameId:     string;               // Must match a registered game (game.registry.ts or external-games.ts)
  name:       string;               // Display name shown in the lobby list
  isPrivate?: boolean;              // default: false — if true, hidden from listLobbies; join via inviteCode only
  settings?:  Record<string, unknown>;  // Game-defined config. The Hub stores this unchanged and
                                        // makes it available to all players via lobby.settings.
                                        // For server-hosted games it is also passed to the
                                        // subprocess as the LOBBY_SETTINGS env variable.
});
```

Server responds with a `lobbyCreated` event.

---

#### `joinLobby`

```ts
socket.emit('joinLobby', { lobbyId: string });
```

Join an existing lobby by UUID. Server responds with `lobbyUpdated`.

---

#### `joinLobbyByCode`

```ts
socket.emit('joinLobbyByCode', { code: string }); // 6-char alphanumeric
```

Join a private lobby by invite code. Server responds with `lobbyUpdated`.

---

#### `leaveLobby`

```ts
socket.emit('leaveLobby');
```

Leave the current lobby. No response event.

---

#### `listLobbies`

```ts
socket.emit('listLobbies', gameId: string);
```

Request all open lobbies for a game. Server responds with `lobbyList`.

---

#### `getLobbyInfo`

```ts
socket.emit('getLobbyInfo');
```

Request current lobby snapshot. Server responds with `lobbyInfo`.

---

#### `kickPlayer` _(host only)_

```ts
socket.emit('kickPlayer', { playerId: string });
```

---

#### `transferHost` _(host only)_

```ts
socket.emit('transferHost', { playerId: string });
```

---

#### `lockLobby` / `unlockLobby` _(host only)_

```ts
socket.emit('lockLobby');
socket.emit('unlockLobby');
```

While locked, `joinLobby`/`joinLobbyByCode` are rejected with `LOBBY_LOCKED` — other players must use
`requestJoinLobby`/`requestJoinLobbyByCode` instead. Locking never affects players already in the lobby.

---

#### `requestJoinLobby` / `requestJoinLobbyByCode`

```ts
socket.emit('requestJoinLobby', { lobbyId: string });
socket.emit('requestJoinLobbyByCode', { code: string });
```

Requests to join a locked lobby. If the lobby isn't actually locked, this joins immediately (same
as `joinLobby`). If locked, the server acks with `joinRequestPending` and notifies the host via
`joinRequestReceived`. The host then calls `respondJoinRequest`. Unanswered requests are
auto-rejected after ~15 seconds.

---

#### `cancelJoinRequest`

```ts
socket.emit('cancelJoinRequest', { lobbyId: string });
```

Withdraws your own pending request. The host is notified via `joinRequestWithdrawn`.

---

#### `respondJoinRequest` _(host only)_

```ts
socket.emit('respondJoinRequest', { requesterId: string, accept: boolean });
```

Accepts or rejects a pending request. On accept, the server joins the requester server-side and
emits `joinRequestAccepted` (with the updated `Lobby`) directly to them, plus the usual
`lobbyUpdated` to the room. On reject, the requester gets `joinRequestRejected`.

---

### Relay

Relay is split into two lanes:
- JSON lane: `sendToLobby` / `sendToPlayer` -> `message`
- Binary lane: `sendToLobbyBinary` / `sendToPlayerBinary` -> `messageBinary`

Use the binary lane for high-frequency game data (packed state/input frames).

#### `sendToLobby`

```ts
socket.emit('sendToLobby', {
  type:    string;    // Arbitrary message type string, e.g. "move"
  payload: unknown;   // Any JSON-serialisable value
});
```

Broadcasts to all other players in the lobby. Recipients receive a `message` event.

---

#### `sendToPlayer`

```ts
socket.emit('sendToPlayer', {
  playerId: string;
  type:     string;
  payload:  unknown;
});
```

Sends a direct message to one player. Recipient receives a `message` event.

---

#### `sendToLobbyBinary`

```ts
socket.emit('sendToLobbyBinary', {
  typeCode: number;      // Integer 0..65535
  payload:  Uint8Array;  // Binary payload
});
```

Broadcasts binary data to all other players in the lobby. Recipients receive `messageBinary`.

Notes:
- `payload` hard cap is currently 1000 bytes by default (server-side validation, configurable via `server/config/limits.json`).
- For interop, base64 strings are also accepted as payload input and decoded server-side.

---

#### `sendToPlayerBinary`

```ts
socket.emit('sendToPlayerBinary', {
  playerId: string;
  typeCode: number;      // Integer 0..65535
  payload:  Uint8Array;  // Binary payload
});
```

Sends binary data to one player. Recipient receives `messageBinary`.

---

### Game Actions

#### `gameAction`

```ts
socket.emit('gameAction', {
  type:    string;
  payload: unknown;
});
```

Forwards a game action to the running game subprocess. Only used for games that have a subprocess; not needed for relay-only games.

---

### User Data

#### `getUserData`

```ts
socket.emit('getUserData', gameId: string);
```

Request own KV data. Server responds with `userData`.

---

#### `getPlayerData`

```ts
socket.emit('getPlayerData', {
  playerId: string;
  gameId:   string;
});
```

Request another player's visible KV data. Server responds with `playerData`.

---

### Presence

#### `presence:list`

```ts
socket.emit('presence:list');
```

Request all currently online users. Server responds with `presence:list`.

---

## Server → Client Events

Events emitted by the Hub to the game client.

### Lobby Events

#### `lobbyCreated`

```ts
socket.on('lobbyCreated', (lobby: Lobby) => { ... });
```

Emitted to the creating client after `createLobby`. Lobby object:

```ts
{
  id:          string;
  gameId:      string;
  name:        string;
  hosted:      boolean;     // true = server-managed game; false = external app relay-only
  isPrivate:   boolean;
  inviteCode?: string;      // 6-char code, e.g. "A1B2C3"; only present when isPrivate=true
  hostId:      string;
  players:     Array<{ userId: string; username: string; isHost: boolean }>;
  maxPlayers:  number;      // Set by the game registry; client cannot override
  status:      'open' | 'full' | 'closed';
  settings:    Record<string, unknown>;  // Game-defined config passed at creation
  createdAt:   number;      // Unix ms timestamp
}
```

---

#### `lobbyUpdated`

```ts
socket.on('lobbyUpdated', (lobby: Lobby) => { ... });
```

Emitted to all lobby members when someone joins or leaves.

---

#### `lobbyList`

```ts
socket.on('lobbyList', (lobbies: Lobby[]) => { ... });
```

Response to `listLobbies`.

---

#### `lobbyInfo`

```ts
socket.on('lobbyInfo', (lobby: Lobby) => { ... });
```

Response to `getLobbyInfo`.

---

#### `playerKicked`

```ts
socket.on('playerKicked', (data: { lobbyId: string }) => { ... });
```

Emitted to a player who has been kicked by the host.

---

#### `joinRequestReceived` _(to host)_

```ts
socket.on('joinRequestReceived', (data: { lobbyId: string; requesterId: string; username: string }) => { ... });
```

---

#### `joinRequestPending` _(to requester)_

```ts
socket.on('joinRequestPending', (data: { lobbyId: string }) => { ... });
```

Ack confirming the request was sent and is awaiting the host.

---

#### `joinRequestAccepted` _(to requester)_

```ts
socket.on('joinRequestAccepted', (data: { lobby: Lobby }) => { ... });
```

The host accepted — you have already been added to the lobby server-side, no further action needed.

---

#### `joinRequestRejected` _(to requester)_

```ts
socket.on('joinRequestRejected', (data: {
  lobbyId: string;
  reason: 'declined' | 'timeout' | 'host_changed' | 'lobby_closed';
}) => { ... });
```

---

#### `joinRequestWithdrawn` _(to host)_

```ts
socket.on('joinRequestWithdrawn', (data: { requesterId: string; reason: 'cancelled' | 'timeout' }) => { ... });
```

A pending request disappeared before you responded (requester cancelled, or it timed out).

---

### Game Events

#### `gameStarting`

```ts
socket.on('gameStarting', (data: {
  lobbyId: string;
  gameId:  string;
}) => { ... });
```

Emitted to all lobby members when a game subprocess starts.

---

#### `gameState`

```ts
socket.on('gameState', (state: unknown) => { ... });
```

Full game state broadcast from the subprocess after every action. Shape is game-specific.

---

#### `gameEvent`

```ts
socket.on('gameEvent', (event: {
  type: string;
  data: unknown;
}) => { ... });
```

Single discrete event from the subprocess (e.g. "card drawn", "dice rolled").

---

#### `gameOver`

```ts
socket.on('gameOver', (result: unknown) => { ... });
```

Emitted when the game ends. `result` is game-specific.

---

### Relay Events

#### `message`

```ts
socket.on('message', (data: {
  type:    string;
  payload: unknown;
  from:    string;   // userId of sender
}) => { ... });
```

Received when another player sends a relay message via `sendToLobby` or `sendToPlayer`.

---

#### `messageBinary`

```ts
socket.on('messageBinary', (data: {
  typeCode: number;
  payload: Uint8Array;
  from:    string;   // userId of sender
}) => { ... });
```

Received when another player sends a binary relay message via `sendToLobbyBinary` or `sendToPlayerBinary`.

---

### User Data Events

#### `userData`

```ts
socket.on('userData', (data: {
  gameId:  string;
  entries: UserDataEntry[];
}) => { ... });
```

Response to `getUserData`.

---

#### `playerData`

```ts
socket.on('playerData', (data: {
  playerId: string;
  gameId:   string;
  entries:  UserDataEntry[];
}) => { ... });
```

Response to `getPlayerData`.

---

### Presence Events

All presence events are emitted to all connected clients (not lobby-scoped).

#### `presence:list`

```ts
socket.on('presence:list', (users: PresenceUser[]) => { ... });
```

Response to `presence:list` emit. Contains all currently connected users.

```ts
interface PresenceUser {
  userId:       string;
  username:     string;
  lobbyId?:     string;              // Set if the user is currently in a lobby
  gameId?:      string;              // Set if the user is in a game; matches a registered gameId
  lobbyStatus?: 'open' | 'full' | 'closed';  // Set only when lobbyId is present.
                                             // 'open'   = lobby is joinable
                                             // 'full'   = max players reached
                                             // 'closed' = game ended or lobby closed
}
```

The server re-emits `presence:joined` with a fresh `PresenceUser` every time a user's state changes (lobby joined/left, game started/ended). Use `userId` to upsert into your local presence list.

---

#### `presence:joined`

```ts
socket.on('presence:joined', (user: PresenceUser) => { ... });
```

Broadcast to all clients when a user connects **or their presence state changes** — e.g. joining/leaving a lobby, a game starting or ending. Always contains the complete current state of that user. Use `userId` as the key to update your local presence list.

---

#### `presence:left`

```ts
socket.on('presence:left', (data: { userId: string }) => { ... });
```

Broadcast to all clients when a user disconnects. Remove the user with the given `userId` from your local presence list.

The Hub detects disconnects via the socket.io heartbeat (`pingInterval: 2s`, `pingTimeout: 5s`). A hard disconnect (crash, network loss) is detected within approximately 7 seconds.

---

### Error

#### `error`

```ts
socket.on('error', (message: string) => { ... });
```

General error message from the server. Usually indicates a bad request (e.g. joining a full lobby, kicking without being host).
