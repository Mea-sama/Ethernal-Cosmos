import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { api, befriend, closeAll, connectClient, connectRegistered, FAST_SOCIAL, live, registerUser, sleep, startHub, type TestClient, type TestHub } from './util';

let hub: TestHub;
let strict: TestHub;
let retention: TestHub;
beforeAll(async () => {
  [hub, strict, retention] = await Promise.all([
    startHub({ env: FAST_SOCIAL }),
    startHub({
      env: {
        ...FAST_SOCIAL, FRIENDS_MAX: '2', FRIEND_REQUESTS_MAX_OUTGOING: '2', FRIEND_SILENT_DECLINE: 'true',
        NOTIFICATION_CAP_PER_USER: '3', DM_CONVERSATION_CAP: '3', LOBBY_INVITE_TTL_MS: '700',
      },
      limits: { socketLimits: { friendRequestByName: { refillPerSecond: 0.001, burst: 3 }, dmSend: { refillPerSecond: 0.001, burst: 4 } } },
    }),
    startHub({ env: { ...FAST_SOCIAL, FRIEND_REQUEST_EXPIRY_DAYS: '0.00003', NOTIFICATION_UNREAD_RETENTION_DAYS: '0.00003', DM_RETENTION_DAYS: '0.00003' } }),
  ]);
});
afterAll(async () => { await Promise.all([hub.stop(), strict.stop(), retention.stop()]); });

const reconnect = (h: TestHub, c: TestClient, game?: string): Promise<TestClient> => (game ? connectRegistered(h, c.user, game) : connectClient(h, c.user));
const dbOf = (h: TestHub) => createClient({ url: `file:${path.join(h.dataDir, 'ethernal.db')}` });

