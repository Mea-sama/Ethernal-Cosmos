import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DataVisibility, ErrorCode, EthernalClient, EthernalError } from '../src';
import { startHub, type TestHub } from '../../server/test/helpers/hub';
import { Fleet, PASSWORD, befriend, rejectsWith, sleep, uname } from './helpers';

let hub: TestHub;
let fleet: Fleet;
beforeAll(async () => {
  hub = await startHub();
});
afterAll(async () => {
  await hub.stop();
});
afterEach(async () => {
  await fleet?.closeAll();
});

describe('kicks', () => {
  it('kickPlayer(reason) → playerKicked; KICKED_FROM_LOBBY until unkickPlayer', async () => {
    fleet = new Fleet(hub);
    const host = await fleet.player('other');
    const guest = await fleet.player('other');
    const lobby = await host.client.createLobby({ name: 'k' });
    await guest.client.joinLobby(lobby.id);

    await host.client.kickPlayer(guest.userId, 'afk');
    const [kick] = await guest.rec.waitFor('playerKicked');
    expect(kick).toEqual({ lobbyId: lobby.id, reason: 'afk' });
    expect((await rejectsWith(guest.client.joinLobby(lobby.id))).code).toBe(ErrorCode.KickedFromLobby);

    expect((await rejectsWith(guest.client.unkickPlayer(guest.userId))).code).toBe(ErrorCode.NotInLobby);
    await host.client.unkickPlayer(guest.userId);
    expect((await guest.client.joinLobby(lobby.id)).id).toBe(lobby.id);

    // without a reason the event has none
    await host.client.kickPlayer(guest.userId);
    await guest.rec.waitFor('playerKicked', (d: any) => d.reason === undefined);
  });
});

describe('atomic user data', () => {
  it('incrementUserData / setUserDataIf / transactUserData with VERSION_CONFLICT details', async () => {
    fleet = new Fleet(hub);
    const p = await fleet.player('other');
    expect(await p.client.incrementUserData('other', 'coins', 5)).toMatchObject({ key: 'coins', value: 5, version: 1 });
    expect(await p.client.incrementUserData('other', 'coins', -2, DataVisibility.Friends)).toMatchObject({ value: 3, version: 2 });
    expect((await p.client.getUserData('other')).find((e) => e.key === 'coins')?.visibility).toBe('friends');

    expect(await p.client.setUserDataIf('other', 'slot', 'a', 0)).toMatchObject({ value: 'a', version: 1 });
    const conflict = await rejectsWith(p.client.setUserDataIf('other', 'slot', 'b', 5));
    expect(conflict).toBeInstanceOf(EthernalError);
    expect(conflict.code).toBe(ErrorCode.VersionConflict);
    expect((conflict as EthernalError).data).toEqual({ current: { value: 'a', version: 1 } });
    const missing = await rejectsWith(p.client.setUserDataIf('other', 'nokey', 'x', 3));
    expect((missing as EthernalError).data).toEqual({ current: null });

    const results = await p.client.transactUserData('other', [
      { op: 'increment', key: 'coins', by: 10 },
      { op: 'setIf', key: 'slot', value: 'c', expectedVersion: 1 },
      { op: 'set', key: 'x', value: 1 },
      { op: 'delete', key: 'x' },
    ]);
    expect(results).toMatchObject([{ key: 'coins', value: 13, version: 3 }, { key: 'slot', value: 'c', version: 2 }, { key: 'x', version: 1 }, { key: 'x', version: 0 }]);

    // all-or-nothing: the failing setIf rolls back the increment
    const failed = await rejectsWith(p.client.transactUserData('other', [{ op: 'increment', key: 'coins', by: 1 }, { op: 'setIf', key: 'slot', value: 'd', expectedVersion: 99 }]));
    expect(failed.code).toBe(ErrorCode.VersionConflict);
    expect((await p.client.getUserData('other')).find((e) => e.key === 'coins')?.value).toBe(13);
  });

  it('clients cannot write `public` (socket and REST) and non-related players get NOT_ALLOWED', async () => {
    fleet = new Fleet(hub);
    const p = await fleet.player('other');
    const stranger = await fleet.player('other');
    expect((await rejectsWith(p.client.incrementUserData('other', 'score', 1, DataVisibility.Public))).code).toBe(ErrorCode.NotAllowed);
    expect((await rejectsWith(p.client.setKey('other', 'score', 1, DataVisibility.Public))).code).toBe(ErrorCode.NotAllowed);
    expect((await rejectsWith(stranger.client.getPlayerData(p.userId, 'other'))).code).toBe(ErrorCode.NotAllowed);
  });

  it('`friends` visibility is readable by friends only', async () => {
    fleet = new Fleet(hub);
    const owner = await fleet.player('other');
    const friend = await fleet.player('other');
    const stranger = await fleet.player('other');
    await owner.client.setUserData('other', 'motto', 'hi', DataVisibility.Friends);
    await owner.client.setUserData('other', 'secret', 'no');
    await befriend(owner, friend);
    const seen = await friend.client.getPlayerData(owner.userId, 'other');
    expect(seen.map((e) => e.key)).toEqual(['motto']);
    expect((await rejectsWith(stranger.client.getPlayerData(owner.userId, 'other'))).code).toBe(ErrorCode.NotAllowed);
  });
});

