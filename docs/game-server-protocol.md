# Game-server protocol (`/gameserver` namespace)

A **game server** is a service that runs the authoritative game logic for lobbies of one game. It is not a lobby participant:
one server serves N lobbies, a lobby has 0..1 server. Whether a game uses servers is the registry attribute
[`serverSupport`](enums.md#serversupport) (`none` | `optional` | `required`). Enum values used below are listed in [enums.md](enums.md).
Game-server SDKs are planned (issue #58); until then connect with plain `socket.io-client`.

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
`lobby:kick { lobbyId, userId }`, `lobby:setState { lobbyId, state: 'in_progress' | 'closed' }`, `lobby:setSettings { lobbyId, settings }`,
`lobby:gameOver { lobbyId, result? }`, `lobby:close { lobbyId }`, `server:status { draining?, capacity? }`.

## Failure behaviour

| Situation | What happens |
|---|---|
| Server connection drops | Lobby `serverStatus` becomes `lost` (`lobbyUpdated` reason `server_lost`); `gameAction` fails with `SERVER_UNAVAILABLE`. |
| Server returns within the grace | `resumed: true`, `server_resumed`, `serverStatus` `ok`. |
| Grace expires | The hub tries to rebind each lobby (`lobby:assigned` with `reason: server_rebound`). No taker: `required` closes the lobby with `gameCrashed` (`code: null`); `optional` continues serverless (`server` cleared, `server_lost`). |
| Server sets `draining` | No new lobbies; existing lobbies keep running (`serverStatus` `draining`, reason `server_draining`). |
