# Ethernal Cosmos Hub — Server Feature Specification (As-Is)

> **Purpose:** Machine-readable baseline of what the Hub server *actually does today*, to be diffed against desired functionality for future games. Not a design proposal.
> **Basis:** Static reading of `server/src/**`, `shared/src/types/index.ts`, `server/config/limits.json`, `server/public/panel.js`, `games/dudg/server/src/index.ts`. **No runtime verification was performed** for this document (dependencies were not installed). Every statement carries a verification tag (see below).
> **Language note:** Server error strings are German; error *codes* below are the internal `Error.message` values.

## 0. How to use this document (for AI consumers)

- Every capability has a stable ID: `FEAT-<AREA>-<NN>`. Behaviour quirks are `QUIRK-…`, defects `BUG-…`, missing capabilities `GAP-…`, test cases `TEST-…`.
- Status tags: `[OK]` implemented as described · `[QUIRK]` implemented but behaviour is surprising · `[BUG]` contradicts code intent/config · `[GAP]` not supported.
- Verification tags: `{src}` derived from reading source only · `{test:<file>}` covered by an existing script in `test/`.
- To match against requirements: for each required behaviour, grep for the nearest `FEAT-`/`GAP-` ID, then read its "Genre impact" line.
- Areas: `ARCH` architecture, `AUTH`, `PRES` presence, `LOBBY`, `JOIN` (lock/requests), `COMM` (relay), `GAME` (subprocess), `DATA` (user data), `LIMIT` (rate limits), `PANEL`.

---

## 1. Architecture summary (`ARCH`)

| ID | Fact |
|---|---|
| FEAT-ARCH-01 | Node.js + Express + Socket.io 4. Internal bind `127.0.0.1:12348`; TLS terminated by Caddy on `:12346`. `{src}` |
| FEAT-ARCH-02 | **All state except user data and accounts is in-memory** (lobbies, presence, join requests, rate-limit buckets, running game instances). A server restart destroys every lobby and kicks everyone. `{src}` |
| FEAT-ARCH-03 | Persistent store: libSQL/SQLite file `data/ethernal.db` with tables `users`, `user_data`, `refresh_tokens`. Hosted games may have their own DB file at `data/games/<gameId>/<gameId>.db`. `{src}` |
| FEAT-ARCH-04 | Single process, no clustering/horizontal scaling (in-memory maps + singleton managers). `{src}` |
| FEAT-ARCH-05 | Game types: **hosted** (registered in `game.registry.ts`; optional `entryScript` = Node subprocess per lobby, no `entryScript` = pure relay) and **external** (registered in `external-games.ts`; `hosted=false`, hub is only a comms channel). Games must be registered in code; unknown `gameId` ⇒ lobby creation refused. `{src}` |
| FEAT-ARCH-06 | Registered today: `tictactoe` (relay, max 2), `dudg` (subprocess, max 40), `my-tester-app` (external, max 4). `maxPlayers` is a hard registry value, never client-controlled. `{src}` |
| FEAT-ARCH-07 | Heartbeat: `pingInterval=2000ms`, `pingTimeout=5000ms` ⇒ dead connection detected in ≤ ~7 s. `{src}` |
| FEAT-ARCH-08 | HTTP: `GET /health`, `GET /api/games`, `GET /games` (identical game list), `GET /` (HTML hub page), static `/assets`, `/docs`, `/tictactoe`, `/dudg`. CORS restricted to `ALLOWED_ORIGINS` (requests without Origin header are allowed). `{src}` |
| GAP-ARCH-01 | No dynamic game registration at runtime; adding a game requires editing server code and redeploying. |
| GAP-ARCH-02 | No persistence of lobbies/sessions across restarts; no graceful-shutdown notice to clients. |

## 2. Accounts & sessions (`AUTH`)

| ID | Fact |
|---|---|
| FEAT-AUTH-01 | `POST /auth/register` `{username,password}`: username 3–32 chars `[a-zA-Z0-9_-]`, password 8–128. Username unique, **case-sensitive** (`Bob` and `bob` are different accounts). Returns `{user, accessToken, refreshToken}`. `{src}` |
| FEAT-AUTH-02 | `POST /auth/login`, `POST /auth/refresh` (rotating refresh token: old one revoked on use), `POST /auth/logout` (revokes the given refresh token only). `{src}` |
| FEAT-AUTH-03 | Access token: JWT, 1 h. Refresh token: random 32 bytes, stored as SHA-256 hash, 30 days. `{src}` |
| FEAT-AUTH-04 | Rate limits (per IP, express-rate-limit): login 10/15 min, register 5/h, refresh 30/15 min. Usernames/refresh tokens in `rate-limit-whitelist.json` bypass. `{src}` |
| FEAT-AUTH-05 | Socket handshake: `auth: { token: "Bearer <jwt>", clientType: "game" | "panel" }`. Missing/invalid ⇒ connection error `UNAUTHENTICATED` / `INVALID_TOKEN`. Anything other than `"panel"` is treated as `"game"`. `{src}` |
| QUIRK-AUTH-01 | JWT is verified **only at connect time**. An established socket keeps working after the token expires or the refresh token is revoked/logged out. `{src}` |
| QUIRK-AUTH-02 | `logout` does not disconnect sockets, does not remove the user from lobbies or presence. `{src}` |
| GAP-AUTH-01 | No guest/anonymous accounts, no OAuth/Steam/console identity linking, no email/password reset, no account deletion, no username change, no display-name vs. login-name split. |
| GAP-AUTH-02 | No roles (admin/moderator), no account ban/mute, no "revoke all sessions". |
| GAP-AUTH-03 | `POST /auth/refresh` returns raw error codes as the message (`REFRESH_TOKEN_REVOKED`, …); `USER_NOT_FOUND` maps to HTTP 500. |

## 3. Presence — "who is online" (`PRES`)

| ID | Fact |
|---|---|
| FEAT-PRES-01 | Presence = in-memory map `userId → {userId, username, lobbyId?, gameId?, lobbyStatus?}`. Only `clientType=game` sockets create/remove presence. `{src}` |
| FEAT-PRES-02 | Connect ⇒ broadcast `presence:joined` to all *other* sockets. Disconnect (active socket) ⇒ broadcast `presence:left` to all. `presence:list` ⇒ full snapshot to requester (rate-limited). `{src}` |
| FEAT-PRES-03 | Any lobby create/join/leave/accept/GAME_OVER re-emits `presence:joined` with the new state **to every connected socket** (`io.emit`), including `lobbyId`, `gameId`, `lobbyStatus`. `{src}` |
| FEAT-PRES-04 | Presence is **global**: every authenticated user sees every other user, and which lobby/game they are in. No friends-only visibility, no invisible/away/busy status, no custom status text. `{src}` |
| QUIRK-PRES-01 | **Private-lobby ID leak:** presence exposes `lobbyId` of private lobbies to all users, and `joinLobby({lobbyId})` does not check `isPrivate`. Anyone can therefore bypass the invite code by joining via the leaked ID (unless the lobby is locked/full/closed). `{src}` |
| QUIRK-PRES-02 | Presence update on `lobbyStatus` change is sent per player ⇒ N broadcasts to all clients when a lobby of N players changes (O(N × users) fan-out). `{src}` |
| QUIRK-PRES-03 | A user with only a `panel` socket (no game socket) is not in presence and cannot receive per-user pushes (see FEAT-COMM-05). `{src}` |
| GAP-PRES-01 | No friends list, follow, block list, party/group concept, or "recently played with". |
| GAP-PRES-02 | No per-game presence filtering (the full online list of all games is delivered). |
| GAP-PRES-03 | No "last seen" / offline presence. |

