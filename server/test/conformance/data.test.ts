import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, closeAll, gameServer, live, sleep, startHub, type GsClient, type TestClient, type TestHub } from './util';

let hub: TestHub;
beforeAll(async () => { hub = await startHub(); });
afterAll(async () => { await hub.stop(); });

/** A game server plus a lobby on `gs-opt` with one member per client */
async function gsLobby(players = 1): Promise<{ gs: GsClient; clients: TestClient[]; lobbyId: string }> {
  const gs = await gameServer(hub, 'gs-opt');
  const clients = [await live(hub, 'gs-opt')];
  const lobbyId = (await clients[0].emitAck('createLobby', { name: 'gsdata' })).lobby.id;
  await gs.waitFor('lobby:assigned');
  for (let i = 1; i < players; i++) {
    const c = await live(hub, 'gs-opt');
    await c.emitAck('joinLobby', { lobbyId });
    clients.push(c);
  }
  return { gs, clients, lobbyId };
}

describe('Server-authoritative data (#55)', () => {
  it('TEST-DATA-08: clients cannot set visibility public (NOT_ALLOWED over REST, socket, bulk); no downgrade', async () => {
    const c = await live(hub, 'gs-opt');
    const u = c.user;
    expect(await api(hub, u, 'PUT', '/userdata/gs-opt/s', { value: 1, visibility: 'public' })).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } });
    expect((await api(hub, u, 'PATCH', '/userdata/gs-opt', [{ key: 'ok', value: 1 }, { key: 's', value: 1, visibility: 'public' }])).body.code).toBe('NOT_ALLOWED');
    expect((await c.emitAck('setUserData', { gameId: 'gs-opt', key: 's', value: 1, visibility: 'public' })).error.code).toBe('NOT_ALLOWED');
    expect((await c.emitAck('bulkSetUserData', { gameId: 'gs-opt', entries: [{ key: 's', value: 1, visibility: 'public' }] })).error.code).toBe('NOT_ALLOWED');
    expect((await api(hub, u, 'GET', '/userdata/gs-opt')).body).toEqual([]);
    c.close();
  });

  it('TEST-DATA-09: subprocess (hub-hosted, serverSupport none) cannot create public leaderboard keys; private SAVE_META still works', async () => {
    const host = await live(hub, 'fake');
    await host.emitAck('createLobby', { name: 'd' });
    host.socket.emit('gameAction', { type: 'save', payload: { gameId: 'fake', value: 1, visibility: 'public' } });
    await sleep(800);
    expect((await api(hub, host.user, 'GET', '/userdata/fake/rank.points')).status).toBe(404);
    host.socket.emit('gameAction', { type: 'save', payload: { gameId: 'fake', value: 2 } });
    for (let i = 0; i < 50 && (await api(hub, host.user, 'GET', '/userdata/fake/rank.points')).status !== 200; i++) await sleep(100);
    expect((await api(hub, host.user, 'GET', '/userdata/fake/rank.points')).body).toMatchObject({ value: 2, visibility: 'private', writeScope: 'server' });
    host.close();
  });
});

describe('Game-server data writes (#55)', () => {
  it('TEST-GSDATA-01: server writes for lobby members; public implies server scope; client cannot overwrite; owner reads it', async () => {
    const { gs, clients: [a], lobbyId } = await gsLobby();
    const set = await gs.emitAck('data:set', { lobbyId, userId: a.user.userId, key: 'result', value: { wins: 3 }, visibility: 'public' });
    expect(set.ok).toBe(true);
    expect((await api(hub, a.user, 'GET', '/userdata/gs-opt/result')).body).toMatchObject({ value: { wins: 3 }, visibility: 'public', writeScope: 'server', version: 1 });
    expect((await api(hub, a.user, 'PUT', '/userdata/gs-opt/result', { value: 99 })).body.code).toBe('DATA_READ_ONLY');
    expect((await api(hub, a.user, 'DELETE', '/userdata/gs-opt/result')).body.code).toBe('DATA_READ_ONLY');
    const bulk = await gs.emitAck('data:bulk', { lobbyId, userId: a.user.userId, entries: [{ key: 'xp', value: 5, writeScope: 'server' }, { key: 'result', value: { wins: 4 } }] });
    expect(bulk.ok).toBe(true);
    const got = await gs.emitAck('data:get', { lobbyId, userId: a.user.userId });
    expect(got.entries.map((e: any) => [e.key, e.version])).toEqual([['result', 2], ['xp', 1]]);
    closeAll(a, gs);
  });

  it('TEST-GSDATA-02: non-members, foreign lobbies, other servers and bad input are rejected; bulk is all-or-nothing', async () => {
    const { gs, clients: [a, b], lobbyId } = await gsLobby(2);
    const other = await gameServer(hub, 'gs-opt');
    const stranger = await live(hub, 'gs-opt');
    const base = { lobbyId, key: 'k', value: 1 };
    expect((await gs.emitAck('data:set', { ...base, userId: stranger.user.userId })).error.code).toBe('NOT_ALLOWED');
    expect((await gs.emitAck('data:set', { ...base, userId: 'nobody' })).error.code).toBe('NOT_ALLOWED');
    expect((await gs.emitAck('data:set', { ...base, lobbyId: 'no-such-lobby', userId: a.user.userId })).error.code).toBe('NOT_ALLOWED');
    expect((await other.emitAck('data:set', { ...base, userId: a.user.userId })).error.code).toBe('NOT_ALLOWED');
    expect((await other.emitAck('data:get', { lobbyId, userId: a.user.userId })).error.code).toBe('NOT_ALLOWED');
    expect((await gs.emitAck('data:set', { ...base, userId: a.user.userId, key: 'bad key!' })).error.code).toBe('INVALID_INPUT');
    const big = await gs.emitAck('data:bulk', { lobbyId, userId: b.user.userId, entries: [{ key: 'ok', value: 1 }, { key: 'big', value: 'x'.repeat(20000) }] });
    expect(big.error.code).toBe('DATA_VALUE_TOO_LARGE');
    expect((await api(hub, b.user, 'GET', '/userdata/gs-opt')).body).toEqual([]);
    closeAll(a, b, stranger, gs, other);
  });

  it('TEST-GSDATA-03: server may still write for members who left or after the lobby closed (60 s window)', async () => {
    const { gs, clients: [a, b], lobbyId } = await gsLobby(2);
    await b.emitAck('leaveLobby');
    expect((await gs.emitAck('data:set', { lobbyId, userId: b.user.userId, key: 'after-leave', value: 1 })).ok).toBe(true);
    expect((await gs.emitAck('lobby:close', { lobbyId })).ok).toBe(true);
    expect((await gs.emitAck('data:set', { lobbyId, userId: a.user.userId, key: 'after-close', value: 2, visibility: 'public' })).ok).toBe(true);
    closeAll(a, b, gs);
  });

  it('TEST-GSDATA-04: games without server support accept no public data from any actor', async () => {
    const c = await live(hub, 'relay');
    expect(await api(hub, c.user, 'PUT', '/userdata/relay/x', { value: 1, visibility: 'public' })).toMatchObject({ status: 403, body: { code: 'NOT_ALLOWED' } });
    const lb = await api(hub, c.user, 'GET', '/userdata/relay');
    expect(lb.body).toEqual([]);
    c.close();
  });
});
