import { z } from 'zod';
import { HubError } from '../errors';
import { assertUserLimit } from './bus';
import * as friends from './friends.service';
import * as invites from './invites.service';
import * as messages from './messages.service';
import * as notifications from './notifications.service';
import { presenceChanged, presenceOfFriends } from './presence.service';
import { loadSettings, publicSettings, updateSettings } from './settings.service';
import { buildSnapshot } from './sync.service';

type Result = Record<string, unknown> | void;

interface Action<T> {
  /** Key in socketLimits (gilt pro User, für Socket und REST gemeinsam) */
  limit: string | ((input: T) => string);
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  run(userId: string, input: T): Promise<Result>;
}

const id = z.string().min(1).max(64);
const empty = z.object({}).passthrough().optional().transform(() => ({}));

function action<T>(a: Action<T>): Action<T> {
  return a;
}

export const actions = {
  'friend:request': action({
    limit: (i: { username?: string }) => (i.username !== undefined ? 'friendRequestByName' : 'friendRequest'),
    schema: z
      .object({ username: z.string().trim().min(1).max(64).optional(), userId: id.optional() })
      .refine((v) => (v.username === undefined) !== (v.userId === undefined)),
    run: async (userId, i) => ({
      result: i.username !== undefined ? await friends.requestByName(userId, i.username) : await friends.requestFromLobby(userId, i.userId!),
    }),
  }),
  'friend:respond': action({
    limit: 'friendAction',
    schema: z.object({ requestId: id, accept: z.boolean() }),
    run: async (userId, i) => friends.respond(userId, i.requestId, i.accept),
  }),
  'friend:cancel': action({
    limit: 'friendAction',
    schema: z.object({ requestId: id }),
    run: async (userId, i) => friends.cancel(userId, i.requestId),
  }),
  'friend:remove': action({
    limit: 'friendAction',
    schema: z.object({ friendId: id }),
    run: async (userId, i) => friends.removeFriend(userId, i.friendId),
  }),
  'friend:list': action({ limit: 'socialRead', schema: empty, run: async (userId) => ({ friends: await friends.listFriends(userId) }) }),
  'friend:requests': action({ limit: 'socialRead', schema: empty, run: async (userId) => ({ ...(await friends.listRequests(userId)) }) }),
  'presence:friends': action({ limit: 'socialRead', schema: empty, run: async (userId) => ({ presence: await presenceOfFriends(userId) }) }),
  'social:getSettings': action({
    limit: 'socialRead',
    schema: empty,
    run: async (userId) => {
      const s = await loadSettings(userId);
      if (!s) throw new HubError('USER_NOT_FOUND');
      return { settings: publicSettings(s) };
    },
  }),
  'social:setSettings': action({
    limit: 'socialSettings',
    schema: z.object({}).passthrough(),
    run: async (userId, i) => {
      const s = await updateSettings(userId, i);
      presenceChanged(userId);
      return { settings: publicSettings(s) };
    },
  }),
  'social:sync': action({
    limit: 'socialRead',
    schema: z.object({ etag: z.string().max(64).optional() }).optional().transform((v) => v ?? {}),
    run: async (userId, i) => {
      const snap = await buildSnapshot(userId);
      return i.etag && i.etag === snap.etag ? { notModified: true, etag: snap.etag } : { ...snap };
    },
  }),
  'social:friendLobby': action({
    limit: 'socialRead',
    schema: z.object({ friendId: id }),
    run: async (userId, i) => ({ lobby: await invites.friendLobby(userId, i.friendId) }),
  }),
  'notification:list': action({
    limit: 'socialRead',
    schema: z
      .object({
        since: z.coerce.number().optional(),
        unreadOnly: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()).optional(),
        limit: z.coerce.number().optional(),
        cursor: z.string().max(100).optional(),
      })
      .optional()
      .transform((v) => v ?? {}),
    run: async (userId, i) => ({ ...(await notifications.listNotifications(userId, i)) }),
  }),
  'notification:markRead': action({
    limit: 'notificationWrite',
    schema: z.object({ ids: z.array(id).max(200).optional(), upTo: z.number().optional() }),
    run: async (userId, i) => ({ ...(await notifications.markRead(userId, i)) }),
  }),
  'notification:counts': action({ limit: 'socialRead', schema: empty, run: async (userId) => ({ ...(await notifications.notificationCounts(userId)) }) }),
  'dm:send': action({
    limit: 'dmSend',
    schema: z.object({ toUserId: id, text: z.unknown() }),
    run: async (userId, i) => ({ message: await messages.sendMessage(userId, i.toUserId, i.text) }),
  }),
  'dm:history': action({
    limit: 'socialRead',
    schema: z.object({ withUserId: id, before: z.coerce.number().optional(), limit: z.coerce.number().optional() }),
    run: async (userId, i) => ({ ...(await messages.history(userId, i.withUserId, i)) }),
  }),
  'dm:conversations': action({ limit: 'socialRead', schema: empty, run: async (userId) => ({ conversations: await messages.conversations(userId) }) }),
  'dm:markRead': action({
    limit: 'notificationWrite',
    schema: z.object({ withUserId: id }),
    run: async (userId, i) => ({ marked: await messages.markConversationRead(userId, i.withUserId) }),
  }),
  'dm:typing': action({
    limit: 'dmTyping',
    schema: z.object({ toUserId: id }),
    run: async (userId, i) => messages.typing(userId, i.toUserId),
  }),
  'lobby:invite': action({
    limit: 'lobbyInvite',
    schema: z.object({ friendId: id }),
    run: async (userId, i) => ({ invite: await invites.createInvite(userId, i.friendId) }),
  }),
  'lobby:cancelInvite': action({
    limit: 'lobbyInviteAction',
    schema: z.object({ inviteId: id }),
    run: async (userId, i) => invites.cancelInvite(userId, i.inviteId),
  }),
  'lobby:acceptInvite': action({
    limit: 'lobbyInviteAction',
    schema: z.object({ inviteId: id }),
    run: async (userId, i) => ({ lobby: await invites.acceptInvite(userId, i.inviteId) }),
  }),
  'lobby:declineInvite': action({
    limit: 'lobbyInviteAction',
    schema: z.object({ inviteId: id }),
    run: async (userId, i) => invites.declineInvite(userId, i.inviteId),
  }),
  'lobby:invites': action({ limit: 'socialRead', schema: empty, run: async (userId) => ({ invites: invites.incomingInvites(userId) }) }),
  'lobby:joinFriend': action({
    limit: 'lobbyInviteAction',
    schema: z.object({ friendId: id }),
    run: async (userId, i) => invites.joinFriend(userId, i.friendId),
  }),
};

export type ActionName = keyof typeof actions;

/** Gemeinsamer Pfad für Socket und REST: Rate-Limit → Validierung → Ausführung. */
export async function runAction(name: ActionName, userId: string, rawInput: unknown): Promise<Record<string, unknown>> {
  const a = actions[name] as Action<unknown>;
  const parsed = a.schema.safeParse(rawInput);
  if (!parsed.success) {
    assertUserLimit(userId, typeof a.limit === 'string' ? a.limit : 'socialRead');
    throw new HubError('INVALID_INPUT');
  }
  assertUserLimit(userId, typeof a.limit === 'function' ? a.limit(parsed.data) : a.limit);
  return ((await a.run(userId, parsed.data)) ?? {}) as Record<string, unknown>;
}