## 4. Lobbies (`LOBBY`)

### 4.1 Data model
`Lobby { id(uuid), gameId, name(≤64, trimmed), hostId, players[{userId,username,isHost}], maxPlayers, status: open|full|closed, isPrivate, inviteCode?(6 chars), settings(free JSON), hosted, locked, createdAt }`.
Index maps: `userId→lobbyId` (**a user can be in at most one lobby at a time**, across all games), `inviteCode→lobbyId`.

### 4.2 Lifecycle & operations

| ID | Operation | Who | Behaviour | Errors / notes |
|---|---|---|---|---|
| FEAT-LOBBY-01 | `createLobby {gameId,name,isPrivate?,settings?}` | any authed user not in a lobby | Creates lobby, caller = host, joins socket room, emits `lobbyCreated`, sets presence, **starts game subprocess immediately** (if game has `entryScript`). Solo play possible. | `Ungültige Lobby-Daten` (gameId must match `^[a-z0-9-]{1,32}$`, name 1–64), `Unbekanntes Spiel`, `ALREADY_IN_LOBBY` |
| FEAT-LOBBY-02 | Private lobby | creator | `isPrivate=true` ⇒ 6-char invite code (alphabet without `0 O 1 I`, case-insensitive on join), hidden from `listLobbies`. Code unique among active lobbies, freed when the lobby dissolves. | Code only generated at creation. |
| FEAT-LOBBY-03 | `listLobbies(gameId)` | anyone authed | Returns lobbies of that game with `status==='open'` AND `!isPrivate`. **Locked lobbies are included** (check `locked` flag). Full/closed/private not listed. Response contains full `Lobby` incl. `settings`. | Rate-limited. |
| FEAT-LOBBY-04 | `joinLobby {lobbyId}` | non-member | Appends player, status→`full` when `players>=maxPlayers`, emits `lobbyUpdated` to room, sends IPC `PLAYER_JOIN` to running subprocess. | `ALREADY_IN_LOBBY`, `LOBBY_NOT_FOUND`, `LOBBY_CLOSED`, `LOBBY_LOCKED`, `LOBBY_FULL`. Not blocked for private lobbies (QUIRK-PRES-01). |
| FEAT-LOBBY-05 | `joinLobbyByCode {code}` | non-member | Same as above via invite code (6 chars, trimmed, upper-cased). Works for any lobby that *has* a code (only private ones). | `Ungültiger Einladungscode`, `Einladungscode nicht gefunden` + join errors. |
| FEAT-LOBBY-06 | `leaveLobby` | member | Removes player; PLAYER_LEAVE sent to subprocess; if last player ⇒ lobby dissolved (removed, code freed, pending requests rejected `lobby_closed`); if host left ⇒ **host auto-transferred to the next player in join order** (`players[0]`), pending requests rejected `host_changed`; `full`→`open`. | Silent no-op if not in a lobby. Not rate-limited. |
| FEAT-LOBBY-07 | `getLobbyInfo` | member | Snapshot `lobbyInfo`. Side effect: **re-binds this socket to the lobby room** and re-sends IPC `PLAYER_JOIN` (used to sync a second socket, e.g. panel→game). | `Du bist in keiner Lobby`. |
| FEAT-LOBBY-08 | `kickPlayer {playerId, reason?}` | host | Removes target, adds it to the lobby's in-memory kicked set (`KICKED_FROM_LOBBY` on rejoin), emits `playerKicked {lobbyId, reason?}` to target socket(s) in room, IPC `PLAYER_LEAVE`, `lobbyUpdated` to room. `full`→`open`. | `NOT_HOST`, `CANNOT_KICK_SELF`, `PLAYER_NOT_FOUND`. |
| FEAT-LOBBY-09 | `transferHost {playerId}` | host | Swap host role; emits `lobbyUpdated`. | `NOT_HOST`, `ALREADY_HOST`, `PLAYER_NOT_FOUND`. Open join requests are **not** cleared (they stay addressed at the old host’s socket — see QUIRK-JOIN-04). |
| FEAT-LOBBY-10 | `lockLobby` / `unlockLobby` | host | Toggles `locked`; emits `lobbyUpdated`. See §5. | `NOT_HOST`. |
| FEAT-LOBBY-11 | Closing | server only | `status='closed'` set when the subprocess sends `GAME_OVER` or the subprocess exits/errors. Closed lobby: not listed, not joinable, members **remain members** until they leave. | No client call can close a lobby. |

### 4.3 What can change on a lobby, and by whom

| Property | Mutable after creation? | By whom / how |
|---|---|---|
| `name`, `settings`, `maxPlayers`, `gameId`, `isPrivate`, `inviteCode` | **No** (`[GAP]`) | – (delete & recreate) |
| `hostId` | Yes | host (`transferHost`), or automatically when host leaves/disconnects |
| `locked` | Yes | host |
| `players` | Yes | join / leave / kick / accepted request / disconnect |
| `status` open⇄full | Automatic | by player count |
| `status` → closed | One-way | subprocess `GAME_OVER` / subprocess exit |

### 4.4 Behaviours you probably do NOT want (lobby)

