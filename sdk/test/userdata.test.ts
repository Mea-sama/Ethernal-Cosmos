import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DataVisibility, DataWriteScope, ErrorCode } from '../src';
import { connectGameServer, issueServerKey, startHub, type TestHub } from '../../server/test/helpers/hub';
import { Fleet, rejectsWith, sleep, uname } from './helpers';

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

const keys = (entries: Array<{ key: string }>) => entries.map((e) => e.key);

describe('user data (socket)', () => {
  it('setUserData / getUserData / deleteUserData with visibility, plus the userData event', async () => {
    fleet = new Fleet(hub);
    const p = await fleet.player('other');
    await p.client.setUserData('other', 'level', 5);
    await p.client.setUserData('other', 'title', 'Knight', DataVisibility.Lobby);
    // `public` marks leaderboard keys and can only be set by a game server
    expect((await rejectsWith(p.client.setUserData('other', 'x', 1, DataVisibility.Public))).code).toBe(ErrorCode.NotAllowed);
    const entries = await p.client.getUserData('other');
    expect(entries.find((e) => e.key === 'level')).toMatchObject({ value: 5, visibility: DataVisibility.Private, writeScope: DataWriteScope.Client, version: 1 });
    expect(entries.find((e) => e.key === 'title')).toMatchObject({ value: 'Knight', visibility: 'lobby', updatedAt: expect.any(Number) });
    const [evt] = await p.rec.waitFor('userData', (d: any) => d.gameId === 'other');
    expect(keys(evt.entries)).toEqual(expect.arrayContaining(['level', 'title']));

    await p.client.setUserData('other', 'level', 6);
    expect((await p.client.getUserData('other')).find((e) => e.key === 'level')).toMatchObject({ value: 6, version: 2 });
    await p.client.deleteUserData('other', 'level');
    expect(keys(await p.client.getUserData('other'))).not.toContain('level');
  });

  it('bulkSetUserData writes atomically', async () => {
    fleet = new Fleet(hub);
    const p = await fleet.player('other');
    await p.client.bulkSetUserData('other', [
      { key: 'a', value: 1 },
      { key: 'b', value: { nested: true }, visibility: DataVisibility.Lobby },
    ]);
    const entries = await p.client.getUserData('other');
    expect(entries.find((e) => e.key === 'b')).toMatchObject({ value: { nested: true }, visibility: 'lobby' });
    // an invalid entry rejects the whole batch
    await rejectsWith(p.client.bulkSetUserData('other', [{ key: 'ok-key', value: 1 }, { key: 'bad key!', value: 2 }]));
    expect(keys(await p.client.getUserData('other'))).not.toContain('ok-key');
  });

  it('getPlayerData / playerData: lobby only for lobby mates, private never', async () => {
    fleet = new Fleet(hub);
    const owner = await fleet.player('other');
    const mate = await fleet.player('other');
    const stranger = await fleet.player('other');
    await owner.client.bulkSetUserData('other', [
      { key: 'lob', value: 2, visibility: DataVisibility.Lobby },
      { key: 'priv', value: 3, visibility: DataVisibility.Private },
    ]);
    expect((await rejectsWith(stranger.client.getPlayerData(owner.userId, 'other'))).code).toBe(ErrorCode.NotAllowed);
    const lobby = await owner.client.createLobby({ name: 'data' });
    await mate.client.joinLobby(lobby.id);
    const visible = keys(await mate.client.getPlayerData(owner.userId, 'other'));
    expect(visible).toEqual(['lob']);
    expect(visible).not.toContain('priv');
    const [evt] = await mate.rec.waitFor('playerData', (d: any) => d.playerId === owner.userId);
    expect(evt.gameId).toBe('other');
    expect(keys(evt.entries)).toContain('lob');
    expect((await rejectsWith(mate.client.getPlayerData(owner.userId, 'no-such-game'))).code).toBe(ErrorCode.UnknownGame);
  });

  it('server-written keys are read-only for clients; unknown games are rejected', async () => {
    fleet = new Fleet(hub);
    const p = await fleet.player('fake');
    expect((await rejectsWith(p.client.setUserData('fake', 'rank.points', 999))).code).toBe(ErrorCode.DataReadOnly);
    expect((await rejectsWith(p.client.bulkSetUserData('fake', [{ key: 'rank.points', value: 1 }]))).code).toBe(ErrorCode.DataReadOnly);
    expect((await rejectsWith(p.client.deleteUserData('fake', 'rank.points'))).code).toBe(ErrorCode.DataReadOnly);
    expect((await rejectsWith(p.client.setUserData('nope', 'k', 1))).code).toBe(ErrorCode.UnknownGame);
    expect((await rejectsWith(p.client.getUserData('nope'))).code).toBe(ErrorCode.UnknownGame);
  });

  it('a game subprocess can write server-scoped keys that the client reads (writeScope server)', async () => {
    fleet = new Fleet(hub);
    const p = await fleet.player('fake');
    await p.client.createLobby({ name: 'save' });
    await p.rec.waitFor('gameStarting');
    await p.client.sendGameAction('save', { gameId: 'fake', value: 42 });
    let entry;
    for (let i = 0; i < 50 && !entry; i++) {
      entry = (await p.client.getUserData('fake')).find((e) => e.key === 'rank.points');
      if (!entry) await sleep(100);
    }
    expect(entry).toMatchObject({ value: 42, writeScope: DataWriteScope.Server, visibility: 'private' });
  });
});

