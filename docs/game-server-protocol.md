# Game-server protocol (`/gameserver` namespace)

A **game server** is a service that runs the authoritative game logic for lobbies of one game. It is not a lobby participant:
one server serves N lobbies, a lobby has 0..1 server. Whether a game uses servers is the registry attribute
[`serverSupport`](enums.md#serversupport) (`none` | `optional` | `required`). Enum values used below are listed in [enums.md](enums.md).
Both SDKs ship `GameServerClient` (Node.js: [Using `GameServerClient`](#using-gameserverclient); C#: [Using GameServerClient (C#)](#using-gameserverclient-c)); the protocol below is what it speaks, for other languages use plain `socket.io-client`.

## Connecting

Per-game keys are issued with the admin API (`ADMIN_TOKEN` must be set on the hub):
`POST /admin/game-servers/:gameId/keys`, `GET /admin/game-servers/:gameId/keys`, `DELETE /admin/game-servers/keys/:id`
(`Authorization: Bearer <ADMIN_TOKEN>`; the key `esk_...` is shown only once, the hub stores a hash).

```ts
io(`${hubUrl}/gameserver`, { auth: { serverKey, gameId, serverId, region: 'eu', capacity: 20, version: '1.4.0' } });
```

`connect_error.message` is an [`ErrorCode`](enums.md#errorcode): `INVALID_INPUT`, `UNKNOWN_GAME`, `GAME_SERVER_NOT_ALLOWED` (game has `serverSupport: none`),
`INVALID_SERVER_KEY`. The hub answers with `hello { serverId, gameId, resumed, lobbies }`. Reconnecting with the same `serverId` within
`SERVER_RESUME_GRACE_MS` (default 30 s) **resumes** the server: `resumed: true` and `lobbies` lists the lobbies it still owns.
A second connection with the same `serverId` replaces the older one.

## Hub → server events

| Event | Payload | Notes |
|---|---|---|
| `lobby:assigned` | `{ lobby, players, reason, previousServerId?, lostAt? }` + ack `{ accept, reason? }` | see below |
| `lobby:updated` | `{ lobby, reason? }` | `reason` is a [`LobbyChangeReason`](enums.md#lobbychangereason) |
| `lobby:closed` | `{ lobbyId, reason }` | [`LobbyClosedReason`](enums.md#lobbyclosedreason) |
| `player:joined` / `player:disconnected` / `player:reconnected` | `{ lobbyId, userId, username? }` | |
| `player:left` | `{ lobbyId, userId, reason }` | [`PlayerLeftReason`](enums.md#playerleftreason) |
| `player:action` | `{ lobbyId, userId, type, payload }` | forwarded `gameAction` of a player |

### `lobby:assigned`: fresh lobby vs. takeover

The hub asks a server to accept a lobby and waits `SERVER_ASSIGN_TIMEOUT_MS` (default 5 s) for the ack. The
[`reason`](enums.md#lobbyassignreason) tells the server what kind of request it is:

- **`new_lobby`**: the lobby was just created: empty game state, `lobby.status` is `open`. Initialise normally.
- **`server_rebound`**: **takeover of a lobby whose previous server was lost** (the players saw `lobbyUpdated` with reason `server_lost`,
  and they do **not** receive `gameCrashed`). The lobby already exists with its players, settings and status (possibly `in_progress`);
  `previousServerId` and `lostAt` (unix ms) identify the lost server. The hub holds no game state: restore it from your own storage using
  `lobby.id` (or restart the round and send a fresh `lobby:state`). Players keep their lobby; check `lobby.players[].connected` for who is currently away.

Reject with `ack({ accept: false, reason })` (e.g. at capacity); the hub then tries the next candidate. When all reject (or time out):
`required` games fail `createLobby` with `LOBBY_START_FAILED`, a rebound `required` lobby is closed with `gameCrashed`,
an `optional` lobby continues without a server. On accept the members receive `lobbyUpdated` with reason `server_rebound`.

Candidate order: connected, not draining, below capacity; the requested region first, then lowest load.

## Server → hub events (all acked)

Each event is authorised per lobby: a server may only act on lobbies assigned to it (otherwise `NOT_LOBBY_SERVER`).

`lobby:relay { lobbyId, toUserId?, type, payload? }` (sender `server`, gets `seq`), `lobby:state { lobbyId, toUserId?, state }` (members get `gameState`),
`lobby:kick { lobbyId, userId, reason? }` (`reason` ≤ 200 chars, delivered in `playerKicked`), `lobby:setState { lobbyId, state: 'in_progress' | 'closed' }`, `lobby:setSettings { lobbyId, settings }`,
`lobby:gameOver { lobbyId, result? }`, `lobby:close { lobbyId }`, `server:status { draining?, capacity? }`.

## Player data (server-authoritative)

Game servers write per-player data over the socket; clients can only write their own `private`/`lobby`/`friends` data.
Every event is acked; `userId` must be a (current or former) member of a lobby bound to this server, up to 60 s after that
lobby closed (match results after leaving or closing). Anything else fails with `NOT_ALLOWED`. Writes are audited (`user_data.written_by` = `serverId`).

| Event | Payload | Ack |
|---|---|---|
| `data:set` | `{ lobbyId, userId, key, value, visibility?, writeScope? }` | `{ ok }` |
| `data:bulk` | `{ lobbyId, userId, entries: [{ key, value, visibility?, writeScope? }] }` (1–100, all-or-nothing) | `{ ok }` |
| `data:get` | `{ lobbyId, userId }` | `{ ok, entries: UserDataEntry[] }` |
| `data:increment` | `{ lobbyId, userId, key, by, visibility?, writeScope? }` | `{ ok, key, value, version }` |
| `data:setIf` | `{ lobbyId, userId, key, value, expectedVersion, visibility?, writeScope? }` | `{ ok, key, value, version }` or error `VERSION_CONFLICT` with `error.data.current` |
| `data:transact` | `{ lobbyId, userId, ops: [set\|increment\|setIf\|delete] }` (1–100, all-or-nothing) | `{ ok, results: [{ key, value?, version }] }` |


Subprocess games use the same operations over IPC: `INCREMENT_USER_DATA {requestId,userId,gameId,key,by}`, `SET_USER_DATA_IF {…,key,value,expectedVersion}`, `TRANSACT_USER_DATA {…,ops}` (participants only); the hub answers with `USER_DATA_OP_RESPONSE {requestId, ok, results | error:{code,message,data?}}`.

`visibility: 'public'` marks a **leaderboard/result key**: only a game server can set it (clients get `NOT_ALLOWED`), it always implies
`writeScope: 'server'` (clients cannot overwrite or delete it) and games with `serverSupport: none` cannot use it (`NOT_ALLOWED`).
Without `visibility` the existing visibility is kept (new keys: `private`). Limits are the same as for clients
(16 KiB per value, 200 keys / 512 KiB per user and game: `DATA_VALUE_TOO_LARGE`, `DATA_QUOTA_EXCEEDED`).

## Failure behaviour

| Situation | What happens |
|---|---|
| Server connection drops | Lobby `serverStatus` becomes `lost` (`lobbyUpdated` reason `server_lost`); `gameAction` fails with `SERVER_UNAVAILABLE`. |
| Server returns within the grace | `resumed: true`, `server_resumed`, `serverStatus` `ok`. |
| Grace expires | The hub tries to rebind each lobby (`lobby:assigned` with `reason: server_rebound`). No taker: `required` closes the lobby with `gameCrashed` (`code: null`); `optional` continues serverless (`server` cleared, `server_lost`). |
| Server sets `draining` | No new lobbies; existing lobbies keep running (`serverStatus` `draining`, reason `server_draining`). |

## Using `GameServerClient`

The Node.js SDK wraps this protocol (full reference: [sdk-nodejs.md](sdk-nodejs.md#gameserverclient-game-server-sdk)):

```ts
const gs = new GameServerClient({ serverUrl, serverKey, gameId: 'chess', serverId: 'eu-1', capacity: 20, region: 'eu',
  onAssign: ({ lobby, reason, previousServerId, lostAt }) => true });   // reason: new_lobby | server_rebound
gs.on('player:action', ({ lobbyId, userId, type, payload }) => gs.sendState(lobbyId, step(lobbyId, userId, type, payload)));
await gs.connect();                                                      // hello { resumed, lobbies }
await gs.incrementUserData(lobbyId, userId, 'wins', 1, { visibility: 'public' });
await gs.kickPlayer(lobbyId, userId, 'cheating');
await gs.drain();
```

It maps `lobby:assigned` acks to `onAssign`, `lobby:relay/state/kick/setState/setSettings/gameOver/close` to `sendToLobby`/`sendToPlayer`/`sendState`/`kickPlayer`/`setLobbyState`/`setLobbySettings`/`gameOver`/`closeLobby`, `server:status` to `updateStatus`/`drain`/`heartbeat`, and the `data:*` events to `setUserData`/`bulkSetUserData`/`getUserData`/`incrementUserData`/`setUserDataIf`/`transactUserData`. Reconnecting with the same `serverId` resumes automatically.

## Using GameServerClient (C#)

The C# SDK wraps this protocol in `GameServerClient` (details: [sdk-csharp.md](sdk-csharp.md#gameserverclient)).

```csharp
await using var server = new GameServerClient(new GameServerClientOptions
{
    ServerUrl = "http://localhost:12346", ServerKey = "esk_...", GameId = "chess", ServerId = "chess-eu-1", Capacity = 20,
});
server.LobbyAssigned += a => Console.WriteLine($"{a.Lobby.Id}: {a.Reason}"); // NewLobby or ServerRebound (PreviousServerId, LostAt)
await server.ConnectAsync();                                                 // resumes within the grace period

await server.SetDataAsync(lobbyId, userId, "rank.points", 1200);           // members only, else NOT_ALLOWED
await server.RelayToLobbyAsync(lobbyId, "round", new { n = 1 });
await server.DrainAsync();                                                   // no new lobbies; existing ones keep running
```