| ID | Observation | Impact |
|---|---|---|
| QUIRK-LOBBY-01 | **Disconnect = immediate leave.** Socket drop (≤7 s detect) runs the normal leave path at once: no reconnect grace period, lobby slot is lost, host is auto-transferred, last player ⇒ lobby dissolved. The shared type comment on `PLAYER_LEAVE` ("unlike PLAYER_DISCONNECT there is a reconnect grace") does **not** match the hub, which removes the player from the lobby right away; any grace period must be implemented inside the game subprocess and is moot because the player is already out of the hub’s lobby. `{src}` | Mobile/Wi-Fi blips, tab refresh and app switching eject players. Poor for long sessions (MMO, RPG, strategy, async). |
| QUIRK-LOBBY-02 | **Session takeover also evicts from the lobby.** A new `game` socket for the same user disconnects the old one; the old socket’s disconnect handler runs the leave path for that user (lobby membership is keyed by `userId`, not socket). Net effect on F5/second device: user ends up with **no lobby**, must rejoin (and rejoin as a new player). `{src}` (re-check with TEST-LOBBY-12) | Reconnect-to-running-match is not supported. |
| QUIRK-LOBBY-03 | **Subprocess leaks.** `stopInstance()` is never called. When the last player leaves, the lobby is removed but the game subprocess keeps running (unless the game exits itself, as DUDG does when its host leaves). `{src}` | Orphaned processes, memory/CPU growth with `entryScript` games. |
| QUIRK-LOBBY-04 | **Start failure leaves a ghost lobby.** `createLobby` registers the lobby *before* `startInstance`. If spawn throws synchronously (e.g. `GAME_NOT_FOUND`, `INSTANCE_ALREADY_RUNNING`, oversized env), the client gets the error `Lobby konnte nicht erstellt werden` **but the lobby already exists** and the user is its member (they already received `lobbyCreated`). Async spawn errors set the lobby `closed`. `{src}` | Client sees both success and failure. |
| QUIRK-LOBBY-05 | `settings` is an unvalidated, unbounded free-form object (only Socket.io’s default ~1 MB packet limit applies). It is returned in `listLobbies` to everybody and passed to the subprocess as an **environment variable** (`LOBBY_SETTINGS`) which has OS size limits. `{src}` | Large/hostile settings can break process spawn; secrets in settings are world-readable (public lobbies). |
| QUIRK-LOBBY-06 | `name` is trimmed after validation ⇒ a whitespace-only name passes validation and results in an empty name. Names are not unique, not profanity-filtered. `{src}` | Cosmetic/moderation. |
| QUIRK-LOBBY-07 | No "game started" gate. Lobby stays `open` and joinable while a match is running (relay games never change status at all; subprocess games only on `GAME_OVER`). Only `lock` or the game’s own logic prevents late joiners. `{src}` | Mid-match joins in competitive games unless host locks or game rejects. |
| QUIRK-LOBBY-08 | Closed lobbies cannot be reopened/restarted (no rematch). Members stay stuck as "in lobby" until they `leaveLobby`; the subprocess may be dead and `gameAction` is silently ignored. `{src}` | Rematch flows need leave + create + re-invite. |
| QUIRK-LOBBY-09 | **Superseded (P2):** kicks are soft per-lobby — a kicked player gets `KICKED_FROM_LOBBY` on rejoin (ID, code, request, friend-join, invite accept) until the host un-kicks, invites or accepts them, or the lobby dissolves. Not a ban; nothing is persisted. |
| QUIRK-LOBBY-10 | Host auto-transfer picks `players[0]` (oldest member) with no consent, no "host migration" notification beyond `lobbyUpdated`, and no option to dissolve instead. For games where the host is authoritative (client-hosted external apps) this silently changes authority. `{src}` | |
| QUIRK-LOBBY-11 | `hosted`/`entryScript` is per game, not per lobby. `listLobbies` and presence give no "match in progress" indicator. `{src}` | |
| QUIRK-LOBBY-12 | `leaveLobby`, `gameAction` (no lobby), and `cancelJoinRequest` (unknown request) fail silently without `error` events. `{src}` | Hard-to-debug clients. |
| GAP-LOBBY-01 | No ready-check / start-game command / countdown, no team or slot assignment, no spectator role (DUDG implements spectators itself inside its subprocess), no per-lobby password, no min-players, no lobby chat history, no lobby search/filter/sort beyond `gameId`, no matchmaking/quick-play queue, no lobby invites to specific users (only code or presence "join" button), no lobby TTL/idle timeout, no update of settings/name by host, no "close lobby" or "dissolve" action. |

## 5. Join restriction: lock & join requests (`JOIN`)

| ID | Fact |
|---|---|
| FEAT-JOIN-01 | `locked=true` ⇒ `joinLobby`/`joinLobbyByCode` fail with `LOBBY_LOCKED`; entry only through host-approved requests. |
| FEAT-JOIN-02 | `requestJoinLobby {lobbyId}` / `requestJoinLobbyByCode {code}`: if lobby is **not locked** it joins directly (acts as join). If locked: stores request (15 s timeout), emits `joinRequestPending` to requester and `joinRequestReceived {lobbyId,requesterId,username}` to the **host’s game socket**. Duplicate request ⇒ `joinRequestPending` again. Refused when already in a lobby / closed / full. |
| FEAT-JOIN-03 | Host `respondJoinRequest {requesterId, accept}`: decline ⇒ `joinRequestRejected{reason:'declined'}`; accept ⇒ joins with lock bypass, presence/room/IPC updates, `joinRequestAccepted{lobby}` to requester, `lobbyUpdated` to room. Accept failure (e.g. now full) ⇒ `joinRequestRejected{reason:'lobby_closed'}`. |
| FEAT-JOIN-04 | Requester `cancelJoinRequest {lobbyId}` ⇒ host gets `joinRequestWithdrawn{reason:'cancelled'}`. Timeout ⇒ requester gets `joinRequestRejected{reason:'timeout'}`, host gets `joinRequestWithdrawn{reason:'timeout'}`. |
| FEAT-JOIN-05 | Requester disconnect ⇒ all their requests withdrawn (`cancelled`). Host leaves ⇒ requests rejected `host_changed`. Lobby dissolves ⇒ `lobby_closed`. |
| BUG-JOIN-01 | **Likely crash/unhandled exception.** `startJoinRequest` calls `allowLobbyEvent(lobby.id, 'requestJoinLobby')`, but `lobbyLimits` (config and defaults in `limits.ts`) only defines `sendToLobby`, `sendToLobbyBinary`, `gameAction`. `LOBBY_LIMITS['requestJoinLobby']` is `undefined` ⇒ `rule.burst` throws `TypeError` inside the socket event handler on the first request to a locked lobby. Depending on Socket.io handling this is at minimum a failed request, at worst a process-level uncaught exception. `{src}` (confirm with TEST-JOIN-01) |
| QUIRK-JOIN-01 | Requests are only delivered to the host’s **game** socket (`gameSocketMap`), not the panel socket. Host without a game socket ⇒ request silently times out after 15 s. |
| QUIRK-JOIN-02 | Unlocking a lobby does **not** resolve pending requests (they time out or can still be accepted). |
| QUIRK-JOIN-03 | A user can have requests pending in several lobbies at once; if they join one, the others stay pending; accepting a stale one fails with `ALREADY_IN_LOBBY` and is reported to the requester as reason `lobby_closed` (misleading). |
| QUIRK-JOIN-04 | `transferHost` does not clear/redirect pending requests: new host never receives `joinRequestReceived` for already pending ones; old host can no longer respond (not host) ⇒ they expire. |
| QUIRK-JOIN-05 | Request timeout is hard-coded (15 s), not configurable. Panel "Beitreten" button uses plain `joinLobby`, never `requestJoinLobby` ⇒ always fails on locked lobbies. |
| GAP-JOIN-01 | No invite-to-user, no friend auto-join, no per-request message, no "allow friends bypass lock", no pending-request list on reconnect/`getLobbyInfo`. |

## 6. Communication (`COMM`)

