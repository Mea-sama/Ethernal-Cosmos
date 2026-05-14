/**
 * Ethernal Cosmos — Universal Social Panel
 * TypeScript ambient declarations for `window.EthernalPanel`
 *
 * Add a reference to this file in your game's tsconfig or at the top of any TypeScript file:
 *   /// <reference path="/path/to/panel.d.ts" />
 *
 * Requires <script src="/assets/panel.js"></script> loaded AFTER socket.io CDN.
 */

/** Action button that a game can register into the Social Panel. */
export interface EthernalPanelAction {
  /**
   * Unique identifier used for deduplication and removal.
   * Registering an action with an existing id replaces it.
   */
  id: string;

  /** Button label displayed to the user. */
  label: string;

  /** Optional emoji or icon prepended to the label. */
  icon?: string;

  /**
   * Visual style of the button.
   * - `'default'` — purple accent (default when omitted)
   * - `'danger'`  — red accent, used for destructive actions
   * @default 'default'
   */
  style?: 'default' | 'danger';

  /** Callback invoked when the user clicks the button. Browser-only — never serialised. */
  onClick: () => void;
}

/** Context object passed to `setContext()`. */
export interface EthernalPanelContext {
  /**
   * Game title shown in the panel header below the username.
   * Pass `undefined` or call with no argument to clear the title.
   */
  gameTitle?: string;
}

/** The public API exposed on `window.EthernalPanel` by `/assets/panel.js`. */
export interface EthernalPanelAPI {
  /** Open the Social Panel slide-in. Connects the panel socket if not already connected. */
  open(): void;

  /** Close the Social Panel. */
  close(): void;

  /** Toggle open/closed state. */
  toggle(): void;

  /**
   * Set the current lobby context.
   * The panel will subscribe to `lobbyUpdated` events for this lobby and show
   * live lobby information (players, invite code, game name) in the Lobby section.
   *
   * @param lobbyId - ID of the lobby to track, or `null` to clear the lobby section.
   */
  setLobby(lobbyId: string | null): void;

  /**
   * Set game-level context shown in the panel header.
   *
   * @param context - Object with optional `gameTitle` string.
   *
   * @example
   * window.EthernalPanel?.setContext({ gameTitle: 'Chess' });
   */
  setContext(context: EthernalPanelContext): void;

  /**
   * Register a game-specific action button in the "Game Actions" section.
   * If an action with the same `id` already exists it is replaced in-place.
   *
   * @param action - Action descriptor including label, optional icon, style, and onClick callback.
   *
   * @example
   * window.EthernalPanel?.registerAction({
   *   id: 'leave',
   *   label: 'Leave game',
   *   icon: '🚪',
   *   style: 'danger',
   *   onClick: () => leaveGame(),
   * });
   */
  registerAction(action: EthernalPanelAction): void;

  /**
   * Remove a previously registered action button by id.
   * No-op if the id is not found.
   *
   * @param id - The `id` of the action to remove.
   */
  removeAction(id: string): void;

  /**
   * Remove all game-specific action buttons.
   * Call this when transitioning back to a menu/lobby state.
   */
  clearActions(): void;
}

declare global {
  interface Window {
    /**
     * Ethernal Cosmos Social Panel API.
     * Available after `/assets/panel.js` has loaded. Use optional chaining (`?.`)
     * to guard against the panel not being loaded (e.g. during local development
     * without the Hub server).
     *
     * @example
     * window.EthernalPanel?.setContext({ gameTitle: 'My Game' });
     * window.EthernalPanel?.registerAction({ id: 'quit', label: 'Quit', onClick: quit });
     */
    EthernalPanel?: EthernalPanelAPI;
  }
}

/**
 * Custom DOM event dispatched on `window` when the user logs out via the panel.
 *
 * Listen for this to reset your game state:
 * @example
 * window.addEventListener('ethernal:logout', () => {
 *   socket?.disconnect();
 *   showScreen('auth');
 * });
 */
export type EthernalLogoutEvent = CustomEvent<never>;