describe('Friends', () => {
  it('TEST-FRIEND-01: friend request by name only answers REQUEST_SENT / NO_SUCH_PLAYER (no user enumeration)', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    const existing = await a.emitAck('friend:request', { username: b.user.username });
    const missing = await a.emitAck('friend:request', { username: 'does-not-exist-xyz' });
    const self = await a.emitAck('friend:request', { username: a.user.username });
    const duplicate = await a.emitAck('friend:request', { username: b.user.username });
    expect(existing).toEqual({ ok: true, result: 'REQUEST_SENT' });
    expect(missing).toEqual({ ok: true, result: 'NO_SUCH_PLAYER' });
    expect(self).toEqual({ ok: true, result: 'REQUEST_SENT' });
    expect(duplicate).toEqual({ ok: true, result: 'REQUEST_SENT' });
    expect((await a.emitAck('friend:requests')).outgoing).toHaveLength(1);
    expect(b.count('friend:requestReceived')).toBe(1);
    expect((await a.emitAck('friend:request', {})).error.code).toBe('INVALID_INPUT');
    closeAll(a, b);
  });

  it('TEST-FRIEND-02: accept: events on both sides, lists, only {userId, username} exposed', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    for (const [x, y] of [[a, b], [b, a]] as const) {
      expect((await x.emitAck('friend:list')).friends).toEqual([{ userId: y.user.userId, username: y.user.username }]);
    }
    expect((await b.emitAck('friend:requests')).incoming).toHaveLength(0);
    expect((await b.emitAck('notification:counts')).byType.friend_request).toBeUndefined();
    closeAll(a, b);
  });

  it('TEST-FRIEND-03: decline: requester only learns "declined" (requestId, user); not friends; request gone', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await a.emitAck('friend:request', { username: b.user.username });
    const { request } = await b.waitFor('friend:requestReceived');
    expect((await b.emitAck('friend:respond', { requestId: request.id, accept: false })).ok).toBe(true);
    expect(Object.keys(await a.waitFor('friend:requestDeclined')).sort()).toEqual(['requestId', 'user']);
    expect((await a.emitAck('friend:list')).friends).toEqual([]);
    expect((await b.emitAck('friend:respond', { requestId: request.id, accept: true })).error.code).toBe('FRIEND_REQUEST_NOT_FOUND');
    closeAll(a, b);
  });

  it('TEST-FRIEND-04: FRIEND_SILENT_DECLINE suppresses the decline event', async () => {
    const [a, b] = [await live(strict), await live(strict)];
    await a.emitAck('friend:request', { username: b.user.username });
    const { request } = await b.waitFor('friend:requestReceived');
    await b.emitAck('friend:respond', { requestId: request.id, accept: false });
    await sleep(200);
    expect(a.count('friend:requestDeclined')).toBe(0);
    closeAll(a, b);
  });

  it('TEST-FRIEND-05: cancel: receiver gets friend:requestCancelled, request and notification vanish', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await a.emitAck('friend:request', { username: b.user.username });
    const { request } = await b.waitFor('friend:requestReceived');
    expect((await b.emitAck('notification:counts')).byType.friend_request).toBe(1);
    expect((await b.emitAck('friend:cancel', { requestId: request.id })).error.code).toBe('FRIEND_REQUEST_NOT_FOUND');
    expect((await a.emitAck('friend:cancel', { requestId: request.id })).ok).toBe(true);
    await b.waitFor('friend:requestCancelled', (e) => e.requestId === request.id);
    expect((await b.emitAck('friend:requests')).incoming).toHaveLength(0);
    expect((await b.emitAck('notification:counts')).unread).toBe(0);
    closeAll(a, b);
  });

  it('TEST-FRIEND-06: befriend by userId from the lobby (lobby members only)', async () => {
    const [a, b, outsider] = [await live(hub), await live(hub), await live(hub)];
    expect((await a.emitAck('friend:request', { userId: b.user.userId })).error.code).toBe('NOT_IN_LOBBY');
    const lobby = (await a.emitAck('createLobby', { name: 'f' })).lobby;
    await b.emitAck('joinLobby', { lobbyId: lobby.id });
    expect((await a.emitAck('friend:request', { userId: outsider.user.userId })).error.code).toBe('PLAYER_NOT_IN_LOBBY');
    expect(await a.emitAck('friend:request', { userId: b.user.userId })).toEqual({ ok: true, result: 'REQUEST_SENT' });
    const { request } = await b.waitFor('friend:requestReceived');
    expect(request.source).toBe('lobby');
    await b.emitAck('friend:respond', { requestId: request.id, accept: true });
    expect((await a.emitAck('friend:list')).friends).toHaveLength(1);
    closeAll(a, b, outsider);
  });

  it('TEST-FRIEND-07: crossing requests (A→B then B→A) auto-accept', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await a.emitAck('friend:request', { username: b.user.username });
    await b.waitFor('friend:requestReceived');
    expect(await b.emitAck('friend:request', { username: a.user.username })).toEqual({ ok: true, result: 'REQUEST_SENT' });
    await a.waitFor('friend:requestAccepted');
    expect((await a.emitAck('friend:list')).friends).toHaveLength(1);
    expect((await a.emitAck('friend:requests')).outgoing).toHaveLength(0);
    closeAll(a, b);
  });

  it('TEST-FRIEND-08: remove friend notifies both; removing again is NOT_FRIENDS', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    expect((await a.emitAck('friend:remove', { friendId: b.user.userId })).ok).toBe(true);
    await b.waitFor('friend:removed', (e) => e.userId === a.user.userId);
    expect((await b.emitAck('friend:list')).friends).toEqual([]);
    expect((await a.emitAck('friend:remove', { friendId: b.user.userId })).error.code).toBe('NOT_FRIENDS');
    closeAll(a, b);
  });

  it('TEST-FRIEND-09: limits: max friends, max outgoing requests, rate limit on name requests (RATE_LIMITED + retryAfterMs)', async () => {
    const [a, b, c, d] = [await live(strict), await live(strict), await live(strict), await live(strict)];
    await befriend(a, b);
    await befriend(a, c);
    expect((await a.emitAck('friend:request', { userId: d.user.userId })).ok).toBe(false);
    expect((await a.emitAck('friend:request', { username: d.user.username })).error.code).toBe('FRIEND_LIMIT_REACHED');
    const x = await live(strict);
    const targets = [await live(strict), await live(strict), await live(strict)];
    expect((await x.emitAck('friend:request', { username: targets[0].user.username })).result).toBe('REQUEST_SENT');
    expect((await x.emitAck('friend:request', { username: targets[1].user.username })).result).toBe('REQUEST_SENT');
    expect((await x.emitAck('friend:request', { username: targets[2].user.username })).error.code).toBe('REQUEST_LIMIT_REACHED');
    const limited = await x.emitAck('friend:request', { username: 'nobody-here' });
    expect(limited.error.code).toBe('RATE_LIMITED');
    expect(limited.error.retryAfterMs).toBeGreaterThan(0);
    closeAll(a, b, c, d, x, ...targets);
  });

  it('TEST-FRIEND-10: pending requests expire via scheduler and are purged from the DB', async () => {
    const [a, b] = [await live(retention), await live(retention)];
    await a.emitAck('friend:request', { username: b.user.username });
    const { request } = await b.waitFor('friend:requestReceived');
    await sleep(3500);
    expect((await b.emitAck('friend:requests')).incoming).toHaveLength(0);
    expect((await b.emitAck('friend:respond', { requestId: request.id, accept: true })).error.code).toBe('FRIEND_REQUEST_NOT_FOUND');
    const db = dbOf(retention);
    const rows = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM friend_requests WHERE id = ?', args: [request.id] });
    expect(Number(rows.rows[0].n)).toBe(0);
    db.close();
    closeAll(a, b);
  });

  it('TEST-FRIEND-11: DELETE /social/data cascades friendships, requests, DMs and notifications', async () => {
    const [a, b, c] = [await live(hub), await live(hub), await live(hub)];
    await befriend(a, b);
    await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'hi' });
    await c.emitAck('friend:request', { username: a.user.username });
    await a.waitFor('friend:requestReceived');
    expect((await api(hub, a.user, 'DELETE', '/social/data')).status).toBe(200);
    await b.waitFor('friend:removed', (e) => e.userId === a.user.userId);
    expect((await b.emitAck('friend:list')).friends).toEqual([]);
    expect((await b.emitAck('dm:conversations')).conversations).toEqual([]);
    expect((await c.emitAck('friend:requests')).outgoing).toEqual([]);
    expect((await a.emitAck('notification:counts')).total).toBe(0);
    closeAll(a, b, c);
  });

  it('TEST-FRIEND-12: REST parity: request, list, respond, remove; unauthenticated is 401', async () => {
    const [a, b] = [await registerUser(hub), await registerUser(hub)];
    expect((await api(hub, a, 'POST', '/social/friends/requests', { username: 'no-such-user-abc' })).body).toEqual({ result: 'NO_SUCH_PLAYER' });
    expect((await api(hub, a, 'POST', '/social/friends/requests', { username: b.username })).body).toEqual({ result: 'REQUEST_SENT' });
    const reqs = await api(hub, b, 'GET', '/social/friends/requests');
    expect(reqs.body.incoming[0].user.userId).toBe(a.userId);
    expect((await api(hub, b, 'POST', `/social/friends/requests/${reqs.body.incoming[0].id}/respond`, { accept: true })).status).toBe(200);
    expect((await api(hub, a, 'GET', '/social/friends')).body.friends).toEqual([{ userId: b.userId, username: b.username }]);
    expect((await api(hub, a, 'DELETE', `/social/friends/${b.userId}`)).status).toBe(200);
    expect((await api(hub, a, 'DELETE', `/social/friends/${b.userId}`)).body.code).toBe('NOT_FRIENDS');
    expect((await fetch(`${hub.url}/social/friends`)).status).toBe(401);
  });
});

