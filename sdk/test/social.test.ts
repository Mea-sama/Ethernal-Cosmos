import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ErrorCode,
  FriendPresenceStatus,
  FriendRequestResult,
  LobbyInviteCancelReason,
  NotificationType,
  OwnPresenceStatus,
} from '../src';
import { startHub, type TestHub } from '../../server/test/helpers/hub';
import { EthernalClient } from '../src';
import { Fleet, PASSWORD, Recorder, befriend, rejectsWith, sleep, uname } from './helpers';

let hub: TestHub;
let fleet: Fleet;
beforeAll(async () => {
  hub = await startHub({ env: { FRIEND_NAME_LOOKUP_MIN_MS: '20', FRIEND_SILENT_DECLINE: 'false' } });
});
afterAll(async () => {
  await hub.stop();
});
afterEach(async () => {
  await fleet?.closeAll();
});

describe('friends', () => {
  it('request by name: REQUEST_SENT / NO_SUCH_PLAYER, receive, list, accept, presence', async () => {
    fleet = new Fleet(hub);
    const a = await fleet.player('relay', 'fa');
    const b = await fleet.player('relay', 'fb');

    expect(await a.client.requestFriendByName(uname('ghost'))).toBe(FriendRequestResult.NoSuchPlayer);
    expect(await a.client.requestFriendByName(b.username)).toBe(FriendRequestResult.RequestSent);

    const [received] = await b.rec.waitFor('friend:requestReceived', (d: any) => d.request.user.userId === a.userId);
    expect(received.request).toMatchObject({ id: expect.any(String), user: { userId: a.userId, username: a.username }, source: 'name' });
    const note = (await b.rec.waitFor('notification', (n: any) => n.type === NotificationType.FriendRequest))[0];
    expect(note.payload).toBeDefined();

    expect((await b.client.listFriendRequests()).incoming.map((r) => r.user.userId)).toContain(a.userId);
    expect((await a.client.listFriendRequests()).outgoing.map((r) => r.user.userId)).toContain(b.userId);

    await b.client.respondFriendRequest(received.request.id, true);
    const [accepted] = await a.rec.waitFor('friend:requestAccepted', (d: any) => d.friend.userId === b.userId);
    expect(accepted.friend.username).toBe(b.username);
    await a.rec.waitFor('notification', (n: any) => n.type === NotificationType.FriendAccepted);
    expect((await a.client.listFriends()).map((f) => f.userId)).toContain(b.userId);
    expect((await b.client.listFriends()).map((f) => f.userId)).toContain(a.userId);

    const [pres] = await a.rec.waitFor('friend:presence', (p: any) => p.userId === b.userId);
    expect(pres).toMatchObject({ username: b.username, online: true, status: FriendPresenceStatus.Online });
    const pull = (await a.client.getFriendsPresence()).find((p) => p.userId === b.userId);
    expect(pull).toMatchObject({ online: true, gameId: 'relay' });
    expect(pull).not.toHaveProperty('lobbyId');
  });

  it('decline, cancel, remove emit the matching events', async () => {
    fleet = new Fleet(hub);
    const a = await fleet.player(undefined, 'fa');
    const b = await fleet.player(undefined, 'fb');
    const c = await fleet.player(undefined, 'fc');

    await a.client.requestFriendByName(b.username);
    const [req] = await b.rec.waitFor('friend:requestReceived');
    await b.client.respondFriendRequest(req.request.id, false);
    const [declined] = await a.rec.waitFor('friend:requestDeclined');
    expect(declined).toMatchObject({ requestId: req.request.id, user: { userId: b.userId } });
    expect((await a.client.listFriends()).map((f) => f.userId)).not.toContain(b.userId);
    expect((await rejectsWith(b.client.respondFriendRequest(req.request.id, true))).code).toBe(ErrorCode.FriendRequestNotFound);

    await a.client.requestFriendByName(c.username);
    const [req2] = await c.rec.waitFor('friend:requestReceived');
    await a.client.cancelFriendRequest(req2.request.id);
    expect((await c.rec.waitFor('friend:requestCancelled'))[0]).toEqual({ requestId: req2.request.id });
    expect((await rejectsWith(a.client.cancelFriendRequest(req2.request.id))).code).toBe(ErrorCode.FriendRequestNotFound);

    await befriend(a, b);
    await a.client.removeFriend(b.userId);
    expect((await b.rec.waitFor('friend:removed'))[0]).toEqual({ userId: a.userId });
    expect((await b.client.listFriends()).map((f) => f.userId)).not.toContain(a.userId);
    expect((await rejectsWith(a.client.removeFriend(b.userId))).code).toBe(ErrorCode.NotFriends);
  });

  it('requestFriendFromLobby works between lobby members only', async () => {
    fleet = new Fleet(hub);
    const a = await fleet.player('other', 'fa');
    const b = await fleet.player('other', 'fb');
    const outsider = await fleet.player('other', 'fo');
    expect((await rejectsWith(a.client.requestFriendFromLobby(b.userId))).code).toBe(ErrorCode.NotInLobby);
    const lobby = await a.client.createLobby({ name: 'friends' });
    await b.client.joinLobby(lobby.id);
    expect((await rejectsWith(a.client.requestFriendFromLobby(outsider.userId))).code).toBe(ErrorCode.PlayerNotInLobby);
    expect(await a.client.requestFriendFromLobby(b.userId)).toBe(FriendRequestResult.RequestSent);
    const [req] = await b.rec.waitFor('friend:requestReceived');
    expect(req.request.source).toBe('lobby');
  });
});

