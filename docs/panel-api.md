# Panel API — `window.EthernalPanel`

The Social Panel is a Shadow DOM overlay injected by `/assets/panel.js`. It provides:

- User auth status and logout
- Online presence (who's connected right now)
- Live lobby information
- Game-registered action buttons
- Navigation links (Hub, Documentation)

The panel maintains its **own** socket.io connection separate from the game's connection.

---

## Setup

Add **one script tag** after the socket.io CDN in your HTML:

```html
<!-- socket.io must come first -->
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<script src="/assets/panel.js"></script>
```

The panel auto-reads credentials from `sessionStorage` on load. Write these keys after login:

| Key | Type | Description |
|-----|------|-------------|
| `ec_token` | `string` | JWT access token |
| `ec_refresh` | `string` | Refresh token |
| `ec_user` | `string` | Username (display name) |
| `ec_userId` | `string` | User UUID |

```js
sessionStorage.setItem('ec_token',   accessToken);
sessionStorage.setItem('ec_refresh', refreshToken);
sessionStorage.setItem('ec_user',    username);
sessionStorage.setItem('ec_userId',  userId);
```

### TypeScript support

Reference the ambient declaration file to get autocomplete for `window.EthernalPanel`:

```ts
/// <reference path="/assets/panel.d.ts" />
```

Or copy `panel.d.ts` into your project and add it to your `tsconfig.json` includes.

---

## Types

### `EthernalPanelAction`

```ts
interface EthernalPanelAction {
  id:      string;                    // Unique key — re-registering with same id replaces
  label:   string;                    // Button text
  icon?:   string;                    // Optional emoji/icon prepended to label
  style?:  'default' | 'danger';      // Button colour; default = purple, danger = red
  onClick: () => void;                // Callback — browser-only, never serialised
}
```

### `EthernalPanelContext`

```ts
interface EthernalPanelContext {
  gameTitle?: string;   // Shown in panel header under the username
}
```

---

## API Reference

### `open()`

```ts
window.EthernalPanel?.open(): void
```

Opens the panel slide-in. If the panel socket is not connected yet, it connects automatically.

---

### `close()`

```ts
window.EthernalPanel?.close(): void
```

Closes the panel.

---

### `toggle()`

```ts
window.EthernalPanel?.toggle(): void
```

Toggles open/closed state.

---

### `setLobby(lobbyId)`

```ts
window.EthernalPanel?.setLobby(lobbyId: string | null): void
```

Sets the active lobby the panel tracks. The panel subscribes to `lobbyUpdated` events for this lobby and renders the Lobby section (players, invite code, game name).

Pass `null` to clear the lobby section (e.g. after leaving a lobby).

**Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `lobbyId` | `string \| null` | Lobby UUID, or `null` to clear |

**Example**

```js
// After creating/joining a lobby
socket.on('lobbyCreated', (lobby) => {
  lobbyId = lobby.id;
  window.EthernalPanel?.setLobby(lobby.id);
});

// After leaving
function leaveGame() {
  socket.emit('leaveLobby');
  window.EthernalPanel?.setLobby(null);
  window.EthernalPanel?.clearActions();
}
```

---

### `setContext(context)`

```ts
window.EthernalPanel?.setContext(context: EthernalPanelContext): void
```

Sets the game context shown in the panel header.

**Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `context.gameTitle` | `string \| undefined` | Game name shown under the username |

**Example**

```js
// After successful login
window.EthernalPanel?.setContext({ gameTitle: 'TicTacToe' });
```

---

### `registerAction(action)`

```ts
window.EthernalPanel?.registerAction(action: EthernalPanelAction): void
```

Adds a game-specific action button to the "Game Actions" section of the panel. If an action with the same `id` already exists, it is replaced in-place (preserving position).

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action.id` | `string` | ✓ | Unique identifier |
| `action.label` | `string` | ✓ | Button text |
| `action.icon` | `string` | — | Emoji/icon prefix |
| `action.style` | `'default' \| 'danger'` | — | Visual style (default: `'default'`) |
| `action.onClick` | `() => void` | ✓ | Click handler |

**Example**

```js
// When a game session starts
window.EthernalPanel?.clearActions();
window.EthernalPanel?.registerAction({
  id:      'leave',
  label:   'Leave game',
  icon:    '🚪',
  style:   'danger',
  onClick: () => leaveGame(),
});
```

---

### `removeAction(id)`

```ts
window.EthernalPanel?.removeAction(id: string): void
```

Removes a single action button by its `id`. No-op if not found.

**Parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string` | The `id` of the action to remove |

---

### `clearActions()`

```ts
window.EthernalPanel?.clearActions(): void
```

Removes all game-specific action buttons. Call this when returning to a lobby or menu state.

---

## Socials — Presence Status Display

The **Socials** tab in the panel shows all currently online users. Each entry has a colour-coded status label that reflects what the user is doing. The panel resolves game names by fetching the game registry from the Hub.

### Game Registry Fetch

When the panel socket connects, it automatically calls `GET /api/games` and caches the result internally. This gives the panel the display name and `hosted` flag for every registered game ID. No action is needed from your game code.

### Status Labels

| Condition | Label | Colour |
|-----------|-------|--------|
| No `lobbyId` or `gameId` — user is idle on the Hub | **Im Hub** | Grey |
| `hosted: false` — user is in an external app session | **Extern: {game name}** | Pink |
| `hosted: true`, `lobbyStatus: 'open'`, other user | **Wartet auf Mitspieler** | Blue + **Beitreten** button |
| `hosted: true`, `lobbyStatus: 'open'`, yourself | **Wartet auf Mitspieler** | Blue (no join button) |
| `hosted: true`, `lobbyStatus: 'full'` or `'closed'` | **Im Spiel: {game name}** | Green |

### Join Button

A **Beitreten** (Join) button appears next to users in an open hosted lobby. Clicking it emits `joinLobby` with the user's `lobbyId`. The button is disabled with `"..."` while the request is in flight to prevent double-clicks. If the join fails (e.g. lobby became full just before clicking), the server sends an `error` event and the panel shows it as a toast notification.

### Toast Notifications

Errors from the Hub (e.g. lobby full, join rejected) are shown as a temporary toast inside the panel's Shadow DOM. It disappears automatically after 3 seconds.

### Live Updates

Presence data updates automatically in real-time via `presence:joined` and `presence:left` events. The panel also listens for `lobbyUpdated` events to refresh the `lobbyStatus` of all users in the affected lobby — so if a lobby transitions from `'open'` to `'full'`, the join button disappears without a full re-fetch.

---

## `ethernal:logout` Event

When the user logs out via the panel, a `CustomEvent` named `'ethernal:logout'` is dispatched on `window`. Listen for this to reset your game state:

```js
window.addEventListener('ethernal:logout', () => {
  // Disconnect your game's socket
  socket?.disconnect();
  socket = null;

  // Reset game state
  lobbyId = null;
  gameActive = false;

  // Return to login screen
  showScreen('auth');
});
```

The event has no `detail` payload.

---

## Complete Minimal Integration

```html
<!DOCTYPE html>
<html>
<head>
  <title>My Game</title>
</head>
<body>
  <!-- your game UI -->

  <!-- 1. Load socket.io, then the panel -->
  <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
  <script src="/assets/panel.js"></script>

  <script>
    const HUB = location.origin;
    let socket = null;

    // 2. After login — write sessionStorage, then call setContext
    async function onLoginSuccess(accessToken, refreshToken, userId, username) {
      sessionStorage.setItem('ec_token',   accessToken);
      sessionStorage.setItem('ec_refresh', refreshToken);
      sessionStorage.setItem('ec_user',    username);
      sessionStorage.setItem('ec_userId',  userId);

      window.EthernalPanel?.setContext({ gameTitle: 'My Game' });

      socket = io(HUB, { auth: { token: 'Bearer ' + accessToken } });
    }

    // 3. Track lobby in the panel
    socket?.on('lobbyCreated', (lobby) => {
      window.EthernalPanel?.setLobby(lobby.id);
    });

    // 4. Register game actions when a match starts
    function onGameStart() {
      window.EthernalPanel?.clearActions();
      window.EthernalPanel?.registerAction({
        id:      'leave',
        label:   'Leave game',
        icon:    '🚪',
        style:   'danger',
        onClick: leaveGame,
      });
    }

    // 5. Clean up when leaving
    function leaveGame() {
      socket?.emit('leaveLobby');
      window.EthernalPanel?.setLobby(null);
      window.EthernalPanel?.clearActions();
    }

    // 6. Handle panel-triggered logout
    window.addEventListener('ethernal:logout', () => {
      socket?.disconnect();
      socket = null;
      showScreen('auth');
    });
  </script>
</body>
</html>
```