describe('Presence & privacy', () => {
  it('TEST-PRES-01: friends receive friend:presence on lobby changes; strangers receive nothing', async () => {
    const [a, b, stranger] = [await live(hub), await live(hub), await live(hub)];
    await befriend(a, b);
    const lobby = (await a.emitAck('createLobby', { name: 'p' })).lobby;
    await b.waitFor('friend:presence', (p) => p.userId === a.user.userId && p.lobbyJoinable === true);
    await sleep(200);
    expect(stranger.events.filter((e) => e.event.startsWith('presence:') || e.event === 'friend:presence')).toEqual([]);
    expect(JSON.stringify(b.events)).not.toContain(lobby.id);
    closeAll(a, b, stranger);
  });

  it('TEST-PRES-02: presence:friends pull (socket + REST) reports online status and gameId', async () => {
    const [a, b] = [await live(hub, 'relay'), await live(hub, 'other')];
    await befriend(a, b);
    const { presence } = await a.emitAck('presence:friends');
    expect(presence).toEqual([{ userId: b.user.userId, username: b.user.username, online: true, status: 'online', gameId: 'other' }]);
    expect((await api(hub, a.user, 'GET', '/social/presence')).body.presence).toEqual(presence);
    closeAll(a, b);
  });

  it('TEST-PRES-03: invisible appears offline (no gameId/lobby); status changes push; invalid status INVALID_INPUT', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    await a.emitAck('createLobby', { name: 'hidden' });
    expect((await a.emitAck('social:setSettings', { status: 'invisible' })).settings.status).toBe('invisible');
    const seen = await b.waitFor('friend:presence', (p) => p.userId === a.user.userId && p.online === false);
    expect(seen).toMatchObject({ status: 'offline' });
    expect(seen.gameId).toBeUndefined();
    expect(seen.lobbyJoinable).toBeUndefined();
    expect((await b.emitAck('social:friendLobby', { friendId: a.user.userId })).lobby).toBeNull();
    await a.emitAck('social:setSettings', { status: 'busy' });
    await b.waitFor('friend:presence', (p) => p.userId === a.user.userId && p.status === 'busy');
    expect((await a.emitAck('social:setSettings', { status: 'nope' })).error.code).toBe('INVALID_INPUT');
    closeAll(a, b);
  });

  it('TEST-PRES-04: private lobbies never expose an ID (lobbyJoinable=false); public ones are joinable without an ID', async () => {
    const [a, b] = [await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce')];
    await befriend(a, b);
    const priv = (await a.emitAck('createLobby', { name: 'priv', isPrivate: true })).lobby;
    await b.waitFor('friend:presence', (p) => p.userId === a.user.userId && p.lobbyJoinable === false);
    await a.emitAck('leaveLobby');
    const pub = (await a.emitAck('createLobby', { name: 'pub' })).lobby;
    await b.waitFor('friend:presence', (p) => p.userId === a.user.userId && p.lobbyJoinable === true);
    const dump = JSON.stringify(b.events.filter((e) => e.event === 'friend:presence'));
    for (const forbidden of [priv.id, pub.id, 'lobbyId']) expect(dump).not.toContain(forbidden);
    closeAll(a, b);
  });

  it('TEST-PRES-05: lastSeen only when allowed; the reconnect grace period still counts as online', async () => {
    const [a, b, c] = [await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce')];
    await befriend(a, b);
    await befriend(c, b);
    await c.emitAck('social:setSettings', { showLastSeen: false });
    a.close();
    c.close();
    expect((await b.waitFor('friend:presence', (p) => p.userId === a.user.userId && p.online === false)).lastSeen).toBeGreaterThan(0);
    expect((await b.waitFor('friend:presence', (p) => p.userId === c.user.userId && p.online === false)).lastSeen).toBeUndefined();
    const [d, e] = [await live(hub, 'relay'), await live(hub, 'relay')];
    await befriend(d, e);
    await d.emitAck('createLobby', { name: 'grace' });
    d.close();
    await sleep(300);
    expect((await e.emitAck('presence:friends')).presence[0].online).toBe(true);
    await e.waitFor('friend:presence', (p) => p.userId === d.user.userId && p.online === false, 6000);
    closeAll(b, e);
  });
});

describe('Notifications', () => {
  it('TEST-NOTIF-01: offline recipient gets a backlog on next login; counts, paging and markRead are consistent', async () => {
    const [a, b0] = [await live(hub), await live(hub)];
    b0.close();
    await a.emitAck('friend:request', { username: b0.user.username });
    const x = await live(hub);
    await x.emitAck('friend:request', { username: b0.user.username });
    await sleep(200);
    const b = await reconnect(hub, b0);
    const backlog = await b.waitFor('notification:backlog');
    expect(backlog.unreadCount).toBe(2);
    expect(backlog.latest.map((n: any) => n.type)).toEqual(['friend_request', 'friend_request']);
    expect(await b.emitAck('notification:counts')).toMatchObject({ unread: 2, total: 2, byType: { friend_request: 2 } });
    const page1 = await b.emitAck('notification:list', { limit: 1 });
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await b.emitAck('notification:list', { limit: 1, cursor: page1.nextCursor });
    expect(page2.nextCursor).toBeUndefined();
    expect(page2.notifications[0].id).not.toBe(page1.notifications[0].id);
    expect(await b.emitAck('notification:markRead', { ids: [page1.notifications[0].id] })).toMatchObject({ marked: 1, unread: 1 });
    expect((await api(hub, b0.user, 'GET', '/social/notifications/counts')).body).toMatchObject({ unread: 1, total: 2 });
    expect((await api(hub, b0.user, 'POST', '/social/notifications/read', { upTo: Date.now() })).body).toMatchObject({ marked: 1, unread: 0 });
    expect((await b.emitAck('notification:markRead', {})).error.code).toBe('INVALID_INPUT');
    closeAll(a, b, x);
  });

  it('TEST-NOTIF-02: live notification reaches all sessions; mute suppresses; invalid mute type INVALID_INPUT', async () => {
    const [a, b, c] = [await live(hub), await live(hub), await live(hub)];
    const panel = await connectClient(hub, b.user, 'panel');
    await a.emitAck('friend:request', { username: b.user.username });
    const n = await b.waitFor('notification', (x) => x.type === 'friend_request');
    expect(n.payload.fromUsername).toBe(a.user.username);
    await panel.waitFor('notification', (x) => x.id === n.id);
    await b.emitAck('social:setSettings', { mutedNotificationTypes: ['friend_request'] });
    await c.emitAck('friend:request', { username: b.user.username });
    await sleep(250);
    expect(b.count('notification', (x) => x.type === 'friend_request')).toBe(1);
    expect((await b.emitAck('notification:counts')).byType.friend_request).toBe(1);
    expect((await b.emitAck('social:setSettings', { mutedNotificationTypes: ['bogus'] })).error.code).toBe('INVALID_INPUT');
    closeAll(a, b, c, panel);
  });

  it('TEST-NOTIF-03: per-user cap drops the oldest notifications', async () => {
    const b = await live(strict);
    for (let i = 0; i < 5; i++) {
      const s = await registerUser(strict);
      await api(strict, s, 'POST', '/social/friends/requests', { username: b.user.username });
    }
    await sleep(200);
    expect((await b.emitAck('notification:counts')).total).toBe(3);
    b.close();
  });

  it('TEST-NOTIF-04: retention: scheduler purges expired notifications from the DB', async () => {
    const [a, b0] = [await live(retention), await live(retention)];
    await befriend(a, b0);
    b0.close();
    await sleep(100);
    await a.emitAck('dm:send', { toUserId: b0.user.userId, text: 'offline' });
    const b = await reconnect(retention, b0);
    expect((await b.waitFor('notification:backlog')).unreadCount).toBe(1);
    await sleep(5000);
    expect((await b.emitAck('notification:counts')).total).toBe(0);
    const db = dbOf(retention);
    const rows = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?', args: [b0.user.userId] });
    expect(Number(rows.rows[0].n)).toBe(0);
    db.close();
    closeAll(a, b);
  });

  it('TEST-NOTIF-05: friend_online goes to online friends on offline→online (not to offline friends/strangers); invisible is silent; mute suppresses', async () => {
    const [a, b, c, stranger] = [await live(hub), await live(hub), await live(hub), await live(hub)];
    await befriend(a, b);
    await befriend(a, c);
    c.close();
    await sleep(100);
    a.close();
    await sleep(200);
    const a2 = await reconnect(hub, a);
    const n = await b.waitFor('notification', (x) => x.type === 'friend_online' && x.payload.userId === a.user.userId);
    expect(n.payload.username).toBe(a.user.username);
    expect(stranger.count('notification', (x) => x.type === 'friend_online')).toBe(0);
    const c2 = await reconnect(hub, c);
    expect(((await c2.emitAck('notification:list')).notifications ?? []).filter((x: any) => x.type === 'friend_online')).toHaveLength(0);
    await a2.emitAck('social:setSettings', { status: 'invisible' });
    await b.waitFor('friend:presence', (p) => p.userId === a.user.userId && p.online === false);
    const before = b.count('notification', (x) => x.type === 'friend_online');
    await a2.emitAck('social:setSettings', { status: 'online' });
    await sleep(300);
    expect(b.count('notification', (x) => x.type === 'friend_online')).toBe(before + 1);
    await b.emitAck('social:setSettings', { mutedNotificationTypes: ['friend_online'] });
    a2.close();
    await sleep(200);
    const a3 = await reconnect(hub, a);
    await sleep(400);
    expect(b.count('notification', (x) => x.type === 'friend_online')).toBe(before + 1);
    closeAll(a3, b, c2, stranger);
  });
});

describe('Direct messages', () => {
  it('TEST-DM-01: only friends can DM; length and content validated', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    expect((await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'hi' })).error.code).toBe('NOT_FRIENDS');
    await befriend(a, b);
    expect((await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'x'.repeat(1001) })).error.code).toBe('MESSAGE_TOO_LONG');
    expect((await a.emitAck('dm:send', { toUserId: b.user.userId, text: '   ' })).error.code).toBe('INVALID_INPUT');
    expect((await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'x'.repeat(1000) })).ok).toBe(true);
    expect((await a.emitAck('dm:history', { withUserId: 'someone-else' })).error.code).toBe('NOT_FRIENDS');
    closeAll(a, b);
  });

  it('TEST-DM-02: live delivery to an online recipient: text unchanged (no markup processing), no extra notification', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    const sent = await a.emitAck('dm:send', { toUserId: b.user.userId, text: '<b>hi</b> & co' });
    expect(sent.message).toMatchObject({ from: a.user.userId, to: b.user.userId, text: '<b>hi</b> & co' });
    expect(sent.message.deliveredAt).toBeGreaterThan(0);
    expect((await b.waitFor('dm:received')).text).toBe('<b>hi</b> & co');
    expect((await b.emitAck('notification:counts')).byType.dm).toBeUndefined();
    closeAll(a, b);
  });

  it('TEST-DM-03: offline DM: collapsed notification, unread, dm:delivered on reconnect, dm:read on markRead', async () => {
    const [a, b0] = [await live(hub), await live(hub)];
    await befriend(a, b0);
    b0.close();
    await sleep(100);
    for (const t of ['eins', 'zwei', 'drei']) expect((await a.emitAck('dm:send', { toUserId: b0.user.userId, text: t })).message.deliveredAt).toBeUndefined();
    const b = await reconnect(hub, b0);
    const dmNotifs = (await b.waitFor('notification:backlog')).latest.filter((n: any) => n.type === 'dm');
    expect(dmNotifs).toHaveLength(1);
    expect(dmNotifs[0].payload).toMatchObject({ count: 3, fromUserId: a.user.userId });
    expect((await a.waitFor('dm:delivered')).messageIds).toHaveLength(3);
    const convs = (await b.emitAck('dm:conversations')).conversations;
    expect(convs[0]).toMatchObject({ withUserId: a.user.userId, unreadCount: 3 });
    expect(convs[0].lastMessage.text).toBe('drei');
    expect((await b.emitAck('dm:markRead', { withUserId: a.user.userId })).marked).toBe(3);
    expect((await a.waitFor('dm:read')).byUserId).toBe(b.user.userId);
    expect((await b.emitAck('notification:counts')).unread).toBe(0);
    expect((await a.emitAck('dm:history', { withUserId: b0.user.userId })).messages.map((m: any) => m.readAt !== undefined)).toEqual([true, true, true]);
    closeAll(a, b);
  });

  it('TEST-DM-04: history paginates chronologically with a backwards cursor', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    for (let i = 1; i <= 5; i++) await a.emitAck('dm:send', { toUserId: b.user.userId, text: `m${i}` });
    const p1 = await b.emitAck('dm:history', { withUserId: a.user.userId, limit: 2 });
    expect(p1.messages.map((m: any) => m.text)).toEqual(['m4', 'm5']);
    const p2 = await b.emitAck('dm:history', { withUserId: a.user.userId, limit: 2, before: p1.nextBefore });
    expect(p2.messages.map((m: any) => m.text)).toEqual(['m2', 'm3']);
    const p3 = await b.emitAck('dm:history', { withUserId: a.user.userId, limit: 2, before: p2.nextBefore });
    expect(p3.messages.map((m: any) => m.text)).toEqual(['m1']);
    expect(p3.nextBefore).toBeUndefined();
    closeAll(a, b);
  });

  it('TEST-DM-05: read cursor: dm:unread, dm:open (last 10 + pre-open markers), partial dm:markRead upToSeq, dm:readState push, peerLastReadSeq, receipts off', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    const sent: any[] = [];
    for (let i = 1; i <= 12; i++) sent.push((await a.emitAck('dm:send', { toUserId: b.user.userId, text: `m${i}` })).message);
    const unread = await b.emitAck('dm:unread');
    expect(unread.totalUnread).toBe(12);
    expect(unread.conversations[0]).toMatchObject({ withUserId: a.user.userId, unreadCount: 12, firstUnreadSeq: sent[0].seq, lastSeq: sent[11].seq });
    expect((await b.emitAck('social:sync')).conversations[0]).toMatchObject({ unreadCount: 12, firstUnreadSeq: sent[0].seq });
    expect((await api(hub, b.user, 'GET', '/social/dm/unread')).body.totalUnread).toBe(12);

    const part = await b.emitAck('dm:markRead', { withUserId: a.user.userId, upToSeq: sent[3].seq });
    expect(part).toMatchObject({ marked: 4, lastReadSeq: sent[3].seq, unreadCount: 8, totalUnread: 8 });
    expect((await b.waitFor('dm:readState')).unreadCount).toBe(8);
    expect((await a.waitFor('dm:read')).upToSeq).toBe(sent[3].seq);
    expect((await a.emitAck('dm:history', { withUserId: b.user.userId })).peerLastReadSeq).toBe(sent[3].seq);

    const opened = await b.emitAck('dm:open', { withUserId: a.user.userId });
    expect(opened.messages.map((m: any) => m.text)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12']);
    expect(opened).toMatchObject({ lastReadSeq: sent[3].seq, firstUnreadSeq: sent[4].seq, unreadCount: 8 });
    expect(opened.nextBefore).toBe(sent[2].seq);
    expect((await b.emitAck('dm:unread')).totalUnread).toBe(0);
    expect((await b.emitAck('dm:conversations')).conversations[0]).toMatchObject({ unreadCount: 0, lastReadSeq: sent[11].seq });
    expect((await a.emitAck('dm:history', { withUserId: b.user.userId })).peerLastReadSeq).toBe(sent[11].seq);
    const again = await b.emitAck('dm:open', { withUserId: a.user.userId, limit: 3 });
    expect(again).toMatchObject({ unreadCount: 0, lastReadSeq: sent[11].seq });
    expect(again.firstUnreadSeq).toBeUndefined();
    expect((await b.emitAck('dm:markRead', { withUserId: a.user.userId })).marked).toBe(0);
    await b.emitAck('social:setSettings', { dmReadReceipts: false });
    expect((await a.emitAck('dm:history', { withUserId: b.user.userId })).peerLastReadSeq).toBeUndefined();
    closeAll(a, b);
  });

  it('TEST-DM-06: unfriend deletes the history for both immediately; re-friending starts empty', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'geheim' });
    await a.emitAck('friend:remove', { friendId: b.user.userId });
    expect((await b.emitAck('dm:history', { withUserId: a.user.userId })).error.code).toBe('NOT_FRIENDS');
    expect((await b.emitAck('dm:conversations')).conversations).toEqual([]);
    await befriend(a, b);
    expect((await a.emitAck('dm:history', { withUserId: b.user.userId })).messages).toEqual([]);
    closeAll(a, b);
  });

  it('TEST-DM-07: per-conversation cap keeps the newest; flood limit answers RATE_LIMITED', async () => {
    const [a, b] = [await live(strict), await live(strict)];
    await befriend(a, b);
    for (let i = 1; i <= 4; i++) await a.emitAck('dm:send', { toUserId: b.user.userId, text: `c${i}` });
    expect((await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'c5' })).error.code).toBe('RATE_LIMITED');
    expect((await b.emitAck('dm:history', { withUserId: a.user.userId })).messages.map((m: any) => m.text)).toEqual(['c2', 'c3', 'c4']);
    closeAll(a, b);
  });

  it('TEST-DM-08: retention: scheduler deletes messages after DM_RETENTION_DAYS', async () => {
    const [a, b] = [await live(retention), await live(retention)];
    await befriend(a, b);
    await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'alt' });
    expect((await b.emitAck('dm:history', { withUserId: a.user.userId })).messages).toHaveLength(1);
    await sleep(5000);
    expect((await b.emitAck('dm:history', { withUserId: a.user.userId })).messages).toEqual([]);
    const db = dbOf(retention);
    const rows = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM direct_messages WHERE conversation_id = ?', args: [[a.user.userId, b.user.userId].sort().join(':')] });
    expect(Number(rows.rows[0].n)).toBe(0);
    db.close();
    closeAll(a, b);
  });

  it('TEST-DM-09: typing indicator is ephemeral; REST parity for send/history/list/read', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    expect((await a.emitAck('dm:typing', { toUserId: b.user.userId })).ok).toBe(true);
    expect((await b.waitFor('dm:typing')).fromUserId).toBe(a.user.userId);
    expect((await api(hub, a.user, 'POST', `/social/dm/${b.user.userId}`, { text: 'rest' })).status).toBe(201);
    expect((await api(hub, b.user, 'GET', `/social/dm/${a.user.userId}`)).body.messages.map((m: any) => m.text)).toContain('rest');
    expect((await api(hub, b.user, 'GET', '/social/dm')).body.conversations[0].withUserId).toBe(a.user.userId);
    expect((await api(hub, b.user, 'POST', `/social/dm/${a.user.userId}/read`)).body.marked).toBeGreaterThanOrEqual(1);
    expect((await api(hub, a.user, 'POST', '/social/dm/unknown', { text: 'x' })).body.code).toBe('NOT_FRIENDS');
    closeAll(a, b);
  });
});

