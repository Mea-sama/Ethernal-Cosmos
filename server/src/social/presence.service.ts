import type { FriendPresence } from '@ethernal/shared';
import { lobbyManager } from '../lobby/lobby.manager';
import { sessionManager } from '../session/session.manager';
import { emitToUser } from './bus';
import { friendHooks, friendIds } from './friends.service';
import { loadSettings, loadSettingsMany, setLastSeen, type SettingsRow } from './settings.service';

/** Wird bei jeder Presence-Neubewertung aufgerufen (z.B. Invite-Abgleich) */
export const presenceListeners: Array<() => void> = [];

function isOnline(userId: string): boolean {
  // Reconnect-Gnadenfrist zählt weiterhin als online
  return sessionManager.isConnected(userId) || sessionManager.isInGrace(userId);
}

/** Presence-Sicht auf einen User; enthält nie eine Lobby-ID. */
export function buildPresence(s: SettingsRow): FriendPresence {
  const visible = isOnline(s.userId) && s.status !== 'invisible';
  const p: FriendPresence = {
    userId: s.userId,
    username: s.username,
    online: visible,
    status: visible ? (s.status as FriendPresence['status']) : 'offline',
  };
  if (visible) {
    const gameId = sessionManager.getGameId(s.userId);
    if (gameId) p.gameId = gameId;
    const lobby = lobbyManager.getLobbyByUserId(s.userId);
    if (lobby) {
      p.lobbyJoinable = !lobby.isPrivate && !lobby.locked && lobby.status === 'open' && lobby.players.length < lobby.maxPlayers;
    }
  } else if (s.showLastSeen && s.lastSeen) {
    p.lastSeen = s.lastSeen;
  }
  return p;
}

export async function presenceOfFriends(userId: string): Promise<FriendPresence[]> {
  const ids = await friendIds(userId);
  const rows = await loadSettingsMany(ids);
  return ids
    .map((id) => rows.get(id))
    .filter((r): r is SettingsRow => !!r)
    .map(buildPresence)
    .sort((a, b) => a.username.localeCompare(b.username));
}

// ─── Fan-out nur an Freunde, koalesziert und dedupliziert ─────────────────────

const pending = new Set<string>();
const wasOnline = new Map<string, boolean>();
const lastSent = new Map<string, string>();

/**
 * Meldet eine mögliche Presence-Änderung. Die Auswertung läuft einen Tick später, damit Session-,
 * Gnadenfrist- und Lobby-Zustand nach dem auslösenden Ereignis vollständig gesetzt sind.
 */
export function presenceChanged(userId: string): void {
  if (pending.has(userId)) return;
  pending.add(userId);
  setImmediate(() => {
    pending.delete(userId);
    for (const l of presenceListeners) l();
    void flush(userId).catch((err) => console.error('[Presence] Fan-out fehlgeschlagen:', err));
  });
}

async function flush(userId: string): Promise<void> {
  const s = await loadSettings(userId);
  if (!s) return;
  const presence = buildPresence(s);
  const online = isOnline(userId);
  if (wasOnline.get(userId) === true && !online) {
    const now = Date.now();
    await setLastSeen(userId, now);
    s.lastSeen = now;
    if (s.showLastSeen && presence.status === 'offline') presence.lastSeen = now;
  }
  wasOnline.set(userId, online);

  const key = JSON.stringify({ ...presence, lastSeen: undefined });
  if (lastSent.get(userId) === key) return;
  lastSent.set(userId, key);
  for (const friendId of await friendIds(userId)) emitToUser(friendId, 'friend:presence', presence);
}

/** Nach einer neuen Freundschaft sehen sich beide sofort (unabhängig von der Deduplizierung). */
async function pushMutual(a: string, b: string): Promise<void> {
  const [sa, sb] = await Promise.all([loadSettings(a), loadSettings(b)]);
  if (sa && sb) {
    emitToUser(b, 'friend:presence', buildPresence(sa));
    emitToUser(a, 'friend:presence', buildPresence(sb));
  }
}
friendHooks.onAdded.push(pushMutual);

/** Weg des Users aus Caches (bei Pruning) */
export function forgetPresenceState(keep: (userId: string) => boolean): void {
  for (const id of [...lastSent.keys()]) {
    if (!keep(id)) {
      lastSent.delete(id);
      wasOnline.delete(id);
    }
  }
}
