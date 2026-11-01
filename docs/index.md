# Ethernal Cosmos — SDK Documentation

Ethernal Cosmos is a multiplayer game platform that provides authentication, lobbies, real-time relay, persistent player data, and a social overlay panel — all shared across games.

---

## Architecture Overview

```
Browser Game (HTML/JS)          Node.js Game Process
┌──────────────────────┐        ┌─────────────────────────┐
│  game code           │        │  game server logic       │
│  + panel.js overlay  │        │  + @ethernal/client SDK  │
└────────┬─────────────┘        └──────────┬──────────────┘
         │  WebSocket (socket.io)           │  WebSocket + REST
         └──────────────┬───────────────────┘
                        ▼
              ┌─────────────────┐
              │  Ethernal Hub   │
              │  (Express +     │
              │   Socket.io)    │
              └─────────────────┘
```

The Hub handles all auth, lobby management, and message relay. Games never communicate with each other directly.

---

## Integration Paths

### Path A — Browser game (HTML/JS, no separate backend)

Used by: TicTacToe, simple turn-based games

1. User logs in via `POST /auth/login` (or your own login UI)
2. Write `ec_token`, `ec_refresh`, `ec_user`, `ec_userId` to `sessionStorage`
3. Add `<script src="/assets/panel.js"></script>` — the Social Panel auto-connects
4. Use `window.EthernalPanel.*` to control the panel overlay
5. Open your own `socket.io` connection with `auth: { token: 'Bearer <ec_token>' }`
6. Use socket events directly (see [Socket Events](socket-events.md))

→ See [Panel API Reference](panel-api.md)

### Path B — Node.js game server (TypeScript/JavaScript backend)

Used by: games with server-side logic, AI opponents, authoritative state

1. `npm install @ethernal/client`
2. Instantiate `EthernalClient`, call `login()` or `register()`
3. Use SDK methods for lobbies, relay, user data, presence

→ See [Node.js SDK Reference](sdk-nodejs.md)

### Path C — C# game server (.NET 8)

Used by: Unity-adjacent tooling, .NET game backends, Windows services

1. Add a project reference to `EthernalCosmos.Client`
2. Instantiate `EthernalClient`, call `LoginAsync()` or `RegisterAsync()`
3. Subscribe to C# events (`LobbyUpdated`, `Message`, etc.)
4. Use SDK methods for lobbies, relay, user data

→ See [C# SDK Reference](sdk-csharp.md)

## Common Concepts

### Authentication

All connections require a JWT access token obtained via `POST /auth/login`. Tokens expire after **1 hour**. A 30-day refresh token is issued alongside and can be exchanged for a new access token via `POST /auth/refresh`.

→ See [REST API Reference](rest-api.md#authentication)

### Lobbies

A lobby groups players for a single game session. It has:
- A unique `id` (UUID)
- A 6-character alphanumeric `inviteCode` for private lobbies
- A `gameId` linking it to a registered game
- A `players` array with connected player info
- An optional `settings` object for game-specific configuration

### User Data (KV Store)

Each game can store arbitrary JSON values per user, per key. Keys have a `visibility`:
- `'private'` — only visible to the owner
- `'lobby'` — visible to players in the same lobby
- `'public'` — leaderboard key: written only by a game server, exposed only via the leaderboard endpoints

→ See [REST API Reference](rest-api.md#user-data)

---

## Pages

| Page | Description |
|------|-------------|
| [Panel API](panel-api.md) | `window.EthernalPanel` browser overlay — for HTML games |
| [Wire enums](enums.md) | Reasons, statuses and error codes used by events and both SDKs |
| [Game-server protocol](game-server-protocol.md) | `/gameserver` namespace: assignment, takeover, failure behaviour |
| [Node.js SDK](sdk-nodejs.md) | `@ethernal/client` TypeScript SDK — for Node.js game servers |
| [C# SDK](sdk-csharp.md) | `EthernalCosmos.Client` .NET 8 SDK — for C# game servers |
| [REST API](rest-api.md) | HTTP endpoints — auth, user data, leaderboard |
| [Socket Events](socket-events.md) | All socket.io events — client→server and server→client |
| [Social API](social-api.md) | Friends, presence, notifications, DMs, invites (socket + REST) |
| [DM / unread UI guide](dm-ui-guide.md) | Read cursor, unread badges, opening a chat: what a UI needs |
| [Server Feature Spec](server-feature-spec.md) | As-is behaviour catalogue (IDs, quirks, gaps, test plan) for matching against requirements |
| [Conformance suite](conformance.md) | `TEST-*` IDs, how to add a conformance test, and the CI gate that keeps spec and tests in sync |

---

## Server URL

All SDK and REST calls target the Hub server. In production:

```
https://mea-sama.duckdns.org:12346
```

For local development (before Caddy):

```
http://127.0.0.1:12348
```