All relay requires: sender is in a lobby, `socket.data.currentLobbyId` matches the hub’s lobby for the user (`Lobby-Kontext ungültig` otherwise).

| ID | Channel | Behaviour |
|---|---|---|
| FEAT-COMM-01 | `sendToLobby {type,payload}` | Relay JSON to **all other** sockets in the lobby room (`message {from,type,payload}`). Sender excluded. No echo, no ack, no history. `type` and `payload` are not validated or size-limited (Socket.io ~1 MB frame limit). Per-socket 250/s (burst 500), per-lobby 1200/s (burst 2400). |
| FEAT-COMM-02 | `sendToLobbyBinary {typeCode,payload}` | `typeCode` integer 0–65535; payload `Uint8Array`/`ArrayBuffer`/typed array/base64 string; **max 1000 bytes** (configurable `binary.maxPayloadBytes`). Delivered as `messageBinary`. Same rate classes. |
| FEAT-COMM-03 | `sendToPlayer {playerId,type,payload}` | Direct message to one player **in the same lobby only**. Errors: `Spieler nicht in derselben Lobby`, `Spieler nicht erreichbar`. Sending to self is allowed. 200/s per socket. |
| FEAT-COMM-04 | `sendToPlayerBinary` | Same with binary rules. |
| FEAT-COMM-05 | Per-user delivery uses `gameSocketMap` (game socket only); panel sockets can receive lobby-room broadcasts but not `sendToPlayer`. |
| FEAT-COMM-06 | Hosted subprocess → clients: `gameState` (room), `gameState` to a single user (from `GAME_STATE_FOR_USER`, only if still member of that lobby), `gameEvent` (room), `gameOver` (room; also sets lobby `closed`), `gameStarting` (room, on subprocess `READY`). Clients → subprocess: `gameAction {type,payload}` (ignored silently unless the lobby has a running subprocess and caller is member; per-socket 300/s, per-lobby 1600/s). |
| QUIRK-COMM-01 | **Relay-only games (no `entryScript`) never emit `gameStarting`/`gameOver`** and never close the lobby; the game must define its own start/end messages via relay. |
| QUIRK-COMM-02 | The server is a dumb relay: **no authority** (a client can claim any `type`/`payload`), no ordering guarantees beyond TCP/WebSocket, no delivery acknowledgement, no message persistence, no reliable/unreliable channel choice, no tick/clock sync, no server-side message history for late joiners. |
| QUIRK-COMM-03 | `from` is the real `userId` (not spoofable). A sender can flood one lobby up to the per-lobby bucket; rate-limit errors to the same socket are throttled to one notice per 2 s. |
| QUIRK-COMM-04 | Binary payload cap of 1000 B is strict; larger payloads must be split by the app. Base64 strings are decoded **before** the size check. |
| GAP-COMM-01 | **No built-in text chat** (lobby, private, global, channel), no emotes/quick-chat, no profanity filter, no mute/block, no typing indicators. Games must implement chat on top of `sendToLobby`/`sendToPlayer`. |
| GAP-COMM-02 | **No communication outside a lobby:** no DMs to online users who aren’t in your lobby, no global/game-wide channel, no lobby-to-lobby messaging, no friend/party messages, no push to offline users, no notifications/mailbox. Only presence snapshots reach lobby-less users. |
| GAP-COMM-03 | No voice, no WebRTC signalling helper, no UDP/low-latency channel, no server-side broadcast to *all lobbies of a game* (announcements). |
| GAP-COMM-04 | No request/response (RPC) helper or ack callbacks on relay events; no server-side event log/replay. |

## 7. Hosted game subprocess (`GAME`)

| ID | Fact |
|---|---|
| FEAT-GAME-01 | One Node child process per lobby (`spawn('node', [entryScript])`, IPC channel). Env: `GAME_ID, LOBBY_ID, GAME_DB_PATH, LOBBY_SETTINGS(JSON), PLAYERS(JSON initial members)` plus the hub’s full `process.env` (⚠ includes `JWT_SECRET` and any other secrets). |
| FEAT-GAME-02 | Hub→game IPC: `PLAYER_ACTION`, `PLAYER_JOIN`, `PLAYER_DISCONNECT`, `PLAYER_LEAVE`, `USER_DATA_RESPONSE`. Game→hub IPC: `READY`, `GAME_STATE`, `GAME_STATE_FOR_USER`, `GAME_EVENT`, `GAME_OVER`, `SAVE_META`, `LOG`, `GET_USER_DATA`. |
| FEAT-GAME-03 | `SAVE_META {userId,gameId,entries[{key,value,visibility?}]}` writes into the hub’s `user_data` (upsert). `GET_USER_DATA` returns **all** of a user’s keys for a game incl. private ones. |
| FEAT-GAME-04 | Subprocess exit or error ⇒ lobby `closed`. |
| QUIRK-GAME-01 | Subprocess `SAVE_META` is not validated against the same key/visibility/size constraints as REST (key format, 100-entry cap, `gameId` can be any string, may write to **any user** and **any gameId**). |
| QUIRK-GAME-02 | A subprocess is fully trusted; it receives the hub’s environment and file-system access. |
| QUIRK-GAME-03 | `PLAYER_DISCONNECT` is sent first and the hub removes the player at once; a game that wants a reconnect grace period cannot get one from the hub (see QUIRK-LOBBY-01). `PLAYER_LEAVE` is only sent for explicit leave/kick, not for disconnects. |
| QUIRK-GAME-04 | The initial lobby creator is passed via the `PLAYERS` env var, **not** via `PLAYER_JOIN`; only later joiners trigger `PLAYER_JOIN`. |
| QUIRK-GAME-05 | Per-user state push `GAME_STATE_FOR_USER` is dropped if that user isn’t connected on a game socket in that lobby; panel→game socket mismatch needs `getLobbyInfo` on the game socket (known DUDG bug in `pending-bug-fixes.md`: panel "Beitreten" initialises the player differently than join-by-code; root cause = join via **panel socket** sets `currentLobbyId` only on the panel socket). |
| GAP-GAME-01 | No process crash restart, resource limits, per-game env isolation, or shutdown on empty lobby (QUIRK-LOBBY-03). |

## 8. User data & game data per user (`DATA`)

Store: key–value, PK `(user_id, game_id, key)`, value = any JSON (stored as text), `visibility ∈ {private, lobby, public}` (default `private`), `updated_at`.