describe('Lobby invites & friend lobbies', () => {
  const pair = async (h: TestHub, game = 'relay-nograce'): Promise<[TestClient, TestClient]> => {
    const [a, b] = [await live(h, game), await live(h, game)];
    await befriend(a, b);
    return [a, b];
  };

  it('TEST-INVITE-01: invite an online friend: event + notification; idempotent per (lobby, friend); accept joins even a private lobby', async () => {
    const [host, guest] = await pair(hub);
    const lobby = (await host.emitAck('createLobby', { name: 'priv', isPrivate: true })).lobby;
    const { invite } = await host.emitAck('lobby:invite', { friendId: guest.user.userId });
    expect(invite).toMatchObject({ lobbyId: lobby.id, fromUserId: host.user.userId });
    expect(invite.expiresAt - Date.now()).toBeGreaterThan(4 * 60_000);
    expect((await host.emitAck('lobby:invite', { friendId: guest.user.userId })).invite.inviteId).toBe(invite.inviteId);
    expect(guest.count('lobby:inviteReceived')).toBe(1);
    expect((await guest.waitFor('notification', (n) => n.type === 'lobby_invite')).payload.inviteId).toBe(invite.inviteId);
    expect((await guest.emitAck('lobby:acceptInvite', { inviteId: invite.inviteId })).ok).toBe(true);
    closeAll(host, guest);
  });

  it('TEST-INVITE-02: acceptInvite bypasses a lock; invite and notification disappear; reuse is INVITE_NOT_FOUND', async () => {
    const [host, guest] = await pair(hub);
    await host.emitAck('createLobby', { name: 'locked', isPrivate: true });
    await host.emitAck('lockLobby');
    const { invite } = await host.emitAck('lobby:invite', { friendId: guest.user.userId });
    expect((await guest.emitAck('lobby:invites')).invites).toHaveLength(1);
    const res = await guest.emitAck('lobby:acceptInvite', { inviteId: invite.inviteId });
    expect(res.lobby.players.map((p: any) => p.userId)).toContain(guest.user.userId);
    expect((await guest.emitAck('lobby:invites')).invites).toEqual([]);
    expect((await guest.emitAck('notification:counts')).byType.lobby_invite).toBeUndefined();
    expect((await guest.emitAck('lobby:acceptInvite', { inviteId: invite.inviteId })).error.code).toBe('INVITE_NOT_FOUND');
    closeAll(host, guest);
  });

  it('TEST-INVITE-03: declining informs the inviter (lobby:inviteDeclined); only the invitee may decline', async () => {
    const [host, guest] = await pair(hub);
    await host.emitAck('createLobby', { name: 'd' });
    const { invite } = await host.emitAck('lobby:invite', { friendId: guest.user.userId });
    expect((await host.emitAck('lobby:declineInvite', { inviteId: invite.inviteId })).error.code).toBe('INVITE_NOT_FOUND');
    expect((await guest.emitAck('lobby:declineInvite', { inviteId: invite.inviteId })).ok).toBe(true);
    expect((await host.waitFor('lobby:inviteDeclined')).userId).toBe(guest.user.userId);
    closeAll(host, guest);
  });

  it('TEST-INVITE-04: error paths: NOT_IN_LOBBY, NOT_FRIENDS, GAME_MISMATCH, FRIEND_OFFLINE, ALREADY_IN_LOBBY, NOT_HOST (inviteHostOnly)', async () => {
    const [host, guest] = await pair(hub);
    const stranger = await live(hub, 'relay-nograce');
    expect((await host.emitAck('lobby:invite', { friendId: guest.user.userId })).error.code).toBe('NOT_IN_LOBBY');
    await host.emitAck('createLobby', { name: 'x', settings: { inviteHostOnly: true } });
    expect((await host.emitAck('lobby:invite', { friendId: stranger.user.userId })).error.code).toBe('NOT_FRIENDS');
    const otherGame = await live(hub, 'other');
    await befriend(host, otherGame);
    expect((await host.emitAck('lobby:invite', { friendId: otherGame.user.userId })).error.code).toBe('GAME_MISMATCH');
    const offline = await live(hub, 'relay-nograce');
    await befriend(host, offline);
    offline.close();
    await sleep(150);
    expect((await host.emitAck('lobby:invite', { friendId: offline.user.userId })).error.code).toBe('FRIEND_OFFLINE');
    await guest.emitAck('joinLobby', { lobbyId: (await host.emitAck('getLobbyInfo')).lobby.id });
    expect((await host.emitAck('lobby:invite', { friendId: guest.user.userId })).error.code).toBe('ALREADY_IN_LOBBY');
    await befriend(guest, otherGame);
    expect((await guest.emitAck('lobby:invite', { friendId: otherGame.user.userId })).error.code).toBe('NOT_HOST');
    closeAll(host, guest, stranger, otherGame);
  });

  it('TEST-INVITE-05: full lobby: invites auto-cancel (lobby_full) and new invites fail with LOBBY_FULL', async () => {
    const [host, f1] = await pair(hub, 'relay');
    const f2 = await live(hub, 'relay');
    await befriend(host, f2);
    await host.emitAck('createLobby', { name: 'two' });
    const i1 = (await host.emitAck('lobby:invite', { friendId: f1.user.userId })).invite;
    const i2 = (await host.emitAck('lobby:invite', { friendId: f2.user.userId })).invite;
    expect((await f1.emitAck('lobby:acceptInvite', { inviteId: i1.inviteId })).ok).toBe(true);
    expect((await f2.waitFor('lobby:inviteCancelled', (e) => e.inviteId === i2.inviteId)).reason).toBe('lobby_full');
    expect((await f2.emitAck('lobby:acceptInvite', { inviteId: i2.inviteId })).error.code).toBe('INVITE_NOT_FOUND');
    const f3 = await live(hub, 'relay');
    await befriend(host, f3);
    expect((await host.emitAck('lobby:invite', { friendId: f3.user.userId })).error.code).toBe('LOBBY_FULL');
    closeAll(host, f1, f2, f3);
  });

  it('TEST-INVITE-06: invites are cancelled when the lobby is left/dissolved or by the inviter (cancelInvite)', async () => {
    const [host, guest] = await pair(hub);
    await host.emitAck('createLobby', { name: 'gone' });
    const { invite } = await host.emitAck('lobby:invite', { friendId: guest.user.userId });
    await host.emitAck('leaveLobby');
    expect(['lobby_closed', 'left']).toContain((await guest.waitFor('lobby:inviteCancelled', (e) => e.inviteId === invite.inviteId)).reason);
    await host.emitAck('createLobby', { name: 'again' });
    const second = (await host.emitAck('lobby:invite', { friendId: guest.user.userId })).invite;
    expect((await host.emitAck('lobby:cancelInvite', { inviteId: second.inviteId })).ok).toBe(true);
    expect((await guest.waitFor('lobby:inviteCancelled', (e) => e.inviteId === second.inviteId)).reason).toBe('cancelled');
    closeAll(host, guest);
  });

  it('TEST-INVITE-07: invites expire (LOBBY_INVITE_TTL_MS) with reason expired', async () => {
    const [host, guest] = await pair(strict);
    await host.emitAck('createLobby', { name: 'exp' });
    const { invite } = await host.emitAck('lobby:invite', { friendId: guest.user.userId });
    expect((await guest.waitFor('lobby:inviteCancelled', (e) => e.inviteId === invite.inviteId, 4000)).reason).toBe('expired');
    expect((await guest.emitAck('lobby:acceptInvite', { inviteId: invite.inviteId })).error.code).toBe('INVITE_NOT_FOUND');
    closeAll(host, guest);
  });

  it('TEST-INVITE-08: an unreached invite survives reconnect (notification backlog + lobby:invites pull)', async () => {
    const [host, guest0] = await pair(hub);
    await host.emitAck('createLobby', { name: 'persist' });
    const { invite } = await host.emitAck('lobby:invite', { friendId: guest0.user.userId });
    guest0.close();
    await sleep(150);
    const guest = await reconnect(hub, guest0, 'relay-nograce');
    expect((await guest.waitFor('notification:backlog')).latest.some((n: any) => n.type === 'lobby_invite' && n.payload.inviteId === invite.inviteId)).toBe(true);
    expect((await guest.emitAck('lobby:invites')).invites[0].inviteId).toBe(invite.inviteId);
    closeAll(host, guest);
  });

  it('TEST-INVITE-09: unfriending cancels open invites (reason unfriended)', async () => {
    const [host, guest] = await pair(hub);
    await host.emitAck('createLobby', { name: 'uf' });
    const { invite } = await host.emitAck('lobby:invite', { friendId: guest.user.userId });
    await host.emitAck('friend:remove', { friendId: guest.user.userId });
    expect((await guest.waitFor('lobby:inviteCancelled', (e) => e.inviteId === invite.inviteId)).reason).toBe('unfriended');
    closeAll(host, guest);
  });

  it('TEST-INVITE-10: joinFriend: open → direct join, locked → join request, private → only with invite, other game → GAME_MISMATCH', async () => {
    const [host, guest] = await pair(hub);
    const stranger = await live(hub, 'relay-nograce');
    expect((await guest.emitAck('lobby:joinFriend', { friendId: host.user.userId })).error.code).toBe('FRIEND_NOT_IN_LOBBY');
    expect((await stranger.emitAck('lobby:joinFriend', { friendId: host.user.userId })).error.code).toBe('NOT_FRIENDS');
    await host.emitAck('createLobby', { name: 'open' });
    expect(await guest.emitAck('lobby:joinFriend', { friendId: host.user.userId })).toMatchObject({ ok: true, pending: false });
    await guest.emitAck('leaveLobby');
    await host.emitAck('lockLobby');
    expect(await guest.emitAck('lobby:joinFriend', { friendId: host.user.userId })).toMatchObject({ ok: true, pending: true });
    expect((await host.waitFor('joinRequestReceived')).requesterId).toBe(guest.user.userId);
    await host.emitAck('respondJoinRequest', { requesterId: guest.user.userId, accept: true });
    await guest.waitFor('joinRequestAccepted');
    await guest.emitAck('leaveLobby');
    await host.emitAck('leaveLobby');
    await host.emitAck('createLobby', { name: 'priv', isPrivate: true });
    expect((await guest.emitAck('lobby:joinFriend', { friendId: host.user.userId })).error.code).toBe('LOBBY_PRIVATE');
    await host.emitAck('lobby:invite', { friendId: guest.user.userId });
    expect((await guest.emitAck('lobby:joinFriend', { friendId: host.user.userId })).ok).toBe(true);
    const other = await live(hub, 'other');
    await befriend(host, other);
    expect((await other.emitAck('lobby:joinFriend', { friendId: host.user.userId })).error.code).toBe('GAME_MISMATCH');
    closeAll(host, guest, stranger, other);
  });

  it('TEST-INVITE-11: social:friendLobby: friends only; a private lobby never reveals its ID', async () => {
    const [host, guest] = await pair(hub);
    const stranger = await live(hub, 'relay-nograce');
    expect((await host.emitAck('social:friendLobby', { friendId: guest.user.userId })).lobby).toBeNull();
    const pub = (await host.emitAck('createLobby', { name: 'pub' })).lobby;
    expect((await guest.emitAck('social:friendLobby', { friendId: host.user.userId })).lobby).toEqual({ lobbyId: pub.id, name: 'pub', players: 1, slots: 4, joinable: true, locked: false, hasInvite: false });
    expect((await stranger.emitAck('social:friendLobby', { friendId: host.user.userId })).error.code).toBe('NOT_FRIENDS');
    expect((await api(hub, guest.user, 'GET', `/social/friends/${host.user.userId}/lobby`)).body.lobby.lobbyId).toBe(pub.id);
    await host.emitAck('leaveLobby');
    await host.emitAck('createLobby', { name: 'priv', isPrivate: true });
    const priv = (await guest.emitAck('social:friendLobby', { friendId: host.user.userId })).lobby;
    expect(priv).toMatchObject({ name: 'priv', joinable: false, hasInvite: false });
    expect(priv.lobbyId).toBeUndefined();
    closeAll(host, guest, stranger);
  });
});