describe('presence, settings, sync', () => {
  it('own status shows up as friend:presence; invisible looks offline; settings patch + validation', async () => {
    fleet = new Fleet(hub);
    const a = await fleet.player('relay', 'pa');
    const b = await fleet.player('relay', 'pb');
    await befriend(a, b);

    const initial = await a.client.getSocialSettings();
    expect(initial).toMatchObject({ status: OwnPresenceStatus.Online, showLastSeen: expect.any(Boolean), dmReadReceipts: expect.any(Boolean), mutedNotificationTypes: [] });

    const after = await b.client.setSocialSettings({ status: OwnPresenceStatus.Busy, showLastSeen: false, dmReadReceipts: false });
    expect(after).toMatchObject({ status: 'busy', showLastSeen: false, dmReadReceipts: false });
    expect((await b.client.getSocialSettings()).status).toBe('busy');
    await a.rec.waitFor('friend:presence', (p: any) => p.userId === b.userId && p.status === FriendPresenceStatus.Busy);

    await b.client.setSocialSettings({ status: OwnPresenceStatus.Invisible });
    const [off] = await a.rec.waitFor('friend:presence', (p: any) => p.userId === b.userId && p.online === false);
    expect(off.status).toBe(FriendPresenceStatus.Offline);
    expect((await a.client.getFriendsPresence()).find((p) => p.userId === b.userId)?.online).toBe(false);

    expect((await rejectsWith(b.client.setSocialSettings({ status: 'nope' as any }))).code).toBe(ErrorCode.InvalidInput);
    expect((await rejectsWith(b.client.setSocialSettings({ mutedNotificationTypes: ['bogus'] as any }))).code).toBe(ErrorCode.InvalidInput);
  });

  it('syncSocial returns a snapshot and notModified for an unchanged etag', async () => {
    fleet = new Fleet(hub);
    const a = await fleet.player(undefined, 'sa');
    const b = await fleet.player(undefined, 'sb');
    const snap: any = await a.client.syncSocial();
    expect(snap).toMatchObject({ etag: expect.any(String), serverTime: expect.any(Number), status: 'online', friends: [], requests: { incoming: [], outgoing: [] }, lobbyInvites: [], unreadNotifications: expect.any(Number), conversations: [] });
    expect(snap.settings.status).toBe('online');
    expect(await a.client.syncSocial(snap.etag)).toEqual({ notModified: true, etag: snap.etag });

    await befriend(a, b);
    const next: any = await a.client.syncSocial(snap.etag);
    expect(next.notModified).toBeUndefined();
    expect(next.etag).not.toBe(snap.etag);
    expect(next.friends.map((f: any) => f.userId)).toContain(b.userId);
    expect(next.presence.map((p: any) => p.userId)).toContain(b.userId);
  });

  it('friend_online notification goes to online friends when a friend comes online; muting suppresses it', async () => {
    fleet = new Fleet(hub);
    const a = await fleet.player(undefined, 'oa');
    const b = await fleet.player(undefined, 'ob');
    const muted = await fleet.player(undefined, 'oc');
    const stranger = await fleet.player(undefined, 'os');
    await befriend(a, b);
    await befriend(a, muted);
    await muted.client.setSocialSettings({ mutedNotificationTypes: [NotificationType.FriendOnline] });

    a.client.disconnect();
    await b.rec.waitFor('friend:presence', (p: any) => p.userId === a.userId && p.online === false);
    await a.client.login(a.username, PASSWORD);
    const [n] = await b.rec.waitFor('notification', (x: any) => x.type === NotificationType.FriendOnline && x.payload.userId === a.userId);
    expect(n.payload.username).toBe(a.username);
    await sleep(300);
    expect(muted.rec.count('notification', (x: any) => x.type === 'friend_online')).toBe(0);
    expect(stranger.rec.count('notification', (x: any) => x.type === 'friend_online')).toBe(0);
    expect((await b.client.getNotificationCounts()).byType.friend_online).toBeGreaterThanOrEqual(1);
  });
});

