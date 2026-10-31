import { v4 as uuidv4 } from 'uuid';
import type { FriendLobbyInfo, Lobby, LobbyInvite, LobbyInviteCancelReason } from '@ethernal/shared';
import { HubError } from '../errors';
import { lobbyManager } from '../lobby/lobby.manager';
import { afterJoin, startJoinRequest } from '../lobby/lobby.socket';
import { sessionManager } from '../session/session.manager';
import { socialConfig } from './config';
import { emitToUser, getSocialIo } from './bus';
import { assertFriends, friendHooks } from './friends.service';
import { dropNotifications, notify } from './notifications.service';
import { loadSettings } from './settings.service';
import { presenceListeners } from './presence.service';

interface Invite extends LobbyInvite {
  toUserId: string;
  timer: NodeJS.Timeout;
}

const invites = new Map<string, Invite>();
const inviteKey = (id: string): string => `lobby_invite:${id}`;

const toPublic = ({ toUserId: _to, timer: _t, ...pub }: Invite): LobbyInvite => pub;

function requireOwnGame(userId: string): string {
  const gameId = sessionManager.getGameId(userId);
  if (!gameId) throw new HubError('GAME_NOT_REGISTERED');
  return gameId;
}

async function removeInvite(inv: Invite, reason: LobbyInviteCancelReason, notifyInvitee = true): Promise<void> {
  if (!invites.delete(inv.inviteId)) return;
  clearTimeout(inv.timer);
  await dropNotifications(inv.toUserId, inviteKey(inv.inviteId));
  if (!notifyInvitee) return;
  emitToUser(inv.toUserId, 'lobby:inviteCancelled', { inviteId: inv.inviteId, lobbyId: inv.lobbyId, reason });
  await notify(inv.toUserId, 'lobby_invite_cancelled', {
    inviteId: inv.inviteId,
    lobbyId: inv.lobbyId,
    fromUserId: inv.fromUserId,
    reason,
  });
}

function activeInvite(lobbyId: string, toUserId: string): Invite | undefined {
  const now = Date.now();
  for (const inv of invites.values()) if (inv.lobbyId === lobbyId && inv.toUserId === toUserId && inv.expiresAt > now) return inv;
  return undefined;
}

export async function createInvite(userId: string, friendId: string): Promise<LobbyInvite> {
  const lobby = lobbyManager.getLobbyByUserId(userId);
  if (!lobby) throw new HubError('NOT_IN_LOBBY');
  await assertFriends(userId, friendId);
  if (lobby.settings.inviteHostOnly === true && lobby.hostId !== userId) throw new HubError('NOT_HOST');
  if (lobby.status === 'closed') throw new HubError('LOBBY_CLOSED');
  if (lobby.players.length >= lobby.maxPlayers) throw new HubError('LOBBY_FULL');

  const friend = await loadSettings(friendId);
  if (!friend || friend.status === 'invisible' || !sessionManager.hasGameSession(friendId)) throw new HubError('FRIEND_OFFLINE');
  if (sessionManager.getGameId(friendId) !== lobby.gameId) throw new HubError('GAME_MISMATCH');
  if (lobby.players.some((p) => p.userId === friendId)) throw new HubError('ALREADY_IN_LOBBY');

  const existing = activeInvite(lobby.id, friendId);
  if (existing) return toPublic(existing);

  const me = await loadSettings(userId);
  const inviteId = uuidv4();
  const expiresAt = Date.now() + socialConfig.inviteTtlMs;
  const timer = setTimeout(() => {
    const inv = invites.get(inviteId);
    if (inv) void removeInvite(inv, 'expired');
  }, socialConfig.inviteTtlMs);
  timer.unref();
  const inv: Invite = {
    inviteId,
    lobbyId: lobby.id,
    lobbyName: lobby.name,
    gameId: lobby.gameId,
    fromUserId: userId,
    fromUsername: me?.username ?? '',
    expiresAt,
    toUserId: friendId,
    timer,
  };
  invites.set(inviteId, inv);
  const pub = toPublic(inv);
  emitToUser(friendId, 'lobby:inviteReceived', pub);
  await notify(friendId, 'lobby_invite', { ...pub }, { key: inviteKey(inviteId), expiresAt });
  return pub;
}

function findOwn(userId: string, inviteId: string, role: 'to' | 'from'): Invite {
  const inv = invites.get(String(inviteId));
  if (!inv || inv.expiresAt <= Date.now() || (role === 'to' ? inv.toUserId : inv.fromUserId) !== userId) {
    throw new HubError('INVITE_NOT_FOUND');
  }
  return inv;
}

export async function cancelInvite(userId: string, inviteId: string): Promise<void> {
  await removeInvite(findOwn(userId, inviteId, 'from'), 'cancelled');
}

