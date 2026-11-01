import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, befriend, closeAll, FAST_SOCIAL, live, registerUser, sleep, startHub, type TestHub } from './util';

let hub: TestHub;
beforeAll(async () => { hub = await startHub({ env: FAST_SOCIAL }); });
afterAll(async () => { await hub.stop(); });

describe('Block list', () => {
  it('TEST-BLOCK-01: block drops friendship, pending requests and invites; list/unblock via socket and REST', async () => {
    const [a, b, c] = [await live(hub), await live(hub), await live(hub)];
    await befriend(a, b);
    await a.emitAck('createLobby', { name: 'inv' });
    await a.emitAck('lobby:invite', { friendId: b.user.userId });
    await b.waitFor('lobby:inviteReceived');
    await a.emitAck('friend:request', { username: c.user.username });
    await c.waitFor('friend:requestReceived');

    const res = await a.emitAck('block:add', { userId: b.user.userId });
    expect(res).toMatchObject({ ok: true, blocked: { userId: b.user.userId, username: b.user.username } });
    await b.waitFor('friend:removed', (e) => e.userId === a.user.userId);
    await b.waitFor('lobby:inviteCancelled');
    expect((await a.emitAck('friend:list')).friends).toEqual([]);
    expect((await b.emitAck('lobby:invites')).invites).toEqual([]);
    expect((await a.emitAck('block:add', { userId: b.user.userId })).blocked.userId).toBe(b.user.userId);

    expect((await a.emitAck('block:add', { userId: c.user.userId })).ok).toBe(true);
    await c.waitFor('friend:requestCancelled');
    expect((await c.emitAck('friend:requests')).incoming).toEqual([]);

    expect((await a.emitAck('block:list')).blocks.map((x: any) => x.userId).sort()).toEqual([b.user.userId, c.user.userId].sort());
    expect((await a.emitAck('block:add', { userId: a.user.userId })).error.code).toBe('CANNOT_TARGET_SELF');
    expect((await a.emitAck('block:add', { userId: 'nope' })).error.code).toBe('USER_NOT_FOUND');
    expect((await a.emitAck('block:add', {})).error.code).toBe('INVALID_INPUT');

    const rest = await registerUser(hub);
    expect((await api(hub, rest, 'POST', '/social/blocks', { userId: b.user.userId })).body.blocked.userId).toBe(b.user.userId);
    expect((await api(hub, rest, 'GET', '/social/blocks')).body.blocks).toHaveLength(1);
    expect((await api(hub, rest, 'DELETE', `/social/blocks/${b.user.userId}`)).status).toBe(200);
    expect((await api(hub, rest, 'GET', '/social/blocks')).body.blocks).toEqual([]);
    expect((await fetch(`${hub.url}/social/blocks`)).status).toBe(401);

    expect((await a.emitAck('block:remove', { userId: c.user.userId })).ok).toBe(true);
    expect((await a.emitAck('block:remove', { userId: c.user.userId })).ok).toBe(true);
    expect((await a.emitAck('block:list')).blocks.map((x: any) => x.userId)).toEqual([b.user.userId]);
    closeAll(a, b, c);
  });

  it('TEST-BLOCK-02: no information leak: the blocked user sees the same results as towards a stranger', async () => {
    const [a, b, stranger] = [await live(hub), await live(hub), await live(hub)];
    await a.emitAck('block:add', { userId: b.user.userId });
    const seenBefore = b.events.length;

    const sendBlocked = await b.emitAck('friend:request', { username: a.user.username });
    const sendStranger = await b.emitAck('friend:request', { username: stranger.user.username });
    expect(sendBlocked).toEqual(sendStranger);
    expect(sendBlocked).toEqual({ ok: true, result: 'REQUEST_SENT' });
    expect((await b.emitAck('friend:requests')).outgoing.map((r: any) => r.user.userId).sort()).toEqual([a.user.userId, stranger.user.userId].sort());

    const dmBlocked = await b.emitAck('dm:send', { toUserId: a.user.userId, text: 'hi' });
    const dmStranger = await b.emitAck('dm:send', { toUserId: stranger.user.userId, text: 'hi' });
    expect(dmBlocked.error.code).toBe('NOT_FRIENDS');
    expect(dmBlocked.error.code).toBe(dmStranger.error.code);
    const inviteBlocked = await b.emitAck('lobby:invite', { friendId: a.user.userId });
    const inviteStranger = await b.emitAck('lobby:invite', { friendId: stranger.user.userId });
    expect(inviteBlocked.error.code).toBe(inviteStranger.error.code);

    await sleep(200);
    // blocker sees nothing, the blocked user receives no block-related event
    expect(a.count('friend:requestReceived')).toBe(0);
    expect(a.count('notification', (n) => n.type === 'friend_request')).toBe(0);
    expect((await a.emitAck('friend:requests')).incoming).toEqual([]);
    expect((await a.emitAck('notification:counts')).total).toBe(0);
    expect(b.events.slice(seenBefore).filter((e) => e.event.startsWith('block:') || e.event === 'friend:requestDeclined')).toEqual([]);
    expect((await b.emitAck('block:list')).blocks).toEqual([]);
    expect((await a.emitAck('social:sync')).requests.incoming).toEqual([]);
    expect(stranger.count('friend:requestReceived')).toBe(1);

    // cancelling the ignored request does not tell the blocker anything either
    const mine = (await b.emitAck('friend:requests')).outgoing.find((r: any) => r.user.userId === a.user.userId);
    expect((await b.emitAck('friend:cancel', { requestId: mine.id })).ok).toBe(true);
    await sleep(100);
    expect(a.count('friend:requestCancelled')).toBe(0);
    closeAll(a, b, stranger);
  });

  it('TEST-BLOCK-03: presence and DMs are hidden both ways; blocking does not touch the shared lobby; unblock restores nothing', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'before' });
    await a.emitAck('block:add', { userId: b.user.userId });
    expect((await a.emitAck('presence:friends')).presence).toEqual([]);
    expect((await b.emitAck('presence:friends')).presence).toEqual([]);
    expect((await a.emitAck('dm:history', { withUserId: b.user.userId })).error.code).toBe('NOT_FRIENDS');
    expect((await b.emitAck('dm:conversations')).conversations).toEqual([]);

    // a later status change is not pushed to either side
    const before = b.count('friend:presence');
    await a.emitAck('social:setSettings', { status: 'busy' });
    await sleep(150);
    expect(b.count('friend:presence')).toBe(before);

    const { lobby } = await a.emitAck('createLobby', { name: 'shared' });
    const joined = await b.emitAck('joinLobby', { lobbyId: lobby.id });
    expect(joined.ok).toBe(true);
    const relayed = b.waitFor('message');
    await a.emitAck('sendToLobby', { type: 'x', payload: 1 });
    expect((await relayed).type).toBe('x');

    // lobby-mate request from the blocked user is ignored
    expect(await b.emitAck('friend:request', { userId: a.user.userId })).toEqual({ ok: true, result: 'REQUEST_SENT' });
    await sleep(100);
    expect(a.count('friend:requestReceived')).toBe(0);

    // unblocking does not deliver the earlier request nor recreate the friendship
    await a.emitAck('block:remove', { userId: b.user.userId });
    await sleep(100);
    expect(a.count('friend:requestReceived')).toBe(0);
    expect((await a.emitAck('friend:requests')).incoming).toEqual([]);
    expect((await a.emitAck('friend:list')).friends).toEqual([]);
    expect((await b.emitAck('friend:requests')).outgoing).toEqual([]);
    expect((await a.emitAck('dm:conversations')).conversations).toEqual([]);

    // after unblocking a fresh request is delivered normally
    await b.emitAck('friend:request', { userId: a.user.userId });
    await a.waitFor('friend:requestReceived');
    closeAll(a, b);
  });

  it('TEST-BLOCK-04: requests towards a user you blocked are ignored; crossing requests cannot create a friendship through a block', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await b.emitAck('friend:request', { username: a.user.username });
    await a.waitFor('friend:requestReceived');
    await a.emitAck('block:add', { userId: b.user.userId });
    // blocker "accepts" the old request id: it no longer exists
    expect((await a.emitAck('friend:requests')).incoming).toEqual([]);
    // blocker requests the blocked user: stored for the blocker only, never delivered
    expect(await a.emitAck('friend:request', { username: b.user.username })).toEqual({ ok: true, result: 'REQUEST_SENT' });
    await sleep(100);
    expect(b.count('friend:requestReceived')).toBe(0);
    expect((await b.emitAck('friend:requests')).incoming).toEqual([]);
    // the blocked user answering with a request must not auto-accept the crossing one
    await b.emitAck('friend:request', { username: a.user.username });
    await sleep(100);
    expect((await a.emitAck('friend:list')).friends).toEqual([]);
    expect(a.count('friend:requestAccepted')).toBe(0);
    closeAll(a, b);
  });
});