describe('user data (REST) and leaderboard', () => {
  it('setKey / getAllData / bulkSet / deleteKey', async () => {
    fleet = new Fleet(hub);
    const p = await fleet.player();
    await p.client.setKey('other', 'wins', 3, DataVisibility.Lobby);
    await p.client.setKey('other', 'note', 'hi');
    let all = await p.client.getAllData('other');
    expect(all.find((e) => e.key === 'wins')).toMatchObject({ value: 3, visibility: 'lobby' });
    expect(all.find((e) => e.key === 'note')).toMatchObject({ value: 'hi', visibility: 'private' });

    await p.client.bulkSet('other', [{ key: 'x', value: 1 }, { key: 'y', value: 2, visibility: DataVisibility.Lobby }]);
    all = await p.client.getAllData('other');
    expect(keys(all)).toEqual(expect.arrayContaining(['x', 'y', 'wins', 'note']));

    await p.client.deleteKey('other', 'x');
    await p.client.deleteKey('other', 'x'); // no-op
    expect(keys(await p.client.getAllData('other'))).not.toContain('x');
    // visible through the socket API as well
    expect(keys(await p.client.getUserData('other'))).toContain('y');
  });

  it('REST errors are EthernalErrors with ErrorCode values', async () => {
    fleet = new Fleet(hub);
    const p = await fleet.player();
    expect((await rejectsWith(p.client.setKey('fake', 'rank.points', 1))).code).toBe(ErrorCode.DataReadOnly);
    expect((await rejectsWith(p.client.getAllData('nope'))).code).toBe(ErrorCode.UnknownGame);
    expect((await rejectsWith(p.client.bulkSet('other', []))).code).toBe(ErrorCode.InvalidInput);
  });

  it('getLeaderboard sorts public numeric values written by a game server, supports order and limit', async () => {
    fleet = new Fleet(hub);
    const key = `score${uname('')}`.slice(0, 40);
    const { key: serverKey } = await issueServerKey(hub, 'gs-opt');
    const gs = await connectGameServer(hub, { serverKey, gameId: 'gs-opt', serverId: uname('sdk-lb') });
    try {
      const low = await fleet.player('gs-opt');
      const mid = await fleet.player('gs-opt');
      const high = await fleet.player('gs-opt');
      const hidden = await fleet.player('gs-opt');
      const lobby = await low.client.createLobby({ name: 'lb' });
      for (const p of [mid, high, hidden]) await p.client.joinLobby(lobby.id);
      const write = (p: typeof low, value: number, visibility?: string) =>
        gs.emitAck('data:set', { lobbyId: lobby.id, userId: p.userId, key, value, visibility });
      for (const [p, v] of [[low, 10], [mid, 20], [high, 30]] as const) await write(p, v, 'public');
      await write(hidden, 99);

      const desc = await low.client.getLeaderboard('gs-opt', key);
      expect(desc.map((e) => e.userId)).toEqual([high.userId, mid.userId, low.userId]);
      expect(desc[0]).toMatchObject({ username: high.username, value: 30, updatedAt: expect.any(Number) });
      const asc = await low.client.getLeaderboard('gs-opt', key, { order: 'asc', limit: 2 });
      expect(asc.map((e) => e.value)).toEqual([10, 20]);
      expect(await low.client.getLeaderboard('gs-opt', 'no-such-key')).toEqual([]);
    } finally {
      gs.close();
    }
  });
});
