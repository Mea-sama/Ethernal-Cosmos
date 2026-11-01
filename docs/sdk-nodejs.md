# Node.js SDK — `@ethernal/client`

TypeScript SDK (the "ODK" for Node/browser/Electron clients) for the Ethernal Cosmos Hub. It wraps the Hub's REST API and socket.io connection into a typed, promise-based `EthernalClient`.

- Every request method returns a promise that rejects with an [`EthernalError`](#errors).
- Hub → client events are exposed through the `EventEmitter` API (`on`/`once`/`off`, fully typed — see [Events](#events)).
- Wire enums (`LobbyChangeReason`, `ErrorCode`, …) are exported as value + type — see [Enums](#enums).
- Related: [socket-events.md](socket-events.md) (raw protocol), [rest-api.md](rest-api.md), [social-api.md](social-api.md), [enums.md](enums.md).

```ts
import { EthernalClient, EthernalError, ErrorCode, LobbyChangeReason } from '@ethernal/client';

const client = new EthernalClient({ serverUrl: 'http://localhost:12346' });
await client.login('alice', 'secret-password');
client.on('lobbyUpdated', (lobby, reason) => console.log(lobby.id, reason));
await client.registerGame('chess');
const lobby = await client.createLobby({ name: 'Fast game' });
await client.sendToLobby('move', { from: 'e2', to: 'e4' });
```

## Contents

[Constructor](#constructor) · [Auth](#auth) · [Session](#session) · [Lobbies](#lobbies) · [Relay](#relay) · [Game actions](#game-actions) · [User data](#user-data) · [Leaderboard](#leaderboard) · [Social](#social) · [Blocks](#blocks) · [Account](#account) · [GameServerClient](#gameserverclient-game-server-sdk) · [Events](#events) · [Errors](#errors) · [Enums](#enums) · [Types](#types)

---

## Constructor

```ts
new EthernalClient(options: EthernalClientOptions)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `serverUrl` | `string` | — | Hub base URL, e.g. `http://localhost:12346` (a trailing `/` is removed). |
| `requestTimeout` | `number` | `5000` | Milliseconds to wait for a socket answer before rejecting with `TIMEOUT`. |
| `clientType` | `'game' \| 'panel'` | `'game'` | `'game'` is the primary session (a new `'game'` connection of the same user replaces the old one → `session:replaced`). `'panel'` is an extra companion session (e.g. a social overlay) that coexists with it and receives the same user events (DMs, `dm:readState`, join-request confirmations). |

---

## Auth

Accounts live on the Hub. `register`/`login` connect the socket and resolve once it is connected, so game calls can follow immediately. The SDK stores the tokens, renews the access token automatically (on `AUTH_EXPIRED` it refreshes the token and re-authenticates the live socket in place) and reconnects with automatic re-registration of the game after connection loss.

```ts
interface AuthResult { user: { id: string; username: string }; accessToken: string; refreshToken: string }
```

### `register(username, password): Promise<AuthResult>`
Create an account and connect. `username` 3–32 chars (`[a-zA-Z0-9_-]`), `password` 8–128 chars.
Throws `USERNAME_TAKEN`, `INVALID_INPUT`, `RATE_LIMITED`.

### `login(username, password): Promise<AuthResult>`
Log in and connect. If your seat in a lobby is still held (reconnect grace), the hub resumes it: `hello.lobbyId` is set and `session:resumed` is emitted.
Throws `INVALID_CREDENTIALS`, `RATE_LIMITED`.

### `logout(): Promise<void>`
Revoke this device's refresh token and close the socket. Local state is cleared even if the request fails.

### `logoutAll(): Promise<void>`
Revoke **all** refresh tokens of the account (every device) and close the socket.

### `refreshSocketAuth(): Promise<void>`
Manually renew the access token and re-authenticate the live socket (`auth:refresh`). Normally unnecessary — the SDK does this on `AUTH_EXPIRED`.
Throws `INVALID_REFRESH_TOKEN`, `REFRESH_TOKEN_REVOKED`, `REFRESH_TOKEN_EXPIRED`, `NOT_CONNECTED`. When renewal fails on reconnect, `authError` is emitted.

### `disconnect(): void`
Close the socket **without** logging out: tokens and the registered game are kept, a held lobby seat stays reserved for the grace period, and `disconnected` is emitted. Call `login()` again to resume.

```ts
try {
  await client.login(name, password);
} catch (e) {
  if (e instanceof EthernalError && e.code === ErrorCode.InvalidCredentials) showBadPassword();
}
client.on('session:replaced', ({ reason }) => client.disconnect()); // logged in elsewhere
```

---

## Session

### `registerGame(gameId, opts?): Promise<{ game: GameInfo; state: SessionState }>`
Bind the connection to a game. Required once after login before lobbies, relay or game actions. `opts`: `{ clientVersion?: string; platform?: string }` (checked against the game's minimum version). After a reconnect the SDK re-registers automatically.
Throws `UNKNOWN_GAME`, `CLIENT_OUTDATED`, `LEAVE_LOBBY_FIRST`.

### `getSessionState(): Promise<{ state: SessionState; lobby?: Lobby }>`
Pull the current session (`userId`, `username`, `gameId`, `lobbyId`) and, while in a lobby, the lobby. Use it after a reconnect instead of relying on events.

```ts
client.on('hello', (h) => console.log('protocol', h.protocolVersion, 'resumed lobby', h.lobbyId));
client.on('session:resumed', ({ state, lobby }) => showLobby(lobby));
```

---

## Lobbies

```ts
interface CreateLobbyOptions {
  name: string;
  isPrivate?: boolean;                 // hidden from listLobbies, gets an invite code
  settings?: Record<string, unknown>;  // game-defined, size-limited
  serverPreference?: { mode?: ServerMode; region?: string };
}
```

`Lobby`: `{ id, gameId, name, hostId, players: { userId, username, isHost, connected?, disconnectedAt? }[], maxPlayers, status, isPrivate, inviteCode?, settings, joinable?, server?, serverStatus?, serverBound?, region?, hosted, locked, createdAt }` (`createdAt` unix ms); `status` is a `LobbyStatus`, `serverStatus` a `LobbyServerStatus`.

### `createLobby(data: CreateLobbyOptions): Promise<Lobby>`
Create a lobby for the registered game; you become host. `serverPreference` only matters for games with dedicated game-server support: `{ mode: 'none' }` forces the hub-hosted game, `{ mode: 'any', region: 'eu' }` asks for a game server (required for `serverSupport: 'required'` games). The game is bound to the game server that was assigned; see `LobbyChangeReason.ServerLost/ServerRebound` below.
Throws `GAME_NOT_REGISTERED`, `ALREADY_IN_LOBBY`, `SETTINGS_TOO_LARGE`, `INVALID_INPUT`, `LOBBY_START_FAILED`, `INSTANCE_LIMIT`, `NO_GAME_SERVER_AVAILABLE`.

```ts
const lobby = await client.createLobby({ name: 'Ranked', settings: { map: 'ice' }, serverPreference: { mode: 'any', region: 'eu' } });
```

### `listLobbies(): Promise<Lobby[]>`
Public lobbies of the registered game (private lobbies are not listed). Throws `GAME_NOT_REGISTERED`.

### `joinLobby(lobbyId: string): Promise<Lobby>`
Join a public lobby by ID. Throws `LOBBY_NOT_FOUND`, `LOBBY_FULL`, `LOBBY_LOCKED`, `LOBBY_PRIVATE`, `LOBBY_CLOSED`, `LOBBY_IN_PROGRESS`, `ALREADY_IN_LOBBY`, `GAME_MISMATCH`.

### `joinLobbyByCode(code: string): Promise<Lobby>`
Join via invite code (also private lobbies). Throws `INVALID_INVITE_CODE`, `INVITE_CODE_NOT_FOUND` plus the errors of `joinLobby`.

### `leaveLobby(): Promise<void>`
Leave the current lobby (no error if you are in none). The host leaving promotes another player (`HostLeft`) or closes the lobby.

### `getLobbyInfo(): Promise<Lobby>`
Snapshot of the current lobby. Throws `NOT_IN_LOBBY`.

### `kickPlayer(playerId: string, reason?: string): Promise<void>`
(Host) Remove a player; they receive `playerKicked { lobbyId, reason? }` (`reason` ≤ 200 chars). The kick is soft and lasts as long as the lobby: `joinLobby`, `joinLobbyByCode`, join requests and invites of the kicked player fail with `KICKED_FROM_LOBBY` until `unkickPlayer`. Throws `NOT_HOST`, `CANNOT_KICK_SELF`, `PLAYER_NOT_FOUND`.

### `unkickPlayer(playerId: string): Promise<void>`
(Host) Lift a kick so the player can join again. Throws `NOT_HOST`, `PLAYER_NOT_FOUND`.

### `transferHost(playerId: string): Promise<void>`
(Host) Hand over host rights. Throws `NOT_HOST`, `ALREADY_HOST`, `PLAYER_NOT_FOUND`.

### `lockLobby(): Promise<void>` / `unlockLobby(): Promise<void>`
(Host) A locked lobby rejects direct joins with `LOBBY_LOCKED`; players can instead ask via `requestJoinLobby`. Throws `NOT_HOST`.

### `setLobbyState(state: LobbyStatus): Promise<Lobby>`
(Host) Mark the game as running (`in_progress`) or close the lobby. Throws `NOT_HOST`, `INVALID_STATE`.

### Join requests
```ts
requestJoinLobby(lobbyId: string): Promise<Lobby>
requestJoinLobbyByCode(code: string): Promise<Lobby>
cancelJoinRequest(lobbyId: string): Promise<void>
getJoinRequests(): Promise<JoinRequestsResult>
respondJoinRequest(requesterId: string, accept: boolean): Promise<void>
```
`requestJoinLobby*` joins immediately if the lobby is open; for a locked lobby the promise stays pending until the host answers (≈15 s timeout) and resolves with the lobby (you are already a member). A rejection by the host, a timeout or a changed lobby rejects with `LOBBY_LOCKED`; a cancelled request rejects the pending promise with `JOIN_REQUEST_NOT_FOUND` (driven by the hub's `joinRequestWithdrawn` confirmation, so it also works when the request is cancelled from another session of your account). The host receives `joinRequestReceived` and answers with `respondJoinRequest` (`NOT_HOST`, `JOIN_REQUEST_NOT_FOUND`, `LOBBY_FULL`).

`getJoinRequests()` pulls the current state without events (e.g. after app start/reconnect): `{ incoming: JoinRequestInfo[]; outgoing?: JoinRequestInfo }` where `JoinRequestInfo = { lobbyId, requesterId, username, expiresAt }` — `incoming` are requests waiting for you as host, `outgoing` is your own open request. `expiresAt` (ms since epoch) is when the hub auto-rejects the request.

Raw outcome events: `joinRequestPending` (requester), `joinRequestAccepted`, `joinRequestRejected` (declined / timeout / unlocked / superseded, to the requester), `joinRequestWithdrawn` (host: requester cancelled or timed out; for `cancelled` also confirmed to all sessions of the requester).

### `lobbyUpdated` and its `reason`
`lobbyUpdated(lobby, reason?)` fires on every lobby change; the second argument is a [`LobbyChangeReason`](enums.md#lobbychangereason).

```ts
client.on('lobbyUpdated', (lobby, reason) => {
  switch (reason) {
    case LobbyChangeReason.PlayerJoined:  toast('Someone joined'); break;
    case LobbyChangeReason.HostLeft:      toast('New host'); break;
    case LobbyChangeReason.ServerRebound: reconnectGameTransport(lobby); break; // game server replaced; `lobby.server` changed
    case LobbyChangeReason.ServerLost:    showReconnecting(); break;
  }
});
```

---

## Relay

Low-latency player-to-player messaging inside a lobby, routed by the hub (the hub stamps `from`, `timestamp` and a per-lobby increasing `seq`; clients cannot spoof them). Requires a registered game and being in a lobby.

```ts
interface RelaySendOptions { echo?: boolean }   // also deliver to the sender; for sendToPlayer* allows targeting yourself
interface RelayMessage<T = unknown>   { from: string; type: string; payload: T; timestamp: number; seq: number; lobbyId?: string }
interface RelayBinaryMessage          { from: string; typeCode: number; payload: Uint8Array; timestamp: number; seq: number; lobbyId?: string }
```

| Method | Description |
|---|---|
| `sendToLobby(type, payload, opts?)` | JSON message to all other lobby members. |
| `sendToPlayer(playerId, type, payload, opts?)` | JSON message to one lobby member. |
| `sendToLobbyBinary(typeCode, payload, opts?)` | Binary frame (`Uint8Array`/`ArrayBuffer`, `typeCode` 0–255) to the lobby. |
| `sendToPlayerBinary(playerId, typeCode, payload, opts?)` | Binary frame to one member. |
| `onMessage(listener)` / `onceMessage(listener)` | Typed shortcut for `on('message', …)` / `once`. |
| `onBinaryMessage(listener)` / `onceBinaryMessage(listener)` | Same for `messageBinary`. |

All send methods return `Promise<void>` and throw `NOT_IN_LOBBY`, `INVALID_INPUT`, `INVALID_MESSAGE_TYPE`, `PAYLOAD_TOO_LARGE` (JSON ≤ 16 KB), `INVALID_BINARY_TYPECODE`, `INVALID_BINARY_PAYLOAD`, `BINARY_PAYLOAD_TOO_LARGE` (≤ 1000 bytes by default), `PLAYER_NOT_IN_LOBBY`, `PLAYER_UNREACHABLE`, `CANNOT_TARGET_SELF` (without `echo`), `RATE_LIMITED`.

```ts
client.onMessage<{ from: string; to: string }>((m) => console.log(m.from, m.type, m.seq, m.payload));
await client.sendToLobby('move', { from: 'e2', to: 'e4' });
await client.sendToPlayerBinary(otherId, 7, new Uint8Array([1, 2, 3]));
await client.sendToLobby('ping', {}, { echo: true }); // loop back to yourself
```

---

## Game actions

### `sendGameAction(type: string, payload: unknown): Promise<void>`
Send an action to the lobby's game logic: the hub-hosted game subprocess, or the connected game server for server-hosted lobbies. Results arrive as `gameState`, `gameEvent` and `gameOver`; `gameStarting` signals the game is ready, `gameCrashed` that the subprocess died (the lobby is closed).
Throws `GAME_NOT_RUNNING`, `NOT_IN_LOBBY`, `INVALID_INPUT`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`.

```ts
client.on('gameState', (s) => render(s));
client.on('gameEvent', ({ type, data }) => handle(type, data));
await client.sendGameAction('play-card', { card: 7 });
```

---

## User data

Per-user, per-game key/value storage. Each entry: `UserDataEntry { key, value, visibility, writeScope, version, updatedAt }` (`updatedAt` unix ms). `visibility` ([`DataVisibility`](enums.md#datavisibility)): `private` (default, owner only), `lobby` (visible to lobby mates), `friends` (visible to friends), `public` (a **leaderboard key**: only a game server can write it, clients get `NOT_ALLOWED`; it implies `writeScope: server` and is never returned by `getPlayerData`). `writeScope` ([`DataWriteScope`](enums.md#datawritescope)) is `server` for keys only the game may write (read-only for clients → `DATA_READ_ONLY`).

### Over the socket (requires login; results also arrive as events)

| Method | Description |
|---|---|
| `getUserData(gameId): Promise<UserDataEntry[]>` | Own entries (also emits `userData`). |
| `getPlayerData(playerId, gameId): Promise<UserDataEntry[]>` | Another player's entries you may see: `friends` entries if you are friends, `lobby` entries if you share a lobby (also emits `playerData`). Throws `NOT_ALLOWED` for anyone else (same answer for non-existent users). |
| `setUserData(gameId, key, value, visibility?): Promise<void>` | Set one entry. |
| `bulkSetUserData(gameId, entries: BulkDataEntry[]): Promise<void>` | Atomic batch; `BulkDataEntry = { key, value, visibility? }`. |
| `deleteUserData(gameId, key): Promise<void>` | Delete one entry. |
| `incrementUserData(gameId, key, by, visibility?): Promise<UserDataWriteResult>` | Atomically add `by` to a numeric key (missing = 0); resolves `{ key, value, version }`. `INVALID_INPUT` if the value is not a number. |
| `setUserDataIf(gameId, key, value, expectedVersion, visibility?): Promise<UserDataWriteResult>` | Compare-and-set on `version` (`0` = key must not exist). On mismatch rejects with `VERSION_CONFLICT`; `error.data.current` is `{ value, version }` or `null`. |
| `transactUserData(gameId, ops: UserDataOp[]): Promise<UserDataOpResult[]>` | 1–100 ops (`set`, `increment`, `setIf`, `delete`), all or nothing; one `{ key, value?, version }` per op (`delete` → `version: 0`). |

Throws `UNKNOWN_GAME`, `INVALID_INPUT`, `DATA_READ_ONLY`, `NOT_ALLOWED` (`public` visibility), `VERSION_CONFLICT`, `DATA_QUOTA_EXCEEDED`, `DATA_VALUE_TOO_LARGE`, `RATE_LIMITED`.

```ts
const { value } = await client.incrementUserData('chess', 'coins', 5);
try { await client.setUserDataIf('chess', 'slot', 'sword', 3); }
catch (e) { if (e instanceof EthernalError && e.code === ErrorCode.VersionConflict) console.log(e.data?.current); }
await client.transactUserData('chess', [{ op: 'increment', key: 'coins', by: -5 }, { op: 'set', key: 'item', value: 'sword' }]);
```

### Over REST (works without a game registration)

| Method | Description |
|---|---|
| `setKey(gameId, key, value, visibility?): Promise<void>` | `PUT /userdata/:gameId/:key`. |
| `bulkSet(gameId, entries: BulkDataEntry[]): Promise<void>` | `PATCH /userdata/:gameId` with 1–100 entries, all or nothing. |
| `deleteKey(gameId, key): Promise<void>` | `DELETE`; a missing key is not an error. |
| `getAllData(gameId): Promise<UserDataEntry[]>` | `GET /userdata/:gameId`. |

REST failures are thrown as `EthernalError` carrying the hub's `code` (`HTTP_ERROR` if none). The REST calls use the access token and renew it once on a 401.

```ts
await client.setUserData('chess', 'level', 5);
await client.setKey('chess', 'title', 'Knight', DataVisibility.Friends);
const mine = await client.getAllData('chess');
```

---

## Leaderboard

### `getLeaderboard(gameId, key, options?): Promise<LeaderboardEntry[] | LeaderboardPage>`
Ranks the **public numeric** values of a key (written by a game server). Only games with `serverSupport` ≠ `none` have leaderboards. Ties are ordered by earlier `updatedAt`, so ranks are deterministic. Players with `leaderboardVisible: false` ([`setSocialSettings`](#presence-and-settings)) are omitted, but still see their own rank via `me`.

`options` (`LeaderboardOptions`): `order` (`'asc' | 'desc'`, default `'desc'`), `limit` (1–100, default 10), `offset` (default 0), `me: true` (also return your own row), `around: 'me'` with `range` (1–50, default 5) (window around your rank; the top if you are unranked), `scope: 'all' | 'friends'` (`friends`: only you and your friends).

Without `me`/`around` the result is an array; with them it is a `LeaderboardPage { entries, me: LeaderboardEntry | null, total }`. Throws `INVALID_INPUT`, `RATE_LIMITED`.

```ts
interface LeaderboardEntry { rank: number; userId: string; username: string; value: number; updatedAt: number }
const top = await client.getLeaderboard('chess', 'elo', { limit: 20, offset: 20 });
const { entries, me, total } = await client.getLeaderboard('chess', 'elo', { around: 'me', range: 3 });
const friends = await client.getLeaderboard('chess', 'elo', { scope: 'friends' });
```

---

---

## Social

Friends, presence, notifications, direct messages and lobby invites. Every event has a pull equivalent, so a client can always resynchronise with `syncSocial()`. Friends are only ever addressed by `userId` (or looked up by exact name). See [social-api.md](social-api.md) for the full semantics and limits.

### Friends

| Method | Returns | Throws |
|---|---|---|
| `requestFriendByName(username)` | `FriendRequestResult` — `REQUEST_SENT` or `NO_SUCH_PLAYER` (also for self/blocked/already friends, so names cannot be probed). A pending request from that user is accepted automatically. | `FRIEND_LIMIT_REACHED`, `REQUEST_LIMIT_REACHED`, `RATE_LIMITED` |
| `requestFriendFromLobby(userId)` | `FriendRequestResult` — request a current lobby mate. | `NOT_IN_LOBBY`, `PLAYER_NOT_IN_LOBBY`, limits |
| `respondFriendRequest(requestId, accept)` | `void` | `FRIEND_REQUEST_NOT_FOUND`, `FRIEND_LIMIT_REACHED` |
| `cancelFriendRequest(requestId)` | `void` (your outgoing request) | `FRIEND_REQUEST_NOT_FOUND` |
| `removeFriend(friendId)` | `void` | `NOT_FRIENDS` |
| `listFriends()` | `FriendInfo[]` | |
| `listFriendRequests()` | `{ incoming: FriendRequestInfo[]; outgoing: FriendRequestInfo[] }` | |

Events: `friend:requestReceived`, `friend:requestAccepted`, `friend:requestDeclined` (only if the hub has `FRIEND_SILENT_DECLINE=false`), `friend:requestCancelled`, `friend:removed`.

```ts
const result = await client.requestFriendByName('bob');   // FriendRequestResult.RequestSent | NoSuchPlayer
client.on('friend:requestReceived', async ({ request }) => {
  await client.respondFriendRequest(request.id, true);
});
```

### Presence and settings

| Method | Description |
|---|---|
| `getFriendsPresence(): Promise<FriendPresence[]>` | Friends' presence: `{ userId, username, online, status, gameId?, lobbyJoinable?, lastSeen? }`. Never contains lobby IDs. |
| `getSocialSettings(): Promise<SocialSettings>` | `{ status, showLastSeen, dmReadReceipts, mutedNotificationTypes, … }`. |
| `setSocialSettings(patch: Partial<SocialSettings>): Promise<SocialSettings>` | Patch; `leaderboardVisible` (default `true`) controls whether you appear in leaderboards; `status` is an `OwnPresenceStatus` (`online`/`busy`/`invisible`/…); `invisible` makes you appear offline. `mutedNotificationTypes` takes `NotificationType` values. Throws `INVALID_INPUT`. |
| `syncSocial(etag?): Promise<SocialSnapshot \| { notModified: true; etag: string }>` | Full snapshot (settings, friends, presence, requests, invites, unread counts, conversations) or `notModified` when `etag` still matches. |
| `getFriendLobby(friendId): Promise<FriendLobbyInfo \| null>` | The friend's lobby (`null` if none): `{ lobbyId?, name, players, slots, joinable, locked, hasInvite }`. `lobbyId` is omitted for private lobbies. Throws `NOT_FRIENDS`. |

Event: `friend:presence` (`FriendPresence`) — pushed to friends whenever status/online/game/joinability changes.

### Notifications

Persistent, collapsed notifications (types: [`NotificationType`](enums.md#notificationtype)): friend requests/accepts, DMs (only when you are offline), lobby invites, and `friend_online` — sent to **online friends** when a friend comes online (suppressed if the friend is invisible or you muted that type).

| Method | Description |
|---|---|
| `listNotifications(opts?): Promise<NotificationListResult>` | `opts: { since?, unreadOnly?, limit?, cursor? }` → `{ notifications, nextCursor? }`. |
| `markNotificationsRead({ ids?, upTo? }): Promise<{ marked: number; unread: number }>` | Mark by id or everything created up to a timestamp. Throws `INVALID_INPUT` if neither is given. |
| `getNotificationCounts(): Promise<NotificationCounts>` | `{ unread, byType }`. |

Events: `notification` (`HubNotification { id, type, payload, createdAt, expiresAt, read? }`) live, and `notification:backlog` (`{ unreadCount, latest }`) once after every connect.

```ts
client.on('notification', (n) => {
  if (n.type === NotificationType.FriendOnline) toast(`${n.payload.username} is online`);
});
```

### Direct messages (friends only)

| Method | Returns | Throws |
|---|---|---|
| `sendDirectMessage(toUserId, text)` | `DirectMessage { id, from, to, text, seq, sentAt }` | `NOT_FRIENDS`, `INVALID_INPUT` (empty), `MESSAGE_TOO_LONG`, `RATE_LIMITED` |
| `getDmHistory(withUserId, opts?: { before?, limit? })` | `DmHistoryResult { messages, nextBefore?, lastReadSeq, firstUnreadSeq?, unreadCount, peerLastReadSeq? }` — oldest first; page backwards with `before = nextBefore`. Read fields describe the current state; does not mark anything read. | `NOT_FRIENDS` |
| `openDmConversation(withUserId, limit?)` | `DmHistoryResult` with the last `limit` (default 10, max 100) messages. `lastReadSeq` / `firstUnreadSeq` / `unreadCount` are the state **before** opening (draw the "new messages" divider at `firstUnreadSeq`); afterwards the hub marks everything read. `peerLastReadSeq` = how far the friend read your messages (omitted if they disabled read receipts). | `NOT_FRIENDS`, `INVALID_INPUT` |
| `getDmUnread()` | `DmUnreadResult { conversations: DmConversationUnread[], totalUnread }` — chats with unread DMs (`{ withUserId, unreadCount, firstUnreadSeq, lastSeq, lastMessageAt }`) and the app-badge total, no events. | |
| `listConversations()` | `DmConversation[]` — `{ withUserId, username, unreadCount, lastReadSeq, lastMessage }` | |
| `markConversationRead(withUserId, upToSeq?)` | `DmReadState { withUserId, marked, lastReadSeq, unreadCount, totalUnread }` — marks messages up to `upToSeq` (default: all) read; `marked` = newly read. | `NOT_FRIENDS`, `INVALID_INPUT` |
| `sendTyping(toUserId)` | `void` — typing indicator | `NOT_FRIENDS` |

Events: `dm:received` (`DirectMessage`), `dm:delivered` (`{ byUserId, messageIds }`, for messages sent while the recipient was offline, when they come back), `dm:read` (`{ byUserId, upToSeq }`, suppressed when the reader disabled `dmReadReceipts`), `dm:readState` (`DmReadState`, `marked` is 0 — the read cursor advanced; also delivered to your other sessions so every device clears its badge), `dm:typing` (`{ fromUserId }`).

### Lobby invites and joining friends

| Method | Returns | Throws |
|---|---|---|
| `inviteFriend(friendId)` | `LobbyInvite { inviteId, lobbyId, lobbyName, gameId, fromUserId, fromUsername, expiresAt }` | `NOT_IN_LOBBY`, `NOT_FRIENDS`, `FRIEND_OFFLINE`, `GAME_MISMATCH`, `NOT_HOST` (host-only invites), `RATE_LIMITED` |
| `cancelLobbyInvite(inviteId)` | `void` | `INVITE_NOT_FOUND` |
| `acceptLobbyInvite(inviteId)` | `Lobby` — joins, also private/locked lobbies | `INVITE_NOT_FOUND`, `LOBBY_FULL`, `LOBBY_CLOSED`, `ALREADY_IN_LOBBY` |
| `declineLobbyInvite(inviteId)` | `void` | `INVITE_NOT_FOUND` |
| `listLobbyInvites()` | `LobbyInvite[]` (still valid, incoming) | |
| `joinFriend(friendId)` | `{ pending: boolean; lobby?: Lobby }` — joins directly if possible; for a locked lobby a join request is filed (`pending: true`, result via `joinRequestAccepted`/`joinRequestRejected`). | `NOT_FRIENDS`, `FRIEND_NOT_IN_LOBBY`, `LOBBY_PRIVATE`, `LOBBY_FULL`, `GAME_MISMATCH` |

Events: `lobby:inviteReceived` (`LobbyInvite`), `lobby:inviteCancelled` (`{ inviteId, lobbyId, reason }`, `reason` is a [`LobbyInviteCancelReason`](enums.md#lobbyinvitecancelreason)), `lobby:inviteDeclined` (`{ inviteId, userId }`).

```ts
client.on('lobby:inviteReceived', async (inv) => { if (await ask(`${inv.fromUsername} invites you`)) await client.acceptLobbyInvite(inv.inviteId); });
const { pending, lobby } = await client.joinFriend(friendId);
```

---

## Blocks

Harassment protection: a block is private and never visible to the blocked user.

| Method | Description |
|---|---|
| `blockUser(userId): Promise<BlockedUserInfo>` | Idempotent. Ends the friendship, drops pending requests and invites in both directions; later friend requests from that user are silently ignored (they still see `REQUEST_SENT`). Throws `CANNOT_TARGET_SELF`, `USER_NOT_FOUND`, `BLOCK_LIMIT_REACHED`. |
| `unblockUser(userId): Promise<void>` | Idempotent; the friendship is not restored. |
| `getBlockedUsers(): Promise<BlockedUserInfo[]>` | `BlockedUserInfo { userId, username, blockedAt }`. |

---

## Account

| Method | Description |
|---|---|
| `changePassword(currentPassword, newPassword): Promise<AuthResult>` | Revokes all other sessions and refresh tokens (other sockets get `session:replaced` with reason `password_changed`); this session stays connected and the SDK stores the returned fresh tokens. Throws `INVALID_CREDENTIALS`, `INVALID_INPUT`, `RATE_LIMITED`. |
| `deleteAccount(password): Promise<void>` | Permanently deletes the account and all its data (GDPR), then clears the local session. Throws `INVALID_CREDENTIALS`, `RATE_LIMITED`. |
| `exportAccountData(): Promise<AccountExport>` | Everything the hub stores about you: `profile`, `userData`, `friends`, `messages`, `notifications`, `settings`, `blocks`. |

---

## GameServerClient (game-server SDK)

`GameServerClient` is the server-side counterpart for games with `serverSupport` `optional`/`required`: a service (not a player) that runs the authoritative logic of **many lobbies**. Protocol details: [game-server-protocol.md](game-server-protocol.md). Players opt in with `createLobby({ serverPreference })`.

```ts
import { GameServerClient, LobbyAssignReason } from '@ethernal/client';

const gs = new GameServerClient({
  serverUrl: 'http://localhost:12346', serverKey: process.env.SERVER_KEY!,   // key from POST /admin/game-servers/:gameId/keys
  gameId: 'chess', serverId: 'eu-1', capacity: 20, region: 'eu',
  onAssign: async ({ lobby, reason, previousServerId, lostAt }) => {
    if (reason === LobbyAssignReason.ServerRebound) await restore(lobby.id);   // takeover of a lost server's lobby
    return true;                                                               // or false / { accept: false, reason: 'busy' }
  },
});
gs.on('player:action', async ({ lobbyId, userId, type, payload }) => {
  await gs.sendState(lobbyId, applyAction(lobbyId, userId, type, payload));
});
const hello = await gs.connect();            // hello.resumed / hello.lobbies after a reconnect within the grace period
await gs.incrementUserData(lobbyId, userId, 'wins', 1, { visibility: 'public' });   // leaderboard key
await gs.drain();                            // before shutdown: no new lobbies, running ones continue
```

**Options** (`GameServerClientOptions`): `serverUrl`, `serverKey`, `gameId`, `serverId` (stable instance ID: reconnecting with it within `SERVER_RESUME_GRACE_MS` resumes the lobbies; a second connection with it replaces the first), `capacity`, `region?`, `version?`, `requestTimeout?` (default 5000), `onAssign?` (accept every assignment if omitted).

**Assignment**: the hub sends `lobby:assigned` and waits `SERVER_ASSIGN_TIMEOUT_MS` (default 5 s) for the answer. `LobbyAssignment = AssignInfo & { lobby, players }`, where `AssignInfo { reason: LobbyAssignReason; previousServerId?; lostAt? }`: `new_lobby` = fresh lobby, `server_rebound` = takeover of a lobby whose previous server was lost (`previousServerId`, `lostAt` set; the hub holds no game state, restore it from your storage by `lobby.id`). `onAssign` returns `true`/`false`/`{ accept, reason? }`; a throwing handler rejects. `gs.lobbies` is the `Map` of lobbies currently served.

**Methods** (all reject with `EthernalError`; lobbies not assigned to this server fail with `NOT_LOBBY_SERVER`):

| Method | Description |
|---|---|
| `connect(): Promise<GameServerHello>` | Connect to `/gameserver`, resolve on `hello { serverId, gameId, resumed, lobbies }`. Reconnects automatically. Throws `INVALID_SERVER_KEY`, `UNKNOWN_GAME`, `GAME_SERVER_NOT_ALLOWED`, `INVALID_INPUT`, `RATE_LIMITED` (`retryAfterMs`), `TIMEOUT`. |
| `disconnect(): void` | Close; connect again with the same `serverId` within the grace period to resume. |
| `isConnected(): boolean` | Socket state. |
| `sendToLobby(lobbyId, type, payload?): Promise<number>` | Relay to all members (sender `server`); resolves the `seq`. |
| `sendToPlayer(lobbyId, userId, type, payload?): Promise<number>` | Relay to one member (`PLAYER_NOT_IN_LOBBY`). |
| `sendState(lobbyId, state, toUserId?): Promise<void>` | Members (or one player) receive `gameState`. |
| `kickPlayer(lobbyId, userId, reason?): Promise<void>` | Player gets `playerKicked { lobbyId, reason? }`; they cannot rejoin (`KICKED_FROM_LOBBY`) until the host unkicks. |
| `setLobbyState(lobbyId, 'in_progress' \| 'closed'): Promise<Lobby>` | Change the lobby status (`INVALID_STATE`). |
| `setLobbySettings(lobbyId, settings): Promise<Lobby>` | Replace settings (`SETTINGS_TOO_LARGE`); members get `lobbyUpdated` (`settings_changed`). |
| `gameOver(lobbyId, result?): Promise<void>` | Members receive `gameOver`; the lobby closes. |
| `closeLobby(lobbyId): Promise<void>` | Close without a result. |
| `updateStatus({ draining?, capacity? }): Promise<GameServerInfo>` | Report status; resolves the hub's view (`load`, `draining`, …). |
| `drain()` / `undrain(): Promise<GameServerInfo>` | Stop/resume receiving new lobbies; running lobbies keep their server (`lobbyUpdated` reason `server_draining`). |
| `heartbeat(): Promise<GameServerInfo>` | Application-level liveness round trip (socket.io ping/pong runs on its own). |
| `setUserData(lobbyId, userId, key, value, { visibility?, writeScope? }?): Promise<void>` | Authoritative write; `visibility: 'public'` makes a leaderboard key, `writeScope: 'server'` locks it for clients. |
| `bulkSetUserData(lobbyId, userId, entries: GameServerDataEntry[]): Promise<void>` | 1–100 entries, all or nothing. |
| `getUserData(lobbyId, userId): Promise<UserDataEntry[]>` | All of the player's entries for the game. |
| `incrementUserData(lobbyId, userId, key, by, options?): Promise<GameServerWriteResult>` | Atomic counter; resolves `{ key, value, version }`. |
| `setUserDataIf(lobbyId, userId, key, value, expectedVersion, options?): Promise<GameServerWriteResult>` | Compare-and-set (`VERSION_CONFLICT`, `error.data.current`). |
| `transactUserData(lobbyId, userId, ops: UserDataOp[]): Promise<UserDataOpResult[]>` | All-or-nothing `set`/`increment`/`setIf`/`delete`. |

Data writes require `userId` to be a current or former member of a lobby bound to this server (up to 60 s after it closed), otherwise `NOT_ALLOWED`.

**Events** (`GameServerClientEvents`, via `gs.on(...)`):

| Event | Payload |
|---|---|
| `hello` | `GameServerHello` — after every (re)connect; `resumed` tells whether the hub still knew this `serverId`. |
| `lobby:assigned` | `(assignment: LobbyAssignment, accepted: boolean)` — emitted after your answer. |
| `lobby:updated` | `{ lobby, reason? }` ([`LobbyChangeReason`](enums.md#lobbychangereason)) |
| `lobby:closed` | `{ lobbyId, reason }` ([`LobbyClosedReason`](enums.md#lobbyclosedreason)) |
| `player:joined` | `{ lobbyId, userId, username }` |
| `player:left` | `{ lobbyId, userId, reason }` ([`PlayerLeftReason`](enums.md#playerleftreason)) |
| `player:disconnected` / `player:reconnected` | `{ lobbyId, userId }` |
| `player:action` | `{ lobbyId, userId, type, payload }` — a player's `sendGameAction`. |
| `connected` / `disconnected` | Lifecycle; `disconnected` carries the reason. |
| `connectError` | `EthernalError` for a refused (re)connect (`INVALID_SERVER_KEY`, `RATE_LIMITED` …). |

Types: `GameServerClientOptions`, `GameServerClientEvents`, `GameServerHello`, `GameServerWriteOptions`, `GameServerWriteResult`, `GameServerInfo`, `GameServerPlayer`, `GameServerDataEntry`, `AssignInfo`, `AssignDecision`, `LobbyAssignment`.

---

## Events

`EthernalClient` extends `EventEmitter`; `on`, `once` and `off` are typed through `EthernalClientEvents` (event name → argument tuple), so listener parameters are inferred. Unknown event names are still accepted (untyped).

```ts
import type { EthernalClientEvents } from '@ethernal/client';
client.on('lobbyUpdated', (lobby, reason) => {});   // lobby: Lobby, reason?: LobbyChangeReason
```

### Connection lifecycle

| Event | Payload | When |
|---|---|---|
| `connected` | — | Socket (re)connected. |
| `disconnected` | `reason: string` | Socket lost or `disconnect()`/`logout()` called. The SDK reconnects automatically (not after logout/`disconnect()`). |
| `authError` | `message: string` | The token could not be renewed / the hub rejected the socket. |
| `connectError` | `EthernalError` | The hub refused a (re)connect with a coded error, typically `RATE_LIMITED` with `retryAfterMs`. During `login()`/`register()` the promise rejects with the same error instead of retrying silently. |
| `serverError` | `message: string` | Legacy text error from the hub (the socket's `error` event is renamed to avoid EventEmitter's reserved name). |
| `errorDetail` | `HubErrorPayload { code, message, retryAfterMs? }` | **Unsolicited** structured errors (e.g. `AUTH_EXPIRED`). Errors answering your calls reject the promise instead and are not emitted. |
| `hello` | `HelloPayload { protocolVersion, serverTime, sessionId, capabilities, gameId?, lobbyId? }` | After every successful connect. |
| `session:resumed` | `{ state: SessionState; lobby: Lobby }` | A held lobby seat was resumed. |
| `session:replaced` | `{ reason: SessionReplacedReason }` | A newer session of this user replaced this one (the socket is closed). |

### Lobby and game

| Event | Payload |
|---|---|
| `lobbyCreated` | `Lobby` (confirmation for the host) |
| `lobbyUpdated` | `(lobby: Lobby, reason?: LobbyChangeReason)` |
| `lobbyList` | `Lobby[]` (also answers `listLobbies`) |
| `lobbyInfo` | `Lobby` (also answers `getLobbyInfo`) |
| `playerKicked` | `{ lobbyId, reason? }` — you were removed by the host (or the game server); rejoining fails with `KICKED_FROM_LOBBY` |
| `gameStarting` | `{ lobbyId, gameId }` |
| `gameState` | `unknown` — state pushed by the game |
| `gameEvent` | `{ type: string; data: unknown }` |
| `gameOver` | `unknown` — result |
| `gameCrashed` | `{ lobbyId, code: number \| null }` |
| `message` | `RelayMessage` |
| `messageBinary` | `RelayBinaryMessage` |
| `joinRequestReceived` | `{ lobbyId, requesterId, username, expiresAt }` (host) |
| `joinRequestPending` | `{ lobbyId, expiresAt }` |
| `joinRequestAccepted` | `{ lobby: Lobby }` |
| `joinRequestRejected` | `{ lobbyId, reason: JoinRequestRejectReason }` |
| `joinRequestWithdrawn` | `{ lobbyId, requesterId, reason: JoinRequestWithdrawReason }` (host; for `cancelled` also the requester's sessions) |

### Data and social

| Event | Payload |
|---|---|
| `userData` | `{ gameId, entries: UserDataEntry[] }` |
| `playerData` | `{ playerId, gameId, entries: UserDataEntry[] }` |
| `friend:presence` | `FriendPresence` |
| `friend:requestReceived` | `{ request: FriendRequestInfo }` |
| `friend:requestAccepted` | `{ friend: FriendInfo; requestId? }` |
| `friend:requestDeclined` | `{ requestId, user: FriendInfo }` |
| `friend:requestCancelled` | `{ requestId }` |
| `friend:removed` | `{ userId }` |
| `notification` | `HubNotification` |
| `notification:backlog` | `NotificationBacklog { unreadCount, latest }` |
| `dm:received` | `DirectMessage` |
| `dm:delivered` | `{ byUserId, messageIds }` |
| `dm:read` | `{ byUserId, upToSeq }` |
| `dm:readState` | `DmReadState` |
| `dm:typing` | `{ fromUserId }` |
| `lobby:inviteReceived` | `LobbyInvite` |
| `lobby:inviteCancelled` | `{ inviteId, lobbyId, reason: LobbyInviteCancelReason }` |
| `lobby:inviteDeclined` | `{ inviteId, userId }` |

---

## Errors

Every call rejects with `EthernalError { name, message, code, retryAfterMs?, data? }`. `retryAfterMs` is set for `RATE_LIMITED` (REST, socket acks and a rate-limited socket handshake); `data` carries extra details, e.g. `VERSION_CONFLICT` → `data.current`. Compare `code` with the exported `ErrorCode` constants; `message` is for display only. The SDK adds three client-side codes: `TIMEOUT` (no answer within `requestTimeout`), `NOT_CONNECTED` (no live socket) and `HTTP_ERROR` (REST error without a hub code). For `RATE_LIMITED`, `retryAfterMs` says when to retry.

```ts
try {
  await client.joinLobby(id);
} catch (e) {
  if (!(e instanceof EthernalError)) throw e;
  switch (e.code) {
    case ErrorCode.LobbyFull: showFull(); break;
    case ErrorCode.LobbyLocked: await client.requestJoinLobby(id); break;
    case ErrorCode.RateLimited: await sleep(e.retryAfterMs ?? 1000); break;
    case 'TIMEOUT': retry(); break;
  }
}
```

All hub codes are listed in [enums.md](enums.md#errorcode).

---

## Enums

Wire enums are exported as **const objects with a same-named type**: use them as values (`LobbyChangeReason.ServerRebound === 'server_rebound'`) and as types (`reason: LobbyChangeReason`). The wire values are plain strings. Details and values: [enums.md](enums.md).

`LobbyStatus`, `LobbyChangeReason`, `LobbyServerStatus`, `ServerSupport`, `LobbyAssignReason`, `LobbyClosedReason`, `PlayerLeftReason`, `SessionReplacedReason`, `JoinRequestRejectReason`, `JoinRequestWithdrawReason`, `DataVisibility`, `DataWriteScope`, `FriendRequestSource`, `FriendRequestResult`, `OwnPresenceStatus`, `FriendPresenceStatus`, `LobbyInviteCancelReason`, `NotificationType`, `ErrorCode`.

---

## Types

Exported types: `EthernalClientOptions`, `EthernalClientEvents`, `CreateLobbyOptions`, `RelaySendOptions`, `AuthResult`, `LeaderboardEntry`, `LeaderboardOptions`, `LeaderboardPage`, `UserDataWriteResult`, `UserDataOp`, `UserDataOpResult`, `UserDataConflict`, `BlockedUserInfo`, `AccountExport`, `BinaryPayload`, `Lobby`, `UserDataEntry`, `BulkDataEntry`, `RelayMessage`, `RelayBinaryMessage`, `HubErrorPayload`, `GameInfo`, `SessionState`, `HelloPayload`, `FriendInfo`, `FriendRequestInfo`, `FriendRequestsResult`, `FriendPresence`, `SocialSettings`, `SocialSnapshot`, `HubNotification`, `NotificationBacklog`, `NotificationCounts`, `NotificationListResult`, `DirectMessage`, `DmConversation`, `DmHistoryResult`, `DmReadState`, `DmUnreadResult`, `DmConversationUnread`, `JoinRequestInfo`, `JoinRequestsResult`, `LobbyInvite`, `FriendLobbyInfo`. The definitions live in `shared/src/types/`.
