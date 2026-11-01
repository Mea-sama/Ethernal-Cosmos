# REST API Reference

Base URL: `https://mea-sama.duckdns.org:12346`  
Local dev: `http://127.0.0.1:12348`

All request and response bodies are JSON (`Content-Type: application/json`).

---

## Authentication

Protected endpoints require a Bearer token in the `Authorization` header:

```
Authorization: Bearer <accessToken>
```

Access tokens expire after **1 hour**. Use `POST /auth/refresh` to obtain a new one before expiry.

---

## Authentication Endpoints

### `POST /auth/register`

Create a new user account.

**Rate limit:** 5 requests / hour per IP

**Request body**

```json
{
  "username": "string",   // 3–32 chars, [a-zA-Z0-9_-]
  "password": "string"    // 8–128 chars
}
```

**Response `201`**

```json
{
  "accessToken":  "eyJ...",
  "refreshToken": "abc123...",
  "user": {
    "id":       "uuid",
    "username": "alice"
  }
}
```

**Error responses**

| Status | `error` | Cause |
|--------|---------|-------|
| `400` | `"Mindestens 3 Zeichen · Nur Buchstaben, Zahlen, - und _"` | Validation failed (message lists each violated rule) |
| `409` | `"Benutzername bereits vergeben"` | Username already taken |
| `429` | `"Zu viele Registrierungsversuche, bitte später erneut versuchen"` | Rate limit exceeded |
| `500` | `"Interner Fehler"` | Server error |

---

### `POST /auth/login`

Authenticate an existing account.

**Rate limit:** 10 requests / 15 minutes per IP

**Request body**

```json
{
  "username": "string",
  "password": "string"
}
```

**Response `200`**

```json
{
  "accessToken":  "eyJ...",
  "refreshToken": "abc123...",
  "user": {
    "id":       "uuid",
    "username": "alice"
  }
}
```

**Error responses**

| Status | `error` | Cause |
|--------|---------|-------|
| `400` | `"Benutzername und Passwort erforderlich"` | Empty fields |
| `401` | `"Benutzername oder Passwort falsch"` | Wrong credentials |
| `429` | `"Zu viele Login-Versuche, bitte in 15 Minuten erneut versuchen"` | Rate limit exceeded |

---

### `POST /auth/refresh`

Exchange a refresh token for a new access token. Implements refresh token rotation — the old refresh token is revoked and a new one is issued.

**Rate limit:** 30 requests / 15 minutes per IP

**Request body**

```json
{
  "refreshToken": "string"
}
```

**Response `200`**

```json
{
  "accessToken":  "eyJ...",
  "refreshToken": "new-token..."
}
```

**Error responses**

| Status | `error` | Cause |
|--------|---------|-------|
| `400` | `"refreshToken erforderlich"` | Missing field |
| `401` | `"REFRESH_TOKEN_REVOKED"` | Token already revoked (possible replay attack) |
| `401` | `"REFRESH_TOKEN_EXPIRED"` | Token older than 30 days |
| `401` | `"INVALID_REFRESH_TOKEN"` | Token not found |

---

### `POST /auth/logout`

Revoke a refresh token. After this call the refresh token cannot be used again. The access token remains valid until it expires (max 1 hour).

**Request body**

```json
{
  "refreshToken": "string"
}
```

**Response `204`** — no body

---

### `POST /auth/password`