describe('notifications', () => {
  it('backlog on connect, list / unreadOnly / paging, markRead by ids and upTo, counts', async () => {
    fleet = new Fleet(hub);
    const a = await fleet.player(undefined, 'na');
    const b = await fleet.player(undefined, 'nb');
    const c = await fleet.player(undefined, 'nc');
    await a.client.requestFriendByName(b.username);
    await c.client.requestFriendByName(b.username);
    await b.rec.waitFor('notification', () => b.rec.count('notification', (n: any) => n.type === 'friend_request') >= 2);

    // a fresh connection receives the backlog
    b.client.disconnect();
    await b.client.login(b.username, PASSWORD);
    const [backlog] = await b.rec.waitFor('notification:backlog', (d: any) => d.unreadCount >= 2);
    expect(backlog.latest.length).toBeGreaterThanOrEqual(2);

    const counts = await b.client.getNotificationCounts();
    expect(counts.unread).toBeGreaterThanOrEqual(2);
    expect(counts.byType.friend_request).toBeGreaterThanOrEqual(2);

    const all = await b.client.listNotifications();
    expect(all.notifications.length).toBeGreaterThanOrEqual(2);
    expect(all.notifications[0]).toMatchObject({ id: expect.any(String), type: expect.any(String), createdAt: expect.any(Number), expiresAt: expect.any(Number) });
    const page1 = await b.client.listNotifications({ limit: 1 });
    expect(page1.notifications).toHaveLength(1);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = await b.client.listNotifications({ limit: 1, cursor: page1.nextCursor });
    expect(page2.notifications[0].id).not.toBe(page1.notifications[0].id);
    expect((await b.client.listNotifications({ since: Date.now() + 60_000 })).notifications).toEqual([]);

    const result = await b.client.markNotificationsRead({ ids: [page1.notifications[0].id] });
    expect(result.marked).toBe(1);
    const unread = await b.client.listNotifications({ unreadOnly: true });
    expect(unread.notifications.map((n) => n.id)).not.toContain(page1.notifications[0].id);

    const rest = await b.client.markNotificationsRead({ upTo: Date.now() });
    expect(rest.unread).toBe(0);
    expect((await b.client.getNotificationCounts()).unread).toBe(0);
    expect((await rejectsWith(b.client.markNotificationsRead({}))).code).toBe(ErrorCode.InvalidInput);
  });
});

