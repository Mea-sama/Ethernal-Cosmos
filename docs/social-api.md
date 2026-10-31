# Social API (friends, presence, notifications, DMs, invites)

Code: `server/src/social/*`. All socket events use the ack protocol (`{ok:true,...}` / `{ok:false,error}`); REST routes live under `/social` (Bearer auth) and share the same per-user rate limits (`socketLimits` keys `friendRequestByName`, `friendRequest`, `friendAction`, `socialRead`, `socialSettings`, `notificationWrite`, `dmSend`, `dmTyping`, `lobbyInvite`, `lobbyInviteAction`).

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
| `dm:conversations` / `history` / `send` / `markRead` | `GET /social/dm` / `GET /social/dm/:id` / `POST /social/dm/:id` / `POST …/read` |
| `lobby:invites` | `GET /social/lobby-invites` |

Invite actions (`lobby:invite`, `cancelInvite`, `acceptInvite`, `declineInvite`, `joinFriend`) are socket-only. `DELETE /social/data` purges the caller's social data (cascade hook for account deletion).

Server events: `friend:presence`, `friend:requestReceived/Accepted/Declined/Cancelled`, `friend:removed`, `notification`, `notification:backlog`, `dm:received/delivered/read/typing`, `lobby:inviteReceived/Cancelled/Declined`.

## Configuration (env)

`FRIENDS_MAX` (100), `FRIEND_REQUESTS_MAX_OUTGOING` (50), `FRIEND_REQUESTS_MAX_INCOMING` (50), `FRIEND_REQUEST_EXPIRY_DAYS` (30), `FRIEND_SILENT_DECLINE` (true), `FRIEND_NAME_LOOKUP_MIN_MS` (40), `NOTIFICATION_READ_RETENTION_DAYS` (30), `NOTIFICATION_UNREAD_RETENTION_DAYS` (90), `NOTIFICATION_CAP_PER_USER` (500), `NOTIFICATION_BACKLOG_SIZE` (20), `DM_MAX_LENGTH` (1000), `DM_RETENTION_DAYS` (30), `DM_CONVERSATION_CAP` (500), `LOBBY_INVITE_TTL_MS` (300000), `LOBBY_INVITE_BYPASS_LOCK` (true), `SOCIAL_PURGE_INTERVAL_MS` (3600000).