Change the password (requires `Authorization: Bearer`). Revokes **all** refresh tokens and invalidates all previously issued access tokens (JWT claim `tv` is checked against the user's token version). Other sockets of the user receive `session:replaced { reason: "password_changed" }` and are disconnected. Rate limited per user (`accountPassword`).

**Request body**

```json
{ "currentPassword": "string", "newPassword": "string (8–128)", "socketId": "optional socket.io id of the calling session, which is not kicked" }
```

**Response `200`** — fresh `AuthResult` (`user`, `accessToken`, `refreshToken`) for the calling session. Errors: `INVALID_CREDENTIALS` (401, wrong current password), `INVALID_INPUT` (400), `RATE_LIMITED` (429).

---

### `DELETE /auth/account`

Permanently delete the account (GDPR). Requires the password in the body (`{ "password": "string" }`) and is rate limited per user (`accountDelete`). Removes: user row, refresh tokens, user data (incl. leaderboard rows and server-written keys), friendships/requests, DMs, notifications, social settings, blocks (of and against the user). The user leaves their lobby (host migration or dissolve; a bound game server gets `player:left` with reason `account_deleted`), friends receive `friend:removed { userId, reason: "account_deleted" }`, all sockets are disconnected.

**Response `204`** — no body. Errors: `INVALID_CREDENTIALS` (401), `INVALID_INPUT` (400), `RATE_LIMITED` (429).

---

### `GET /account/export`

Everything the hub stores about the caller as JSON (`AccountExport`): `profile`, `userData`, `friends` (usernames), `messages` (own sent/received DMs within retention), `notifications`, `settings`, `blocks`. Never contains other users' private data or password hashes. Rate limited (`accountExport`).

---

## User Data

All `/userdata` endpoints require authentication (`Authorization: Bearer <accessToken>`).

**Constraints**
- `gameId`: 1–32 chars, `[a-z0-9-]`
- `key`: 1–64 chars, `[a-zA-Z0-9_.-]`
- `visibility`: one of `"private"`, `"lobby"`, `"friends"`, `"public"` (default: `"private"`; omitting it on an existing key keeps the current one). `"public"` marks a leaderboard key and can only be set by a game server: client writes with it fail with `403 NOT_ALLOWED` (never silently downgraded).

### `GET /userdata/:gameId`

Return all own KV entries for a game.

**Response `200`**

```json
[
  {
    "gameId":    "chess",
    "key":       "wins",
    "value":     42,
    "visibility": "lobby",
    "updatedAt": "2026-05-12T10:00:00.000Z"
  }
]
```

---

### `GET /userdata/:gameId/:key`

Return a single KV entry.

**Response `200`** — single `UserDataEntry` object (same shape as above)

**Response `404`** — `{ "error": "Key nicht gefunden" }`

---

### `PUT /userdata/:gameId/:key`

Create or update a single KV entry.

**Request body**

```json
{
  "value":       "<any JSON value>",
  "visibility":  "lobby"            // optional, default "private" ("public" is server-only)
}
```

**Response `200`** — `{ "ok": true }`

---

### `DELETE /userdata/:gameId/:key`

Delete a single KV entry.

**Response `204`** — no body

---

### `PATCH /userdata/:gameId`

Bulk-create or update up to **100** KV entries in a single request.

**Request body**

A raw JSON array (not wrapped in an object):

```json
[
  { "key": "wins",   "value": 10, "visibility": "lobby" },
  { "key": "losses", "value": 3,  "visibility": "lobby" },
  { "key": "draws",  "value": 1                          }
]
```

**Response `200`** — `{ "ok": true }`

---

### Atomic operations

All run in a single write transaction on the caller's own client-writable keys (`public` → `403 NOT_ALLOWED`, server-scoped keys → `DATA_READ_ONLY`).

| Route | Body | Response `200` |
|---|---|---|
| `POST /userdata/:gameId/:key/increment` | `{ by: number, visibility? }` — missing key counts as 0; existing value must be a number (`INVALID_INPUT`), result must stay within ±2^53−1 | `{ key, value, version }` |
| `POST /userdata/:gameId/:key/setIf` | `{ value, expectedVersion: int ≥ 0, visibility? }` — `0` = key must not exist | `{ key, value, version }` |
| `POST /userdata/:gameId/transact` | `{ ops: [{op:'set'\|'increment'\|'setIf'\|'delete', key, ...}] }` (1–100, all-or-nothing) | `{ results: [{ key, value?, version }] }` (`delete` → `version: 0`) |

Version mismatch: **`409 VERSION_CONFLICT`** with `{ code, error, data: { current: { value, version } | null } }`.

---

## Player Data

### `GET /players/:playerId/data/:gameId`

Return the KV entries of a user that the caller may see:
- **Self:** `private`, `lobby` and `friends` entries
- **Friend:** `friends` entries, plus `lobby` entries while both are in the same lobby of this game
- **Lobby-mate (not a friend):** `lobby` entries
- **Anyone else, including non-existent users:** `403 NOT_ALLOWED` (identical response, no existence leak)

`public` entries are leaderboard keys and are never returned here (see Leaderboard).

**Response `200`** — array of `UserDataEntry`

---

## Leaderboard

### `GET /leaderboard/:gameId/:key`

Return the leaderboard for a `public` (server-written) numeric key. Only games with `serverSupport` ≠ `none` have leaderboards (otherwise `404`). Non-numeric values are excluded. Ties are ordered by earlier `updatedAt`, then `userId`, so ranks are deterministic. Players with the social setting `leaderboardVisible: false` are omitted. Invalid parameters return `400 INVALID_INPUT`.

By default the response is an array of rows with a `rank` (1-based, absolute). With `me=true` or `around=me` it is `{ entries, me, total }` instead.

> Periodic resets (daily/weekly boards) are **not implemented**; use a per-period key (e.g. `score.2025-w01`) written by the game server.

**Query parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `order` | `"asc" \| "desc"` | `"desc"` | Sort direction (desc = highest first) |
| `limit` | `number` | `10` | Max rows returned (1–100) |
| `offset` | `number` | `0` | Rows to skip (≥ 0) |
| `me` | `"true"` | — | Also return own row/rank as `me` (`null` if unranked; works while hidden) |
| `around` | `"me"` | — | Return a window around the caller's rank instead of the top (falls back to the top if unranked) |
| `range` | `number` | `5` | Entries above/below for `around=me` (1–50) |
| `scope` | `"all" \| "friends"` | `"all"` | `friends`: only your friends and yourself (ranks among them) |

**Example**

```
GET /leaderboard/chess/wins?order=desc&limit=5
```

**Response `200`**

```json
[
  { "rank": 1, "userId": "uuid1", "username": "alice", "value": 42, "updatedAt": 1700000000000 },
  { "rank": 2, "userId": "uuid2", "username": "bob",   "value": 38, "updatedAt": 1700000001000 }
]
```

With `me=true`/`around=me`: `{ "entries": [...], "me": { "rank": 7, ... } | null, "total": 120 }`.

---

## Game Registry

### `GET /api/games`

Return all games registered on this Hub — both server-hosted games and external relay-only games.

No authentication required.

**Response `200`**

```json
[
  {
    "id":          "tictactoe",
    "name":        "TicTacToe",
    "description": "Klassisches 3\u00d73 TicTacToe — zwei Spieler, kein Subprocess.",
    "maxPlayers":  2,
    "hosted":      true
  },
  {
    "id":          "my-chess-app",
    "name":        "My Chess App",
    "description": "Externe Schach-App",
    "maxPlayers":  2,
    "hosted":      false
  }
]
```

**Fields**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | The `gameId` used when creating a lobby. Must match exactly. |
| `name` | `string` | Human-readable display name. |
| `description` | `string` | Short description shown in the Hub UI. |
| `maxPlayers` | `number` | Maximum lobby size. Enforced server-side; the client cannot override it. |
| `hosted` | `boolean` | `true` = server-managed game (subprocess or relay with a fixed server-side presence). `false` = external app — the Hub is used only as a communication relay; the game logic runs on the client. |

Note: `hosted: true` games with an `entryScript` also launch a subprocess when the lobby is created. Games without an `entryScript` (including all external games) are pure relay: the Hub passes messages between players but performs no game logic.

---

## Error Response Shape

All error responses use a consistent shape:

```json
{
  "error": "Human-readable error message"
}
```

Status codes follow HTTP conventions:
- `400` — bad request / validation error
- `401` — unauthenticated or invalid credentials
- `403` — forbidden
- `404` — not found
- `409` — conflict (e.g. duplicate username)
- `429` — rate limited (`code: "RATE_LIMITED"`, `retryAfterMs`, `Retry-After` header). `/userdata`, `/players`, `/leaderboard` and `/social` are limited per user (defaults 120/120/60/120 per minute, `limits.json` → `restRateLimits`)
- `500` — internal server error