describe('direct messages', () => {
  it('send, receive, delivered, history paging, conversations, read receipts, typing', async () => {
    fleet = new Fleet(hub);
    const a = await fleet.player(undefined, 'da');
    const b = await fleet.player(undefined, 'db');
    await befriend(a, b);

    const m1 = await a.client.sendDirectMessage(b.userId, 'hello');
    const m2 = await a.client.sendDirectMessage(b.userId, 'world');
    expect(m1).toMatchObject({ from: a.userId, to: b.userId, text: 'hello', seq: expect.any(Number), sentAt: expect.any(Number) });
    expect(m2.seq).toBeGreaterThan(m1.seq);
    expect((await b.rec.waitFor('dm:received', (m: any) => m.id === m1.id))[0]).toMatchObject({ text: 'hello', from: a.userId });
    const history = await a.client.getDmHistory(b.userId);
    expect(history.messages.map((m) => m.text)).toEqual(['hello', 'world']);
    const page = await a.client.getDmHistory(b.userId, { limit: 1 });
    expect(page.messages.map((m) => m.text)).toEqual(['world']);
    expect(page.nextBefore).toEqual(expect.any(Number));
    const older = await a.client.getDmHistory(b.userId, { limit: 1, before: page.nextBefore });
    expect(older.messages.map((m) => m.text)).toEqual(['hello']);

    const conv = (await b.client.listConversations()).find((c) => c.withUserId === a.userId);
    expect(conv).toMatchObject({ username: a.username, unreadCount: 2, lastMessage: { text: 'world' } });

    expect(await b.client.markConversationRead(a.userId)).toMatchObject({ withUserId: a.userId, marked: 2, lastReadSeq: m2.seq, unreadCount: 0, totalUnread: 0 });
    const [read] = await a.rec.waitFor('dm:read', (d: any) => d.byUserId === b.userId);
    expect(read.upToSeq).toBe(m2.seq);
    expect((await b.client.listConversations()).find((c) => c.withUserId === a.userId)?.unreadCount).toBe(0);

    await a.client.sendTyping(b.userId);
    expect((await b.rec.waitFor('dm:typing'))[0]).toEqual({ fromUserId: a.userId });

    // messages sent while offline are announced as delivered once the recipient reconnects
    b.client.disconnect();
    await a.rec.waitFor('friend:presence', (p: any) => p.userId === b.userId && p.online === false);
    const m3 = await a.client.sendDirectMessage(b.userId, 'while away');
    await b.client.login(b.username, PASSWORD);
    expect((await a.rec.waitFor('dm:delivered', (d: any) => d.messageIds.includes(m3.id)))[0].byUserId).toBe(b.userId);
    expect((await b.client.listNotifications()).notifications.some((n) => n.type === NotificationType.Dm)).toBe(true);
  });

  it('read receipts can be disabled; errors for strangers, empty and too long messages', async () => {
    fleet = new Fleet(hub);
    const a = await fleet.player(undefined, 'da');
    const b = await fleet.player(undefined, 'db');
    const stranger = await fleet.player(undefined, 'ds');
    await befriend(a, b);
    await b.client.setSocialSettings({ dmReadReceipts: false });
    await a.client.sendDirectMessage(b.userId, 'quiet');
    await b.rec.waitFor('dm:received');
    await b.client.markConversationRead(a.userId);
    await sleep(300);
    expect(a.rec.count('dm:read')).toBe(0);

    expect((await rejectsWith(a.client.sendDirectMessage(stranger.userId, 'hi'))).code).toBe(ErrorCode.NotFriends);
    expect((await rejectsWith(a.client.getDmHistory(stranger.userId))).code).toBe(ErrorCode.NotFriends);
    expect((await rejectsWith(a.client.sendTyping(stranger.userId))).code).toBe(ErrorCode.NotFriends);
    expect((await rejectsWith(a.client.sendDirectMessage(b.userId, '   '))).code).toBe(ErrorCode.InvalidInput);
    expect((await rejectsWith(a.client.sendDirectMessage(b.userId, 'x'.repeat(1001)))).code).toBe(ErrorCode.MessageTooLong);
  });
});

