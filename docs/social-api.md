# Social API (friends, presence, notifications, DMs, invites)

Code: `server/src/social/*`. All socket events use the ack protocol (`{ok:true,...}` / `{ok:false,error}`); REST routes live under `/social` (Bearer auth) and share the same per-user rate limits (`socketLimits` keys `friendRequestByName`, `friendRequest`, `friendAction`, `socialRead`, `socialSettings`, `notificationWrite`, `dmSend`, `dmTyping`, `lobbyInvite`, `lobbyInviteAction`, `blockAction`).

**Breaking change:** `presence:list/joined/left` (global presence) were removed. Use `friend:presence` / `presence:friends` (friends only, never contains lobby ids; only `lobbyJoinable`).

## Event ↔ pull parity

| Socket | REST |
|---|---|
| `social:sync` ({etag}) | `GET /social/sync?etag=` (or `If-None-Match`; 304) |
| `friend:request` | `POST /social/friends/requests` {username\|userId} |
| `friend:requests` | `GET /social/friends/requests` |
| `friend:respond` / `friend:cancel` | `POST /social/friends/requests/:id/respond` / `DELETE …/:id` |
| `friend:list` / `friend:remove` | `GET /social/friends` / `DELETE /social/friends/:id` |
| `presence:friends` | `GET /social/presence` |
| `social:getSettings` / `setSettings` | `GET` / `PUT /social/settings` |
| `social:friendLobby` | `GET /social/friends/:id/lobby` |
| `notification:list` / `markRead` / `counts` | `GET /social/notifications` / `POST …/read` / `GET …/counts` |
| `dm:conversations` / `history` / `send` | `GET /social/dm` / `GET /social/dm/:id` / `POST /social/dm/:id` |
| `dm:unread` | `GET /social/dm/unread` |
| `dm:open` | `POST /social/dm/:id/open {limit?}` |
| `dm:markRead {upToSeq?}` | `POST /social/dm/:id/read {upToSeq?}` |
| `lobby:invites` | `GET /social/lobby-invites` |
| `block:add {userId}` / `block:remove {userId}` | `POST /social/blocks {userId}` / `DELETE /social/blocks/:id` |
| `block:list` | `GET /social/blocks` |

Invite actions (`lobby:invite`, `cancelInvite`, `acceptInvite`, `declineInvite`, `joinFriend`) are socket-only. `DELETE /social/data` purges the caller's social data (the same cascade runs on `DELETE /auth/account`; friends then get `friend:removed` with `reason: account_deleted`, see rest-api.md).

Server events: `friend:presence`, `friend:requestReceived/Accepted/Declined/Cancelled`, `friend:removed`, `notification`, `notification:backlog`, `dm:received/delivered/read/readState/typing`, `lobby:inviteReceived/Cancelled/Declined`.

## Direct messages: read cursor and unread state

Every DM has a global ascending `seq`. A chat's **read cursor** (`lastReadSeq`) is the highest incoming `seq` the user has read; everything at or below it is read. See [dm-ui-guide.md](dm-ui-guide.md) for how a UI should use these calls.

- `dm:unread` → `{ conversations: [{ withUserId, unreadCount, firstUnreadSeq, lastSeq, lastMessageAt }], totalUnread }`: only chats with unread messages (pull API for friend-list badges / app badge; also in `social:sync`).
- `dm:open { withUserId, limit? = 10 }` → `DmHistoryResult`: last `limit` messages (oldest first) plus the state *before* opening (`lastReadSeq`, `firstUnreadSeq`, `unreadCount`); the server then marks the chat read and pushes `dm:readState` / `dm:read`.
- `dm:history { withUserId, before?, limit? }` → older pages (`nextBefore`) without changing the read state. The result also has `lastReadSeq`, `firstUnreadSeq`, `unreadCount` and `peerLastReadSeq` (how far the friend has read your messages; absent if the friend disabled `dmReadReceipts`).
- `dm:markRead { withUserId, upToSeq? }` → `DmReadState { withUserId, marked, lastReadSeq, unreadCount, totalUnread }`: moves the cursor up to `upToSeq` (default: everything). Use `upToSeq` when only part of the chat was visible.
- `dm:readState` (server event) → same `DmReadState`, sent to **all sessions of the reader** whenever the cursor moves, so other devices clear their badge. `dm:read { byUserId, upToSeq }` goes to the *sender* (only if the reader has `dmReadReceipts` on).
- The `dm` notification of an offline message is marked read once the chat has no unread messages left.

## Block list

Harassment protection only (no bans or roles). `block:add { userId }` → `{ blocked: { userId, username, blockedAt } }` (idempotent; `CANNOT_TARGET_SELF`, `USER_NOT_FOUND`, `BLOCK_LIMIT_REACHED`). `block:remove { userId }` is idempotent. `block:list` → `{ blocks }`. The list is private and never visible to the blocked user.

- Blocking removes the friendship (both sides get `friend:removed`, exactly like an unfriend; DM history is deleted with it), drops pending friend requests in both directions and cancels lobby invites between the two.
- Presence, DMs, invites and requests are hidden both ways: since only friends see each other, the blocked user is treated like a stranger (`NOT_FRIENDS` for DMs/invites, nothing pushed).
- No information leak: friend requests from the blocked user (by name or as lobby-mate) answer `REQUEST_SENT` and show up in *their* outgoing list, but are never stored for, shown to or notified to the blocker (shadow request). A request the blocker sends towards a blocked user is handled the same way. Cancelling a shadow request emits nothing to the other side.
- Unblocking drops all shadow requests; nothing sent during the block is delivered retroactively and the friendship is not restored.
- Blocking does not prevent being in the same lobby and does not affect game relay.
- Account deletion removes all blocks of and against the user.

## Configuration (env)

`FRIENDS_MAX` (100), `FRIEND_REQUESTS_MAX_OUTGOING` (50), `FRIEND_REQUESTS_MAX_INCOMING` (50), `FRIEND_REQUEST_EXPIRY_DAYS` (30), `FRIEND_SILENT_DECLINE` (true), `FRIEND_NAME_LOOKUP_MIN_MS` (40), `NOTIFICATION_READ_RETENTION_DAYS` (30), `NOTIFICATION_UNREAD_RETENTION_DAYS` (90), `NOTIFICATION_CAP_PER_USER` (500), `NOTIFICATION_BACKLOG_SIZE` (20), `DM_MAX_LENGTH` (1000), `DM_RETENTION_DAYS` (30), `DM_CONVERSATION_CAP` (500), `LOBBY_INVITE_TTL_MS` (300000), `LOBBY_INVITE_BYPASS_LOCK` (true), `SOCIAL_PURGE_INTERVAL_MS` (3600000), `BLOCKS_MAX` (500).