describe('Social snapshot', () => {
  it('TEST-SYNC-01: social:sync returns a consistent full state; GET /social/sync is identical', async () => {
    const [a, b, c] = [await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce')];
    await befriend(a, b);
    await c.emitAck('friend:request', { username: a.user.username });
    await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'hallo' });
    await a.emitAck('createLobby', { name: 'sync' });
    await a.emitAck('lobby:invite', { friendId: b.user.userId });
    await a.waitFor('friend:requestReceived');
    const snap = await b.emitAck('social:sync');
    expect(snap.friends).toEqual([{ userId: a.user.userId, username: a.user.username }]);
    expect(snap.presence).toHaveLength(1);
    expect(snap.lobbyInvites).toHaveLength(1);
    expect(snap.status).toBe('online');
    expect(snap.conversations).toMatchObject([{ withUserId: a.user.userId, unreadCount: 1 }]);
    expect(snap.unreadNotifications).toBe((await b.emitAck('notification:counts')).unread);
    expect((await a.emitAck('social:sync')).requests.incoming[0].user.userId).toBe(c.user.userId);
    const rest = await api(hub, b.user, 'GET', '/social/sync');
    const { ok: _ok, serverTime: _t1, ...socketPart } = snap;
    const { serverTime: _t2, ...restPart } = rest.body;
    expect(restPart).toEqual(socketPart);
    closeAll(a, b, c);
  });

  it('TEST-SYNC-02: etag: unchanged → notModified (socket + REST 304), changed → new etag', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    await sleep(100);
    const first = await a.emitAck('social:sync');
    expect(await a.emitAck('social:sync', { etag: first.etag })).toEqual({ ok: true, notModified: true, etag: first.etag });
    const res = await fetch(`${hub.url}/social/sync`, { headers: { Authorization: `Bearer ${a.user.accessToken}`, 'If-None-Match': first.etag } });
    expect(res.status).toBe(304);
    await a.emitAck('social:setSettings', { status: 'away' });
    const changed = await a.emitAck('social:sync', { etag: first.etag });
    expect(changed.notModified).toBeUndefined();
    expect(changed.etag).not.toBe(first.etag);
    expect(changed.status).toBe('away');
    closeAll(a, b);
  });

  it('TEST-SYNC-03: every REST pull route returns the same data as its socket event', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'p' });
    for (const [event, route] of [
      ['friend:list', '/social/friends'], ['friend:requests', '/social/friends/requests'], ['presence:friends', '/social/presence'],
      ['social:getSettings', '/social/settings'], ['notification:counts', '/social/notifications/counts'],
      ['notification:list', '/social/notifications'], ['dm:conversations', '/social/dm'], ['lobby:invites', '/social/lobby-invites'],
    ]) {
      const { ok: _ok, ...socketPart } = await b.emitAck(event);
      const viaRest = await api(hub, b.user, 'GET', route);
      expect(viaRest.status, route).toBe(200);
      expect(viaRest.body, route).toEqual(socketPart);
    }
    closeAll(a, b);
  });
});
