import { createHash } from 'crypto';
import type { FriendRemovedReason, SocialSnapshot } from '@ethernal/shared';
import { HubError } from '../errors';
import { deleteUserBlocks } from './blocks.service';
import { listFriends, listRequests, purgeUserFriends } from './friends.service';
import { incomingInvites, purgeUserInvites } from './invites.service';
import { unreadByConversation, purgeUserMessages } from './messages.service';
import { deleteUserNotifications, unreadCount } from './notifications.service';
import { presenceOfFriends } from './presence.service';
import { deleteSettings, loadSettings, publicSettings } from './settings.service';

/** Konsistenter Gesamtzustand. `etag` ändert sich nur, wenn sich der Inhalt ändert (billiges Polling). */
export async function buildSnapshot(userId: string): Promise<SocialSnapshot> {
  const [settings, friends, presence, requests, unread, conversations] = await Promise.all([
    loadSettings(userId),
    listFriends(userId),
    presenceOfFriends(userId),
    listRequests(userId),
    unreadCount(userId),
    unreadByConversation(userId),
  ]);
  if (!settings) throw new HubError('USER_NOT_FOUND');
  const body = {
    status: settings.status,
    settings: publicSettings(settings),
    friends,
    presence,
    requests,
    lobbyInvites: incomingInvites(userId),
    unreadNotifications: unread,
    conversations,
  };
  const etag = createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  return { etag, serverTime: Date.now(), ...body };
}

/** Kaskade bei Account-Löschung: entfernt alle Social-Daten des Users. */
export async function purgeUserSocialData(userId: string, opts: { friendRemovedReason?: FriendRemovedReason } = {}): Promise<void> {
  await purgeUserInvites(userId);
  await purgeUserFriends(userId, opts.friendRemovedReason);
  await purgeUserMessages(userId);
  await deleteUserNotifications(userId);
  await deleteUserBlocks(userId);
  await deleteSettings(userId);
}
