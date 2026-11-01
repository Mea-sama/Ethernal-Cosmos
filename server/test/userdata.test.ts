import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, connectRegistered, registerUser, startHub, type TestHub } from './helpers/hub';

let hub: TestHub;
beforeAll(async () => { hub = await startHub(); });
afterAll(async () => { await hub.stop(); });

describe('User-Daten Integrität (#19)', () => {
  it('PUT ohne visibility behält die bestehende Sichtbarkeit', async () => {
    const u = await registerUser(hub);
    await api(hub, u, 'PUT', '/userdata/relay/score', { value: 1, visibility: 'lobby' });
    await api(hub, u, 'PUT', '/userdata/relay/score', { value: 2 });
    const { body } = await api(hub, u, 'GET', '/userdata/relay/score');
    expect(body).toMatchObject({ value: 2, visibility: 'lobby', version: 2, writeScope: 'client' });
  });

  it('unbekannte gameId wird abgelehnt', async () => {
    const u = await registerUser(hub);
    const res = await api(hub, u, 'PUT', '/userdata/does-not-exist/k', { value: 1 });
    expect(res).toMatchObject({ status: 400, body: { code: 'UNKNOWN_GAME' } });
    expect((await api(hub, u, 'GET', '/userdata/does-not-exist')).body.code).toBe('UNKNOWN_GAME');
  });

  it('Client kann serverKeys nicht schreiben/löschen; Subprocess schreibt sie via SAVE_META', async () => {
    const host = await connectRegistered(hub, await registerUser(hub), 'fake');
    await host.emitAck('createLobby', { name: 'd' });
    const u = host.user;
    expect((await api(hub, u, 'PUT', '/userdata/fake/rank.points', { value: 999999 })).body.code).toBe('DATA_READ_ONLY');
    expect((await api(hub, u, 'PATCH', '/userdata/fake', [{ key: 'ok', value: 1 }, { key: 'rank.points', value: 1 }])).status).toBe(403);
    // Transaktion: auch 'ok' darf nicht geschrieben worden sein
    expect((await api(hub, u, 'GET', '/userdata/fake/ok')).status).toBe(404);

    host.socket.emit('gameAction', { type: 'save', payload: { gameId: 'fake', value: 42 } });
    for (let i = 0; i < 50; i++) {
      const r = await api(hub, u, 'GET', '/userdata/fake/rank.points');
      if (r.status === 200) {
        expect(r.body).toMatchObject({ value: 42, writeScope: 'server', visibility: 'private' });
        expect((await api(hub, u, 'DELETE', '/userdata/fake/rank.points')).body.code).toBe('DATA_READ_ONLY');
        host.close();
        return;
      }
      await new Promise((r2) => setTimeout(r2, 100));
    }
    throw new Error('SAVE_META wurde nicht geschrieben');
  });

  it('SAVE_META für fremdes Spiel wird verworfen', async () => {
    const host = await connectRegistered(hub, await registerUser(hub), 'fake');
    await host.emitAck('createLobby', { name: 'd' });
    host.socket.emit('gameAction', { type: 'save', payload: { gameId: 'relay', value: 1 } });
    await new Promise((r) => setTimeout(r, 800));
    expect((await api(hub, host.user, 'GET', '/userdata/relay/rank.points')).status).toBe(404);
    host.close();
  });

  it('Größen- und Mengenlimits', async () => {
    const u = await registerUser(hub);
    const big = await api(hub, u, 'PUT', '/userdata/relay/big', { value: 'x'.repeat(20000) });
    expect(big).toMatchObject({ status: 413, body: { code: 'DATA_VALUE_TOO_LARGE' } });
    for (let i = 0; i < 200; i += 100) {
      const entries = Array.from({ length: 100 }, (_, j) => ({ key: `k${i + j}`, value: 1 }));
      expect((await api(hub, u, 'PATCH', '/userdata/relay', entries)).status).toBe(200);
    }
    const over = await api(hub, u, 'PUT', '/userdata/relay/k-extra', { value: 1 });
    expect(over).toMatchObject({ status: 413, body: { code: 'DATA_QUOTA_EXCEEDED' } });
    // Überschreiben bestehender Keys bleibt möglich
    expect((await api(hub, u, 'PUT', '/userdata/relay/k0', { value: 2 })).status).toBe(200);
  });

  it('Socket-Parität: setUserData / bulkSetUserData / deleteUserData / getUserData', async () => {
    const c = await connectRegistered(hub, await registerUser(hub), 'relay');
    expect((await c.emitAck('setUserData', { gameId: 'relay', key: 'a', value: { x: 1 }, visibility: 'lobby' })).ok).toBe(true);
    expect((await c.emitAck('bulkSetUserData', { gameId: 'relay', entries: [{ key: 'b', value: 2 }, { key: 'c', value: 3 }] })).ok).toBe(true);
    const all = await c.emitAck('getUserData', 'relay');
    expect(all.entries.map((e: any) => e.key)).toEqual(['a', 'b', 'c']);
    expect(all.entries[0]).toMatchObject({ visibility: 'lobby', version: 1 });
    expect((await c.emitAck('deleteUserData', { gameId: 'relay', key: 'b' })).ok).toBe(true);
    expect((await c.emitAck('getUserData', 'relay')).entries).toHaveLength(2);
    expect((await c.emitAck('setUserData', { gameId: 'nope', key: 'a', value: 1 })).error.code).toBe('UNKNOWN_GAME');
    expect((await c.emitAck('setUserData', { gameId: 'relay', key: 'bad key!', value: 1 })).error.code).toBe('INVALID_INPUT');
    c.close();
  });

  it('Sichtbarkeit: lobby-Daten nur für Mitspieler, private nie', async () => {
    const a = await connectRegistered(hub, await registerUser(hub), 'relay');
    const b = await connectRegistered(hub, await registerUser(hub), 'relay');
    const stranger = await connectRegistered(hub, await registerUser(hub), 'relay');
    await a.emitAck('bulkSetUserData', { gameId: 'relay', entries: [
      { key: 'priv', value: 1, visibility: 'private' }, { key: 'lob', value: 2, visibility: 'lobby' } ] });
    const lobby = (await a.emitAck('createLobby', { name: 'v' })).lobby;
    await b.emitAck('joinLobby', { lobbyId: lobby.id });
    const mate = await b.emitAck('getPlayerData', { playerId: a.user.userId, gameId: 'relay' });
    expect(mate.entries.map((e: any) => e.key)).toEqual(['lob']);
    const other = await stranger.emitAck('getPlayerData', { playerId: a.user.userId, gameId: 'relay' });
    expect(other.error.code).toBe('NOT_ALLOWED');
    for (const c of [a, b, stranger]) c.close();
  });
});