export async function declineInvite(userId: string, inviteId: string): Promise<void> {
  const inv = findOwn(userId, inviteId, 'to');
  await removeInvite(inv, 'cancelled', false);
  emitToUser(inv.fromUserId, 'lobby:inviteDeclined', { inviteId: inv.inviteId, userId });
}

async function joinWithInvite(userId: string, inv: Invite): Promise<Lobby> {
  const io = getSocialIo();
  if (!io) throw new HubError('INTERNAL');
  const gameId = requireOwnGame(userId);
  if (gameId !== inv.gameId) throw new HubError('GAME_MISMATCH');
  const username = (await loadSettings(userId))?.username ?? '';
  const lobby = lobbyManager.joinLobby(userId, username, inv.lobbyId, {
    gameId,
    viaCode: true,
    bypassLock: socialConfig.inviteBypassLock,
  });
  afterJoin(io, userId, username, lobby);
  for (const other of [...invites.values()]) {
    if (other.toUserId === userId && other.lobbyId === inv.lobbyId) await removeInvite(other, 'cancelled', other !== inv);
  }
  return lobby;
}

export async function acceptInvite(userId: string, inviteId: string): Promise<Lobby> {
  return joinWithInvite(userId, findOwn(userId, inviteId, 'to'));
}

export function incomingInvites(userId: string): LobbyInvite[] {
  const now = Date.now();
  return [...invites.values()].filter((i) => i.toUserId === userId && i.expiresAt > now).map(toPublic);
}

export async function friendLobby(userId: string, friendId: string): Promise<FriendLobbyInfo | null> {
  await assertFriends(userId, friendId);
  const friend = await loadSettings(friendId);
  if (!friend || friend.status === 'invisible' || !sessionManager.isConnected(friendId)) return null;
  const lobby = lobbyManager.getLobbyByUserId(friendId);
  if (!lobby) return null;
  const hasInvite = !!activeInvite(lobby.id, userId);
  return {
    ...(lobby.isPrivate ? {} : { lobbyId: lobby.id }),
    name: lobby.name,
    players: lobby.players.length,
    slots: lobby.maxPlayers,
    joinable: lobby.status === 'open' && lobby.players.length < lobby.maxPlayers && (!lobby.isPrivate || hasInvite),
    locked: lobby.locked,
    hasInvite,
  };
}

export async function joinFriend(userId: string, friendId: string): Promise<Record<string, unknown>> {
  const io = getSocialIo();
  if (!io) throw new HubError('INTERNAL');
  await assertFriends(userId, friendId);
  const friend = await loadSettings(friendId);
  const lobby = friend && friend.status !== 'invisible' ? lobbyManager.getLobbyByUserId(friendId) : undefined;
  if (!lobby) throw new HubError('FRIEND_NOT_IN_LOBBY');
  const gameId = requireOwnGame(userId);
  if (lobby.gameId !== gameId) throw new HubError('GAME_MISMATCH');

  if (lobby.isPrivate) {
    const inv = activeInvite(lobby.id, userId);
    if (!inv) throw new HubError('LOBBY_PRIVATE');
    return { pending: false, lobby: await joinWithInvite(userId, inv) };
  }
  const username = (await loadSettings(userId))?.username ?? '';
  return startJoinRequest(io, userId, username, lobby, false);
}

/** Bricht Einladungen ab, deren Lobby aufgelöst/voll ist oder deren Einlader die Lobby verlassen hat. */
function reconcile(): void {
  for (const inv of [...invites.values()]) {
    const lobby = lobbyManager.getLobby(inv.lobbyId);
    let reason: LobbyInviteCancelReason | undefined;
    if (!lobby || lobby.status === 'closed') reason = 'lobby_closed';
    else if (!lobby.players.some((p) => p.userId === inv.fromUserId)) reason = 'left';
    else if (lobby.players.some((p) => p.userId === inv.toUserId)) reason = 'cancelled';
    else if (lobby.players.length >= lobby.maxPlayers) reason = 'lobby_full';
    if (reason) void removeInvite(inv, reason, reason !== 'cancelled');
  }
}
presenceListeners.push(reconcile);

friendHooks.onRemoved.push(async (a, b) => {
  for (const inv of [...invites.values()]) {
    if ((inv.fromUserId === a && inv.toUserId === b) || (inv.fromUserId === b && inv.toUserId === a)) {
      await removeInvite(inv, 'unfriended');
    }
  }
});

export async function purgeUserInvites(userId: string): Promise<void> {
  for (const inv of [...invites.values()]) {
    if (inv.fromUserId === userId || inv.toUserId === userId) await removeInvite(inv, 'cancelled', inv.toUserId !== userId);
  }
}
