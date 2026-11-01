# Migration guide: P2 (SDK consumers)

Breaking or behaviour-changing items since P1. Wire strings of enums are unchanged.

## Breaking
- **Node `markConversationRead`** now returns `DmReadState` (was `void`).
- **`public` visibility is server-only.** A client write with `visibility: 'public'` fails with `NOT_ALLOWED`; existing client-written `public` rows were downgraded to `private`. `public` marks a leaderboard key and is written by a game server. New value `friends` is allowed for clients.
- **`getPlayerData`** throws `NOT_ALLOWED` for strangers and for non-existent users (identical, no enumeration) instead of returning an empty list.
- **Leaderboards** exist only for games with `serverSupport != none`. Result is a plain array unless `me`/`around` is used (`{entries, me, total}`). Users can opt out via `SocialSettings.leaderboardVisible`.
- **Tokens** are checked against the DB: password change or account deletion invalidates old tokens (`session_replaced` reason `password_changed`).

## New
- Kick/unkick with `reason`; event `playerKicked`; error `KICKED_FROM_LOBBY`. Kicks are soft (not bans): an invite or `unkickPlayer` clears them.
- Rate limits: `RATE_LIMITED` with `retryAfterMs` (REST: `Retry-After` header; socket: `connect_error` data).
- Data: increment, setIf, transact (`VERSION_CONFLICT` carries `data.current`).
- Blocks: `blockUser`, `unblockUser`, `getBlockedUsers` (harassment protection only; no bans/roles).
- Account: `changePassword`, `deleteAccount`, `exportAccountData`.
- `GameServerClient` in both SDKs; see [game-server-protocol.md](game-server-protocol.md).

## Server operators
New env vars `TRUST_PROXY`, `BLOCKS_MAX`; new `limits.json` sections `restRateLimits.*`, `caps.*`. DB migrations v6–v9 run automatically.

## Not implemented
Leaderboard period resets (tracked as a P3 issue).