| ID | Operation | Behaviour |
|---|---|---|
| FEAT-DATA-01 | `GET /userdata/:gameId` | All own entries (all visibilities). Socket equivalent: `getUserData(gameId)` ⇒ `userData`. |
| FEAT-DATA-02 | `GET /userdata/:gameId/:key` | One own entry or 404. |
| FEAT-DATA-03 | `PUT /userdata/:gameId/:key {value, visibility?}` | Upsert. **Omitting `visibility` resets it to `private`** (does not preserve the previous visibility). |
| FEAT-DATA-04 | `PATCH /userdata/:gameId` `[ {key,value,visibility?}, … ]` | Bulk upsert, 1–100 entries, single batch transaction. |
| FEAT-DATA-05 | `DELETE /userdata/:gameId/:key` | Delete own key (204 even if missing). |
| FEAT-DATA-06 | `GET /players/:playerId/data/:gameId` / socket `getPlayerData` | Another user’s entries: `public` always; `lobby` only if requester and target are **currently in the same lobby**; `private` never. Works for offline users (`public` only). Own ID works via same rule. |
| FEAT-DATA-07 | `GET /leaderboard/:gameId/:key?order=asc\|desc&limit=1..100` | Top-N of `public` entries ordered by numeric cast of value; returns `{userId,username,value,updatedAt}`. Default `desc`, 10. |
| FEAT-DATA-08 | Hosted subprocess may read/write via IPC (FEAT-GAME-03). |
| FEAT-DATA-09 | Validation: `gameId` `^[a-z0-9-]{1,32}$`; `key` `^[a-zA-Z0-9_.-]{1,64}$`. |
| QUIRK-DATA-01 | **Clients can write their own data directly** (PUT/PATCH), including `public` leaderboard keys ⇒ **leaderboards are client-forgeable** unless the game only ever trusts subprocess-written data. No server-authoritative/"read-only for client" flag exists. |
| QUIRK-DATA-02 | `gameId` in data APIs is **not checked against the registry** — any string can be created, consuming storage (no per-user quota). No value size limit besides HTTP body limit (Express default 100 kB) / Socket.io frame. |
| QUIRK-DATA-03 | Leaderboard: non-numeric values sort as 0 (not excluded); ties have no deterministic secondary order; no rank-of-me, no around-me, no pagination, no periodic reset (daily/weekly), no per-lobby/friend leaderboards. `limit` out of range silently falls back to 10. |
| QUIRK-DATA-04 | `getPlayerData` returns `[]` for non-existent players (no 404; allows no enumeration but also no existence check). Presence IDs are public, so IDs are discoverable. |
| QUIRK-DATA-05 | No atomic increment/compare-and-set/transactions across keys from clients (read-modify-write races for counters; bulk is atomic only within one call). No TTL/expiry, no schema/versioning, no history, no export/delete-all (GDPR) endpoint. |
| QUIRK-DATA-06 | Socket `getUserData`/`getPlayerData` are read-only; writes are REST-only (and IPC). |
| GAP-DATA-01 | No profile/avatar/bio/level/XP/currency/inventory/achievement concept at hub level; games must model these as keys. No global (cross-game) profile namespace (use a reserved gameId by convention). No data for friends-only visibility (`friends` level). No cloud-save blobs (>100 kB) or binary data. |

## 9. Rate limiting & abuse controls (`LIMIT`)

- Per-socket token buckets keyed by event (see `server/config/limits.json`): e.g. `createLobby` 0.1/s burst 2; `joinLobby` 0.25/s burst 4; `kickPlayer`/`transferHost`/`lock`/`unlock` 0.5/s burst 3; `listLobbies`/`getLobbyInfo` 5/s burst 15; `presence:list` 3/s; `getUserData`/`getPlayerData` 8/s; relay `250/s`, direct `200/s`; `gameAction` 300/s.
- Per-lobby buckets: `sendToLobby(Binary)` 1200/s, `gameAction` 1600/s. Buckets are freed on socket disconnect / lobby dissolve.
- Violation ⇒ `error "Rate limit erreicht (<event>)"`, throttled to one notice per 2 s per socket+event; the event is dropped.
- Limits are overridable via `limits.json`; HTTP auth limits per IP.
- `[GAP]` No limit on `leaveLobby`, relay `from` quotas per user (only per socket; a user with two sockets doubles), REST user-data endpoints (no rate limit), no connection-count limit per user/IP, no global lobby cap, no per-user lobby-creation cap beyond the bucket.
- `[BUG]` BUG-JOIN-01 (missing `lobbyLimits.requestJoinLobby`).

## 10. Social Panel (`PANEL`)

- Browser overlay `panel.js` with own Socket.io connection (`clientType: "panel"`): shows presence list, current lobby, "Beitreten" button for `open` lobbies of other users, game-registered action buttons; see `docs/panel-api.md`.
- `[QUIRK]` Panel `joinLobby` runs on the **panel socket**: hub membership is by `userId` so the player is in the lobby, but `currentLobbyId`/room membership exist only on the panel socket until the game socket calls `getLobbyInfo` (FEAT-LOBBY-07). Relay from the game socket fails with `Du bist in keiner Lobby` until synced.
- `[GAP]` Panel has no friends, chat, invites, notifications, block list, party UI.

## 11. Use-case coverage by game genre (quick matrix)

Legend: ✅ supported · ⚠️ possible with caveats · ❌ not supported without server work.

| Use case | Status | Reason (IDs) |
|---|---|---|
| Turn-based 2-player (chess, tictactoe, card duel) via relay | ✅ | FEAT-COMM-01/03; late-join/rematch caveats QUIRK-LOBBY-07/08 |
| Party/quiz game with host + spectators (DUDG style) | ✅ | Subprocess; host leave ends game (game logic) |
| Real-time action game (twitch) | ⚠️ | WebSocket-only latency, 1000 B binary cap, no server authority/tick; QUIRK-COMM-02/04 |
| Authoritative server logic (poker, card/TCG, MOBA rules) | ⚠️ | Subprocess model OK; leak/ghost-lobby issues QUIRK-LOBBY-03/04 |
| Persistent world / MMO / long-running co-op | ❌ | All state in-memory, disconnect = leave, no reconnect (QUIRK-LOBBY-01/02, ARCH-02) |
| Reconnect into running match (mobile) | ❌ | QUIRK-LOBBY-01/02 |
| Matchmaking / quick play / ranked | ❌ | GAP-LOBBY-01; leaderboards forgeable (QUIRK-DATA-01) |
| Friends, parties, invites, DMs, global chat | ❌ | GAP-PRES-01, GAP-COMM-01/02 |
| Per-player persistent progress/stats/unlocks | ✅ | FEAT-DATA-01..05; no atomic counters/quotas |
| Public stats/profile viewing, simple leaderboards | ⚠️ | FEAT-DATA-06/07; forgeable, no rank/reset |
| Server-trusted achievements/anti-cheat data | ⚠️ | Only via subprocess `SAVE_META` + never granting client write to those keys (not enforceable) |
| Private games with codes | ⚠️ | FEAT-LOBBY-02; ID leak QUIRK-PRES-01 |
| Host moderation (kick/lock/approve) | ⚠️ | FEAT-LOBBY-08/10, FEAT-JOIN-*; no ban; BUG-JOIN-01 |
| External native client (Unity/.NET) as relay | ✅ | Node & C# SDKs, `hosted=false`; registry must be edited |
| Spectators in relay games | ⚠️ | No role; model as extra players up to `maxPlayers` |
| Asynchronous/offline turns | ❌ | No offline messaging/push, no persistent lobbies |