describe('lobby invites and joining friends', () => {
  async function friendsInGame(game = 'other') {
    fleet = new Fleet(hub);
    const a = await fleet.player(game, 'ia');
    const b = await fleet.player(game, 'ib');
    await befriend(a, b);
    return { a, b };
  }

  it('invite → receive → list → decline / cancel / accept (also private lobbies)', async () => {
    const { a, b } = await friendsInGame();
    expect((await rejectsWith(a.client.inviteFriend(b.userId))).code).toBe(ErrorCode.NotInLobby);
    const lobby = await a.client.createLobby({ name: 'invite-only', isPrivate: true });

    const invite = await a.client.inviteFriend(b.userId);
    expect(invite).toMatchObject({ inviteId: expect.any(String), lobbyId: lobby.id, lobbyName: 'invite-only', gameId: 'other', fromUserId: a.userId, fromUsername: a.username, expiresAt: expect.any(Number) });
    expect((await b.rec.waitFor('lobby:inviteReceived'))[0].inviteId).toBe(invite.inviteId);
    await b.rec.waitFor('notification', (n: any) => n.type === NotificationType.LobbyInvite);
    expect((await b.client.listLobbyInvites()).map((i) => i.inviteId)).toContain(invite.inviteId);

    await b.client.declineLobbyInvite(invite.inviteId);
    expect((await a.rec.waitFor('lobby:inviteDeclined'))[0]).toEqual({ inviteId: invite.inviteId, userId: b.userId });
    expect((await b.client.listLobbyInvites()).map((i) => i.inviteId)).not.toContain(invite.inviteId);
    expect((await rejectsWith(b.client.declineLobbyInvite(invite.inviteId))).code).toBe(ErrorCode.InviteNotFound);

    const second = await a.client.inviteFriend(b.userId);
    await a.client.cancelLobbyInvite(second.inviteId);
    const [cancelled] = await b.rec.waitFor('lobby:inviteCancelled', (d: any) => d.inviteId === second.inviteId);
    expect(cancelled).toEqual({ inviteId: second.inviteId, lobbyId: lobby.id, reason: LobbyInviteCancelReason.Cancelled });
    expect((await rejectsWith(a.client.cancelLobbyInvite(second.inviteId))).code).toBe(ErrorCode.InviteNotFound);
    expect((await rejectsWith(b.client.acceptLobbyInvite(second.inviteId))).code).toBe(ErrorCode.InviteNotFound);

    const third = await a.client.inviteFriend(b.userId);
    const joined = await b.client.acceptLobbyInvite(third.inviteId);
    expect(joined.id).toBe(lobby.id);
    expect(joined.players.map((p) => p.userId)).toContain(b.userId);
  });

  it('invite errors: offline friend, other game, stranger', async () => {
    const { a, b } = await friendsInGame();
    const otherGame = await fleet.player('relay', 'ig');
    await befriend(a, otherGame);
    const stranger = await fleet.player('other', 'is');
    await a.client.createLobby({ name: 'errs' });
    expect((await rejectsWith(a.client.inviteFriend(otherGame.userId))).code).toBe(ErrorCode.GameMismatch);
    expect((await rejectsWith(a.client.inviteFriend(stranger.userId))).code).not.toBe('TIMEOUT');
    b.client.disconnect();
    await a.rec.waitFor('friend:presence', (p: any) => p.userId === b.userId && p.online === false);
    expect((await rejectsWith(a.client.inviteFriend(b.userId))).code).toBe(ErrorCode.FriendOffline);
  });

  it('joinFriend: direct join for open lobbies, request for locked, LOBBY_PRIVATE / FRIEND_NOT_IN_LOBBY otherwise; getFriendLobby', async () => {
    const { a, b } = await friendsInGame();
    expect(await b.client.getFriendLobby(a.userId)).toBeNull();
    expect((await rejectsWith(b.client.joinFriend(a.userId))).code).toBe(ErrorCode.FriendNotInLobby);

    const lobby = await a.client.createLobby({ name: 'friend-room' });
    const info = await b.client.getFriendLobby(a.userId);
    expect(info).toMatchObject({ lobbyId: lobby.id, name: 'friend-room', players: 1, slots: 4, joinable: true, locked: false, hasInvite: false });

    await a.client.lockLobby();
    expect(await b.client.getFriendLobby(a.userId)).toMatchObject({ locked: true });
    const pending = await b.client.joinFriend(a.userId);
    expect(pending.pending).toBe(true);
    await a.rec.waitFor('joinRequestReceived', (d: any) => d.requesterId === b.userId);
    await a.client.respondJoinRequest(b.userId, true);
    expect((await b.rec.waitFor('joinRequestAccepted'))[0].lobby.id).toBe(lobby.id);
    await b.client.leaveLobby();
    await a.client.unlockLobby();

    const direct = await b.client.joinFriend(a.userId);
    expect(direct.pending).toBe(false);
    expect(direct.lobby?.id).toBe(lobby.id);
    await b.client.leaveLobby();
    await a.client.leaveLobby();

    const hidden = await a.client.createLobby({ name: 'hidden', isPrivate: true });
    const hiddenInfo = await b.client.getFriendLobby(a.userId);
    expect(hiddenInfo).toMatchObject({ name: 'hidden' });
    expect(hiddenInfo).not.toHaveProperty('lobbyId');
    expect(JSON.stringify(hiddenInfo)).not.toContain(hidden.id);
    expect((await rejectsWith(b.client.joinFriend(a.userId))).code).toBe(ErrorCode.LobbyPrivate);

    const stranger = await fleet.player('other', 'is');
    expect((await rejectsWith(stranger.client.getFriendLobby(a.userId))).code).toBe(ErrorCode.NotFriends);
    expect((await rejectsWith(stranger.client.joinFriend(a.userId))).code).toBe(ErrorCode.NotFriends);
  });
});

