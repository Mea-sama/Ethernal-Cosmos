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

describe('Atomic data operations (#38)', () => {
  it('TEST-DATA-10: parallel increments sum exactly; missing key counts as 0; delta may be negative/fractional', async () => {
    const c = await live(hub, 'gs-opt');
    const rs = await Promise.all(Array.from({ length: 20 }, () => c.emitAck('incrementUserData', { gameId: 'gs-opt', key: 'cnt', by: 1 })));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(rs.map((r) => r.version).sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const rest = await api(hub, c.user, 'POST', '/userdata/gs-opt/cnt/increment', { by: -2.5 });
    expect(rest.body).toMatchObject({ key: 'cnt', value: 17.5, version: 21 });
    expect((await api(hub, c.user, 'POST', '/userdata/gs-opt/fresh/increment', { by: 4 })).body).toMatchObject({ value: 4, version: 1 });
    c.close();
  });

  it('TEST-DATA-11: increment type/range errors are INVALID_INPUT; client ops respect read-only keys and public', async () => {
    const c = await live(hub, 'gs-opt');
    await c.emitAck('setUserData', { gameId: 'gs-opt', key: 'str', value: 'x' });
    expect((await c.emitAck('incrementUserData', { gameId: 'gs-opt', key: 'str', by: 1 })).error.code).toBe('INVALID_INPUT');
    await c.emitAck('setUserData', { gameId: 'gs-opt', key: 'big', value: Number.MAX_SAFE_INTEGER });
    expect((await c.emitAck('incrementUserData', { gameId: 'gs-opt', key: 'big', by: 10 })).error.code).toBe('INVALID_INPUT');
    expect((await api(hub, c.user, 'POST', '/userdata/gs-opt/n/increment', { by: 'x' })).status).toBe(400);
    expect((await c.emitAck('incrementUserData', { gameId: 'gs-opt', key: 'n', by: 1, visibility: 'public' })).error.code).toBe('NOT_ALLOWED');
    const gs = await gameServer(hub, 'gs-opt');
    const lobbyId = (await c.emitAck('createLobby', { name: 'ro' })).lobby.id;
    await gs.waitFor('lobby:assigned');
    await gs.emitAck('data:set', { lobbyId, userId: c.user.userId, key: 'srv', value: 1, writeScope: 'server' });
    expect((await c.emitAck('incrementUserData', { gameId: 'gs-opt', key: 'srv', by: 1 })).error.code).toBe('DATA_READ_ONLY');
    expect((await c.emitAck('setUserDataIf', { gameId: 'gs-opt', key: 'srv', value: 2, expectedVersion: 1 })).error.code).toBe('DATA_READ_ONLY');
    closeAll(c, gs);
  });

  it('TEST-DATA-12: setIf compares versions (0 = must not exist); conflict returns 409 VERSION_CONFLICT with current value', async () => {
    const c = await live(hub, 'gs-opt');
    expect((await c.emitAck('setUserDataIf', { gameId: 'gs-opt', key: 'k', value: 'a', expectedVersion: 0 })).version).toBe(1);
    const dup = await c.emitAck('setUserDataIf', { gameId: 'gs-opt', key: 'k', value: 'b', expectedVersion: 0 });
    expect(dup.error).toMatchObject({ code: 'VERSION_CONFLICT', data: { current: { value: 'a', version: 1 } } });
    expect((await c.emitAck('setUserDataIf', { gameId: 'gs-opt', key: 'k', value: 'b', expectedVersion: 1 })).version).toBe(2);
    const r = await api(hub, c.user, 'POST', '/userdata/gs-opt/k/setIf', { value: 'z', expectedVersion: 1 });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'VERSION_CONFLICT', data: { current: { value: 'b', version: 2 } } });
    const missing = await api(hub, c.user, 'POST', '/userdata/gs-opt/none/setIf', { value: 1, expectedVersion: 3 });
    expect(missing.body.data.current).toBeNull();
    const ok = await api(hub, c.user, 'POST', '/userdata/gs-opt/k/setIf', { value: 'z', expectedVersion: 2 });
    expect(ok.body).toMatchObject({ value: 'z', version: 3 });
    c.close();
  });

  it('TEST-DATA-13: transact is atomic: any failing op rolls everything back; results are per-op', async () => {
    const c = await live(hub, 'gs-opt');
    await c.emitAck('setUserData', { gameId: 'gs-opt', key: 'a', value: 1 });
    const bad = await c.emitAck('transactUserData', { gameId: 'gs-opt', ops: [
      { op: 'increment', key: 'a', by: 5 }, { op: 'set', key: 'b', value: 1 }, { op: 'setIf', key: 'a', value: 0, expectedVersion: 99 },
    ] });
    expect(bad.error.code).toBe('VERSION_CONFLICT');
    expect((await api(hub, c.user, 'GET', '/userdata/gs-opt/a')).body).toMatchObject({ value: 1, version: 1 });
    expect((await api(hub, c.user, 'GET', '/userdata/gs-opt/b')).status).toBe(404);
    const ok = await api(hub, c.user, 'POST', '/userdata/gs-opt/transact', { ops: [
      { op: 'increment', key: 'a', by: 5 }, { op: 'set', key: 'b', value: 'x' }, { op: 'delete', key: 'a' },
    ] });
    expect(ok.body.results).toEqual([{ key: 'a', value: 6, version: 2 }, { key: 'b', value: 'x', version: 1 }, { key: 'a', version: 0 }]);
    expect((await api(hub, c.user, 'POST', '/userdata/gs-opt/transact', { ops: [] })).status).toBe(400);
    c.close();
  });

  it('TEST-GSDATA-05: game server increment/setIf/transact for members; conflicts carry current; non-members rejected; server may write server-scoped keys', async () => {
    const { gs, clients: [a], lobbyId } = await gsLobby();
    const t = { lobbyId, userId: a.user.userId };
    expect(await gs.emitAck('data:increment', { ...t, key: 'rank.score', by: 10, visibility: 'public' })).toMatchObject({ ok: true, value: 10, version: 1 });
    expect((await gs.emitAck('data:increment', { ...t, key: 'rank.score', by: 5 })).value).toBe(15);
    expect((await gs.emitAck('data:setIf', { ...t, key: 'rank.score', value: 1, expectedVersion: 1 })).error).toMatchObject({ code: 'VERSION_CONFLICT', data: { current: { value: 15, version: 2 } } });
    const tr = await gs.emitAck('data:transact', { ...t, ops: [{ op: 'increment', key: 'rank.score', by: 1 }, { op: 'set', key: 'x', value: 1, writeScope: 'server' }] });
    expect(tr.results.map((r: any) => r.version)).toEqual([3, 1]);
    expect((await api(hub, a.user, 'GET', '/userdata/gs-opt/rank.score')).body).toMatchObject({ value: 16, visibility: 'public', writeScope: 'server' });
    const stranger = await live(hub, 'gs-opt');
    expect((await gs.emitAck('data:increment', { lobbyId, userId: stranger.user.userId, key: 'k', by: 1 })).error.code).toBe('NOT_ALLOWED');
    closeAll(a, stranger, gs);
  });

  it('TEST-GSDATA-06: subprocess IPC increment/setIf/transact answered with USER_DATA_OP_RESPONSE; non-participants rejected', async () => {
    const host = await live(hub, 'fake');
    const lobbyId = (await host.emitAck('createLobby', { name: 'ipc' })).lobby.id;
    const stranger = await live(hub, 'fake');
    const send = async (ipc: any) => {
      host.socket.emit('gameAction', { type: 'dataop', payload: { ipc } });
      return (await host.waitFor('gameEvent', (e: any) => e.type === 'ipc' && e.data.type === 'USER_DATA_OP_RESPONSE' && e.data.payload.requestId === ipc.payload.requestId)).data.payload;
    };
    const uid = host.user.userId;
    const inc = await send({ type: 'INCREMENT_USER_DATA', payload: { requestId: 'r1', userId: uid, gameId: 'fake', key: 'rank.n', by: 3 } });
    expect(inc).toMatchObject({ ok: true, results: [{ key: 'rank.n', value: 3, version: 1 }] });
    const conflict = await send({ type: 'SET_USER_DATA_IF', payload: { requestId: 'r2', userId: uid, gameId: 'fake', key: 'rank.n', value: 9, expectedVersion: 0 } });
    expect(conflict).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT', data: { current: { value: 3, version: 1 } } } });
    const tx = await send({ type: 'TRANSACT_USER_DATA', payload: { requestId: 'r3', userId: uid, gameId: 'fake', ops: [{ op: 'increment', key: 'rank.n', by: 1 }] } });
    expect(tx.results[0].value).toBe(4);
    const no = await send({ type: 'INCREMENT_USER_DATA', payload: { requestId: 'r4', userId: stranger.user.userId, gameId: 'fake', key: 'rank.n', by: 1 } });
    expect(no).toMatchObject({ ok: false, error: { code: 'NOT_ALLOWED' } });
    expect(lobbyId).toBeTruthy();
    closeAll(host, stranger);
  });
});