## 12. Test plan & conformance suite

The hub is covered by an executable **conformance suite** (`server/test/conformance/*.test.ts`, run with `npx vitest run server/test/conformance`). Each row below is one test whose title starts with the same ID. The table states the **current (post-rework) expected behaviour**; the older pre-rework quirks listed in the sections above are superseded where the reworked docs (`docs/socket-events.md`, `docs/game-server-protocol.md`, `docs/enums.md`) say otherwise. `npm run check:conformance` fails CI if a row has no test or a test uses an ID that is not listed here; see `docs/conformance.md`.

Hub-side only: SDK parity is covered by the SDK test suites.

| ID | Expected behaviour |
|---|---|
| TEST-SESS-01 | hello announces protocol version, session id, capabilities |
| TEST-SESS-02 | createLobby/listLobbies before registerGame fail with GAME_NOT_REGISTERED (ack form) |
| TEST-SESS-03 | unknown game id is rejected with UNKNOWN_GAME |
| TEST-SESS-04 | switching game while in a lobby fails with LEAVE_LOBBY_FIRST, works after leaving |
| TEST-SESS-05 | without ack, errors arrive as error + errorDetail events |
| TEST-SESS-06 | registerGame returns the registry entry; getState reflects it |
| TEST-LOBBY-01 | creating a second lobby while in one fails with ALREADY_IN_LOBBY |
| TEST-LOBBY-02 | full lobby rejects joiners with LOBBY_FULL; duplicate join and bad codes have stable codes |
| TEST-LOBBY-03 | host leaves, oldest remaining player becomes host |
| TEST-LOBBY-04 | last player leaving dissolves the lobby (gone from listLobbies) |
| TEST-LOBBY-05 | private lobby is hidden from listLobbies; join by code works case-insensitively |
| TEST-LOBBY-06 | private lobby cannot be joined or requested by ID (LOBBY_PRIVATE); no ID leaks to strangers |
| TEST-LOBBY-07 | non-host kick/transfer/lock/unlock/setLobbyState are rejected with NOT_HOST |
| TEST-LOBBY-08 | host kick notifies the victim; an immediate rejoin is refused (KICKED_FROM_LOBBY, see TEST-KICK-*) |
| TEST-LOBBY-09 | killed socket keeps the seat during grace (connected:false), then the player is removed and host transferred |
| TEST-LOBBY-10 | oversized settings → SETTINGS_TOO_LARGE; failed subprocess start leaves no ghost lobby |
| TEST-LOBBY-11 | names are trimmed; empty/whitespace names are INVALID_INPUT |
| TEST-LOBBY-12 | a second game socket of the same user takes over (session:replaced), the lobby stays |
| TEST-LOBBY-13 | lobbies are bound to the registered game; the client cannot choose gameId (GAME_MISMATCH) |
| TEST-LOBBY-14 | listings only expose publicSettingKeys and never invite codes |
| TEST-LOBBY-15 | setLobbyState: host only, in_progress locks joining, repeat is INVALID_STATE, closed is final |
| TEST-LOBBY-16 | lobbyUpdated carries a reason (player_joined, host_transferred) |
| TEST-KICK-01 | kicked player gets playerKicked with the optional reason and KICKED_FROM_LOBBY on joinLobby; others are unaffected |
| TEST-KICK-02 | KICKED_FROM_LOBBY also applies to join by code, requestJoinLobby and joinFriend; the host is not notified of such requests |
| TEST-KICK-03 | host unkickPlayer lets the player rejoin; non-host → NOT_HOST; not kicked → PLAYER_NOT_FOUND |
| TEST-KICK-04 | a host invite clears the kick (the invitee can join); a non-host invite of a kicked user is refused KICKED_FROM_LOBBY |
| TEST-KICK-05 | kicking a member in reconnect grace works; the kick set dies with the lobby |
| TEST-JOIN-01 | locked lobby rejects joinLobby (LOBBY_LOCKED); requestJoinLobby → pending, host accepts |
| TEST-JOIN-02 | decline → requester gets joinRequestRejected(declined); unknown request → JOIN_REQUEST_NOT_FOUND |
| TEST-JOIN-03 | unanswered request times out: requester gets rejected(timeout), host gets withdrawn(timeout) |
| TEST-JOIN-04 | cancelJoinRequest notifies host and requester sessions; second cancel → JOIN_REQUEST_NOT_FOUND |
| TEST-JOIN-05 | requester disconnect withdraws the request for the host |
| TEST-JOIN-06 | host leaving informs the requester (lobby_closed / host_changed) |
| TEST-JOIN-07 | getJoinRequests mirrors both sides and carries expiresAt |
| TEST-JOIN-08 | requestJoinLobby on an unlocked lobby joins immediately; unlock lets joinLobby work again |
| TEST-COMM-01 | sendToLobby reaches the other members, never the sender |
| TEST-COMM-02 | sendToPlayer works in-lobby; other-lobby/self/no-lobby have stable error codes |
| TEST-COMM-03 | binary relay validates type code and size, delivers valid frames |
| TEST-COMM-04 | JSON relay validates type and size; seq increases monotonically |
| TEST-COMM-05 | relay is rejected for a client in no lobby even right after joining via another session (NOT_IN_LOBBY) |
| TEST-RECON-01 | reconnect within grace restores the lobby (hello.lobbyId, session:resumed) and relay works |
| TEST-RECON-02 | grace expiry removes the player and transfers host; the lobby survives for the rest |
| TEST-RECON-03 | reconnectGraceMs 0 removes the player immediately |
| TEST-RECON-04 | takeover by a new session keeps the lobby (session:replaced → session:resumed) |
| TEST-RECON-05 | subprocess receives PLAYER_DISCONNECT, PLAYER_RECONNECT and (after grace) PLAYER_LEAVE |
| TEST-RECON-06 | explicit leaveLobby sends PLAYER_LEAVE immediately (no grace) |
| TEST-DATA-01 | PUT without visibility keeps the existing visibility and bumps the version |
| TEST-DATA-02 | serverKeys are read-only for clients (REST single+PATCH transactional, socket); subprocess writes via SAVE_META |
| TEST-DATA-03 | visibility matrix: private never, lobby for lobby-mates, public for everyone |
| TEST-DATA-04 | validation: unknown game, bad key chars, value size, per-game quota |
| TEST-DATA-05 | socket parity: setUserData / bulkSetUserData / deleteUserData / getUserData and codes |
| TEST-DATA-06 | SAVE_META for a game other than the lobby game is discarded |
| TEST-DATA-07 | leaderboard lists public numeric client keys sorted desc; private keys never appear |
| TEST-AUTH-01 | socket without refresh gets AUTH_EXPIRED after expiry and is disconnected |
| TEST-AUTH-02 | auth:refresh keeps the socket alive beyond the original expiry |
| TEST-AUTH-03 | auth:refresh with another user's token is INVALID_TOKEN |
| TEST-AUTH-04 | logout disconnects all sockets of the user |
| TEST-AUTH-05 | logout-all revokes refresh tokens and disconnects sockets |
| TEST-AUTH-06 | refresh rotation: a reused refresh token is REFRESH_TOKEN_REVOKED |
| TEST-AUTH-07 | usernames are unique and login is case-insensitive; REST errors carry code + error text |
| TEST-AUTH-08 | socket connect without / with invalid token fails with UNAUTHENTICATED / INVALID_TOKEN |
| TEST-LIMIT-01 | socket rate limit answers RATE_LIMITED with retryAfterMs in the ack |
| TEST-LIMIT-02 | HTTP auth rate limit returns 429 RATE_LIMITED |
| TEST-INFRA-01 | /health and /api/games are reachable; test games are registered |
| TEST-FRIEND-01 | friend request by name only answers REQUEST_SENT / NO_SUCH_PLAYER (no user enumeration) |
| TEST-FRIEND-02 | accept: events on both sides, lists, only {userId, username} exposed |
| TEST-FRIEND-03 | decline: requester only learns "declined" (requestId, user); not friends; request gone |
| TEST-FRIEND-04 | FRIEND_SILENT_DECLINE suppresses the decline event |
| TEST-FRIEND-05 | cancel: receiver gets friend:requestCancelled, request and notification vanish |
| TEST-FRIEND-06 | befriend by userId from the lobby (lobby members only) |
| TEST-FRIEND-07 | crossing requests (A→B then B→A) auto-accept |
| TEST-FRIEND-08 | remove friend notifies both; removing again is NOT_FRIENDS |
| TEST-FRIEND-09 | limits: max friends, max outgoing requests, rate limit on name requests (RATE_LIMITED + retryAfterMs) |
| TEST-FRIEND-10 | pending requests expire via scheduler and are purged from the DB |
| TEST-FRIEND-11 | DELETE /social/data cascades friendships, requests, DMs and notifications |
| TEST-FRIEND-12 | REST parity: request, list, respond, remove; unauthenticated is 401 |
| TEST-PRES-01 | friends receive friend:presence on lobby changes; strangers receive nothing |
| TEST-PRES-02 | presence:friends pull (socket + REST) reports online status and gameId |
| TEST-PRES-03 | invisible appears offline (no gameId/lobby); status changes push; invalid status INVALID_INPUT |
| TEST-PRES-04 | private lobbies never expose an ID (lobbyJoinable=false); public ones are joinable without an ID |
| TEST-PRES-05 | lastSeen only when allowed; the reconnect grace period still counts as online |
| TEST-NOTIF-01 | offline recipient gets a backlog on next login; counts, paging and markRead are consistent |
| TEST-NOTIF-02 | live notification reaches all sessions; mute suppresses; invalid mute type INVALID_INPUT |
| TEST-NOTIF-03 | per-user cap drops the oldest notifications |
| TEST-NOTIF-04 | retention: scheduler purges expired notifications from the DB |
| TEST-NOTIF-05 | friend_online goes to online friends on offline→online (not to offline friends/strangers); invisible is silent; mute suppresses |
| TEST-DM-01 | only friends can DM; length and content validated |
| TEST-DM-02 | live delivery to an online recipient: text unchanged (no markup processing), no extra notification |
| TEST-DM-03 | offline DM: collapsed notification, unread, dm:delivered on reconnect, dm:read on markRead |
| TEST-DM-04 | history paginates chronologically with a backwards cursor |
| TEST-DM-05 | read cursor: dm:unread, dm:open (last 10 + pre-open markers), partial dm:markRead upToSeq, dm:readState push, peerLastReadSeq, receipts off |
| TEST-DM-06 | unfriend deletes the history for both immediately; re-friending starts empty |
| TEST-DM-07 | per-conversation cap keeps the newest; flood limit answers RATE_LIMITED |
| TEST-DM-08 | retention: scheduler deletes messages after DM_RETENTION_DAYS |
| TEST-DM-09 | typing indicator is ephemeral; REST parity for send/history/list/read |
| TEST-INVITE-01 | invite an online friend: event + notification; idempotent per (lobby, friend); accept joins even a private lobby |
| TEST-INVITE-02 | acceptInvite bypasses a lock; invite and notification disappear; reuse is INVITE_NOT_FOUND |
| TEST-INVITE-03 | declining informs the inviter (lobby:inviteDeclined); only the invitee may decline |
| TEST-INVITE-04 | error paths: NOT_IN_LOBBY, NOT_FRIENDS, GAME_MISMATCH, FRIEND_OFFLINE, ALREADY_IN_LOBBY, NOT_HOST (inviteHostOnly) |
| TEST-INVITE-05 | full lobby: invites auto-cancel (lobby_full) and new invites fail with LOBBY_FULL |
| TEST-INVITE-06 | invites are cancelled when the lobby is left/dissolved or by the inviter (cancelInvite) |
| TEST-INVITE-07 | invites expire (LOBBY_INVITE_TTL_MS) with reason expired |
| TEST-INVITE-08 | an unreached invite survives reconnect (notification backlog + lobby:invites pull) |
| TEST-INVITE-09 | unfriending cancels open invites (reason unfriended) |
| TEST-INVITE-10 | joinFriend: open → direct join, locked → join request, private → only with invite, other game → GAME_MISMATCH |
| TEST-INVITE-11 | social:friendLobby: friends only; a private lobby never reveals its ID |
| TEST-SYNC-01 | social:sync returns a consistent full state; GET /social/sync is identical |
| TEST-SYNC-02 | etag: unchanged → notModified (socket + REST 304), changed → new etag |
| TEST-SYNC-03 | every REST pull route returns the same data as its socket event |
| TEST-GS-01 | registerGame reports serverSupport and regions; default is none |
| TEST-GS-02 | valid key connects; invalid, foreign-game and revoked keys get INVALID_SERVER_KEY |
| TEST-GS-03 | game with serverSupport none → GAME_SERVER_NOT_ALLOWED; unknown game → UNKNOWN_GAME |
| TEST-GS-04 | admin API rejects missing/wrong token (401), refuses games without server support (403), never lists plaintext keys |
| TEST-GS-05 | required game without a server → NO_GAME_SERVER_AVAILABLE and no ghost lobby |
| TEST-GS-06 | required with server: lobby bound (lobby:assigned reason=new_lobby), listing exposes only serverBound/region |
| TEST-GS-07 | optional: serverless without server, bound with one, serverPreference mode none bypasses it |
| TEST-GS-08 | server rejects or times out: optional → serverless, required → LOBBY_START_FAILED |
| TEST-GS-09 | capacity, region preference with fallback, and draining decide placement |
| TEST-GS-10 | hub→server events and server→hub commands (relay, state, setState, setSettings, kick, gameOver) |
| TEST-GS-11 | a server cannot act on lobbies of another server (NOT_LOBBY_SERVER for every command) |
| TEST-GS-12 | the server is never a lobby participant |
| TEST-GS-13 | reconnect with the same serverId within grace resumes (resumed:true + lobbies) |
| TEST-GS-14 | required lobby of a lost server is closed with gameCrashed after grace; gameAction → SERVER_UNAVAILABLE meanwhile |
| TEST-GS-15 | same serverId with a new connection replaces the old one (takeover) |
| TEST-GS-16 | server loss → lobbyUpdated server_lost (serverStatus lost); resume → server_resumed (serverStatus ok) |
| TEST-GS-17 | after grace the lobby is rebound to another server: lobby:assigned reason=server_rebound (+previousServerId, lostAt), members get server_rebound |
| TEST-GS-18 | optional lobby without a replacement server continues serverless (server cleared, reason server_lost) |
| TEST-GS-19 | draining marks lobbies (server_draining), refuses new lobbies, and can return to ok |
| TEST-PROC-01 | subprocess games get a process; READY → gameStarting; gameAction is forwarded as PLAYER_ACTION |
| TEST-PROC-02 | subprocess crash → gameCrashed with exit code |
| TEST-PROC-03 | MAX_INSTANCES is enforced (INSTANCE_LIMIT) and a freed slot is reusable once the lobby dissolves |
| TEST-PROC-04 | lobby settings reach the subprocess as env (LOBBY_SETTINGS) and are size-limited |
| TEST-SEC-01 | hub secrets (JWT_SECRET, ADMIN_TOKEN) are not in the subprocess environment |
| TEST-SEC-02 | flooding stdout/stderr does not break the hub or the lobby |
| TEST-SEC-03 | flooding the IPC channel stays bounded; the hub stays responsive |
| TEST-SEC-04 | invalid / foreign / oversized SAVE_META is rejected and never crashes the hub |
| TEST-SEC-05 | malformed IPC messages (unknown type, missing payload) never crash the hub |
| TEST-LOAD-01 | 60 clients connect, register a game, form lobbies and relay 240 messages without errors |
| TEST-GENRE-01 | turn-based — host-relayed turns alternate between two players with ordered delivery |
| TEST-GENRE-02 | realtime/shooter — high-rate JSON and binary relay arrive complete and in order |
| TEST-GENRE-03 | co-op with game server — server owns state, players act, state and results flow back |
| TEST-GENRE-04 | lobby + social flow — meet in a lobby, befriend, DM, invite a third friend, who joins |