describe('direct messages: read cursor and unread badge', () => {
  it('getDmUnread, openDmConversation (last 10, marks read), partial markConversationRead, dm:readState, peerLastReadSeq', async () => {
    fleet = new Fleet(hub);
    const a = await fleet.player(undefined, 'ra');
    const b = await fleet.player(undefined, 'rb');
    await befriend(a, b);
    const b2 = fleet.track(new EthernalClient({ serverUrl: hub.url, clientType: 'panel' }));
    const rec2 = new Recorder(b2);
    await b2.login(b.username, PASSWORD);

    const sent = [];
    for (let i = 1; i <= 12; i++) sent.push(await a.client.sendDirectMessage(b.userId, `m${i}`));
    await b.rec.waitFor('dm:received', (m: any) => m.id === sent[11].id);

    const unread = await b.client.getDmUnread();
    expect(unread.totalUnread).toBe(12);
    expect(unread.conversations).toEqual([
      { withUserId: a.userId, unreadCount: 12, firstUnreadSeq: sent[0].seq, lastSeq: sent[11].seq, lastMessageAt: expect.any(Number) },
    ]);
    expect((await b.client.listConversations())[0]).toMatchObject({ unreadCount: 12, lastReadSeq: 0 });

    // partial read: first 5 messages
    const partial = await b.client.markConversationRead(a.userId, sent[4].seq);
    expect(partial).toMatchObject({ withUserId: a.userId, marked: 5, lastReadSeq: sent[4].seq, unreadCount: 7, totalUnread: 7 });
    expect((await rec2.waitFor('dm:readState', (d: any) => d.unreadCount === 7))[0]).toMatchObject({ withUserId: a.userId, lastReadSeq: sent[4].seq, totalUnread: 7 });
    expect((await a.rec.waitFor('dm:read', (d: any) => d.upToSeq === sent[4].seq))[0].byUserId).toBe(b.userId);
    expect((await b.client.getDmUnread()).conversations[0]).toMatchObject({ unreadCount: 7, firstUnreadSeq: sent[5].seq });

    // open: last 10 messages, state from before opening, then everything is read
    const opened = await b.client.openDmConversation(a.userId);
    expect(opened.messages.map((m) => m.text)).toEqual(sent.slice(2).map((m) => m.text));
    expect(opened).toMatchObject({ lastReadSeq: sent[4].seq, firstUnreadSeq: sent[5].seq, unreadCount: 7 });
    expect((await rec2.waitFor('dm:readState', (d: any) => d.unreadCount === 0))[0]).toMatchObject({ withUserId: a.userId, lastReadSeq: sent[11].seq, totalUnread: 0 });
    expect(await b.client.getDmUnread()).toEqual({ conversations: [], totalUnread: 0 });
    const reopened = await b.client.openDmConversation(a.userId, 3);
    expect(reopened.messages.map((m) => m.text)).toEqual(['m10', 'm11', 'm12']);
    expect(reopened).toMatchObject({ lastReadSeq: sent[11].seq, unreadCount: 0 });
    expect(reopened.firstUnreadSeq).toBeUndefined();

    // the sender sees how far the friend has read
    const asSender = await a.client.openDmConversation(b.userId);
    expect(asSender.peerLastReadSeq).toBe(sent[11].seq);
    expect((await rejectsWith(b.client.openDmConversation(uname('nobody')))).code).toBeTruthy();
  });
});