describe('blocks', () => {
  it('blockUser / getBlockedUsers / unblockUser; blocking ends the friendship', async () => {
    fleet = new Fleet(hub);
    const a = await fleet.player('other');
    const b = await fleet.player('other');
    await befriend(a, b);
    const blocked = await a.client.blockUser(b.userId);
    expect(blocked).toMatchObject({ userId: b.userId, username: b.username, blockedAt: expect.any(Number) });
    await a.client.blockUser(b.userId); // idempotent
    expect((await a.client.getBlockedUsers()).map((x) => x.userId)).toEqual([b.userId]);
    expect(await a.client.listFriends()).toEqual([]);
    expect((await rejectsWith(a.client.blockUser(a.userId))).code).toBe(ErrorCode.CannotTargetSelf);
    await a.client.unblockUser(b.userId);
    await a.client.unblockUser(b.userId);
    expect(await a.client.getBlockedUsers()).toEqual([]);
  });
});

describe('account', () => {
  it('changePassword returns and stores fresh tokens, keeps this session and replaces the others', async () => {
    fleet = new Fleet(hub);
    const p = await fleet.player('other');
    const second = fleet.track(new EthernalClient({ serverUrl: hub.url, clientType: 'panel' }));
    const events: string[] = [];
    second.on('session:replaced', (d) => events.push(d.reason));
    await second.login(p.username, PASSWORD);

    expect((await rejectsWith(p.client.changePassword('wrong-password', 'newpassword1'))).code).toBe(ErrorCode.InvalidCredentials);
    expect((await rejectsWith(p.client.changePassword(PASSWORD, 'short'))).code).toBe(ErrorCode.InvalidInput);
    const auth = await p.client.changePassword(PASSWORD, 'newpassword1');
    expect(auth.user.id).toBe(p.userId);
    expect(auth.accessToken).toBeTruthy();
    await sleep(200);
    expect(events).toEqual(['password_changed']);

    // the calling session keeps working (socket and REST) with the stored tokens
    await p.client.setUserData('other', 'k', 1);
    expect((await p.client.getAllData('other')).map((e) => e.key)).toContain('k');
    await p.client.refreshSocketAuth();

    const fresh = fleet.track(new EthernalClient({ serverUrl: hub.url }));
    expect((await rejectsWith(fresh.login(p.username, PASSWORD))).code).toBe(ErrorCode.InvalidCredentials);
    await fresh.login(p.username, 'newpassword1');
  });

  it('exportAccountData returns own data; deleteAccount purges it', async () => {
    fleet = new Fleet(hub);
    const a = await fleet.player('other');
    const b = await fleet.player('other');
    await befriend(a, b);
    await a.client.setUserData('other', 'level', 7);
    await a.client.blockUser((await fleet.player()).userId);
    const dump = await a.client.exportAccountData();
    expect(dump.profile).toMatchObject({ id: a.userId, username: a.username });
    expect(dump.userData.map((e) => e.key)).toContain('level');
    expect(dump.friends.map((f) => f.userId)).toEqual([b.userId]);
    expect(dump.blocks).toHaveLength(1);
    expect(JSON.stringify(dump)).not.toMatch(/passwordHash|password_hash/);

    expect((await rejectsWith(a.client.deleteAccount('wrong-password'))).code).toBe(ErrorCode.InvalidCredentials);
    await a.client.deleteAccount(PASSWORD);
    await b.rec.waitFor('friend:removed', (d: any) => d.userId === a.userId && d.reason === 'account_deleted');
    const again = fleet.track(new EthernalClient({ serverUrl: hub.url }));
    expect((await rejectsWith(again.login(a.username, PASSWORD))).code).toBe(ErrorCode.InvalidCredentials);
    await rejectsWith(a.client.exportAccountData());
  });
});

describe('rate limits', () => {
  let limited: TestHub;
  beforeAll(async () => {
    limited = await startHub({
      limits: {
        restRateLimits: { userdata: { windowMs: 60000, max: 1000 }, players: { windowMs: 60000, max: 1000 }, leaderboard: { windowMs: 60000, max: 2 }, social: { windowMs: 60000, max: 1000 } },
        socketLimits: { friendRequestByName: { refillPerSecond: 0.01, burst: 2 } },
        caps: { maxSessionsPerUser: 2, maxConnectionsPerIp: 1000, maxLobbiesPerGame: 1000, maxLobbiesTotal: 1000, maxPendingJoinRequestsPerLobby: 1000, maxGameServersPerGame: 1000, maxGameServerConnectionsPerIp: 1000, capRetryAfterMs: 1234 },
      },
    });
  });
  afterAll(async () => {
    await limited.stop();
  });

  it('REST, ack and handshake rate limits surface RATE_LIMITED with retryAfterMs', async () => {
    fleet = new Fleet(limited);
    const p = await fleet.player('other');
    await p.client.getLeaderboard('gs-opt', 'x').catch(() => undefined);
    await p.client.getLeaderboard('gs-opt', 'x').catch(() => undefined);
    const rest = await rejectsWith(p.client.getLeaderboard('gs-opt', 'x'));
    expect(rest.code).toBe(ErrorCode.RateLimited);
    expect((rest as EthernalError).retryAfterMs).toBeGreaterThan(0);

    await p.client.requestFriendByName(uname('nobody'));
    await p.client.requestFriendByName(uname('nobody'));
    const ack = await rejectsWith(p.client.requestFriendByName(uname('nobody')));
    expect(ack.code).toBe(ErrorCode.RateLimited);
    expect((ack as EthernalError).retryAfterMs).toBeGreaterThan(0);

    // third concurrent session of the same user is refused at the handshake
    const panel1 = fleet.track(new EthernalClient({ serverUrl: limited.url, clientType: 'panel' }));
    await panel1.login(p.username, PASSWORD);
    const panel2 = fleet.track(new EthernalClient({ serverUrl: limited.url, clientType: 'panel' }));
    const hs = await rejectsWith(panel2.login(p.username, PASSWORD));
    expect(hs.code).toBe(ErrorCode.RateLimited);
    expect((hs as EthernalError).retryAfterMs).toBe(1234);
  });
});