## 13. Prioritised findings for follow-up (summary)

1. **BUG-JOIN-01** missing `lobbyLimits.requestJoinLobby` ⇒ lock/request feature broken (possible crash).
2. **QUIRK-PRES-01** private lobbies joinable by leaked ID.
3. **QUIRK-LOBBY-01/02** no reconnect; disconnect/takeover evicts player (blocks long-session genres).
4. **QUIRK-LOBBY-03** subprocess never stopped; **QUIRK-LOBBY-04** ghost lobby on start failure.
5. **QUIRK-DATA-01/02** client-writable public data (forgeable leaderboards), no quotas, no registry check; **QUIRK-GAME-01** unvalidated `SAVE_META`; **FEAT-GAME-01** subprocess inherits hub secrets.
6. Missing social/communication layer: **GAP-PRES-01, GAP-COMM-01/02** (friends, chat, DMs, invites, notifications).
7. Missing lobby controls: **GAP-LOBBY-01** (settings edit, ready/start, spectators, close/rematch, matchmaking, ban).

---

## Changelog: P0 foundation (branch `p0-foundation`, issues #11–#19)

This document describes the **as-is baseline before P0**. P0 changed the following (spec to be fully rewritten in #43):

- Workflow is now login → `session:registerGame` → lobby. `createLobby` has no `gameId`; lobbies, listing and joins are bound to the registered game (`GAME_MISMATCH`, `GAME_NOT_REGISTERED`). Private lobbies cannot be joined by ID (`LOBBY_PRIVATE`).
- Every client→server socket event accepts an ack callback returning `{ok:true,...}` or `{ok:false,error:{code,message}}`; stable codes in `shared/src/types/errors.ts`. Without ack, legacy `error` plus `errorDetail` events are emitted. `hello` announces protocol version and capabilities.
- Disconnects keep the lobby seat for the game's `reconnectGraceMs` (default 60 s); players show `connected:false`, `session:resumed` restores state, a new game session replaces the old (`session:replaced`).
- Fixed: missing join-request limit (BUG-JOIN-01), ghost lobby on failed subprocess start, instances now stopped when a lobby dissolves, `GET_USER_DATA` / `SAVE_META` membership checks, private lobby IDs no longer leaked via presence.
- User data: write scopes (`server`-scoped / `serverKeys` are read-only for clients), versions, size and quota limits, socket write events (`setUserData`, `bulkSetUserData`, `deleteUserData`).
- Infra: DB migrations (`schema_migrations`), job scheduler with refresh-token purge, env overrides (`DATA_DIR`, `GAMES_CONFIG_PATH`, `LIMITS_CONFIG_PATH`, `BCRYPT_ROUNDS`), vitest suite (`npm test`), CI workflow.
- Node and C# SDKs: `registerGame`, ack-based calls throwing `EthernalError`/`EthernalException` with `code`, new events, socket data writes, auto re-registration after reconnect.

## Changelog: P1 / game servers (issues #20–#31, #50–#54, #56)

- **friend_online notification**: when a user becomes visible (offline→online, or leaving `invisible`), each friend who is *currently online* receives a `friend_online` notification (`{userId, username}`, key `friend_online:<userId>`, replaces an older unread one). Offline friends get no backlog entry. Respects `mutedNotificationTypes`.
- **Game servers** (`/gameserver` namespace, per-game keys via `/admin/game-servers`, needs `ADMIN_TOKEN`). Registry `serverSupport: none|optional|required`; `createLobby` accepts `serverPreference {mode: any|none, region}`.
- **Server loss (#56)**: `Lobby.serverStatus` is `ok|lost|draining`; members get `lobbyUpdated` with reason `server_lost`, `server_resumed`, `server_draining`, `server_rebound`. Same `serverId` reconnecting within `SERVER_RESUME_GRACE_MS` resumes its lobbies. After the grace the hub tries to rebind the lobby to another server of the game (`lobby:assigned` with `rebind: true`); if none accepts, `required` lobbies close with `gameCrashed`, `optional` lobbies continue serverless (`server` cleared, reason `server_lost`). Draining servers receive no new lobbies; existing ones keep running until the server closes them.
- **Enums & takeover**: all reasons/statuses/error codes are enums (`docs/enums.md`, generated from `shared/src/types/enums.ts`; C# `Enums.cs` generated). `lobby:assigned` now carries `reason` (`new_lobby` | `server_rebound`), and for takeovers `previousServerId` and `lostAt`, so a server can tell a fresh lobby from a lobby of a lost server (`docs/game-server-protocol.md`). Replaces the earlier `rebind` boolean.
