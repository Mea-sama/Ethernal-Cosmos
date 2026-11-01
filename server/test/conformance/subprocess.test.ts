import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAll, live, sleep, startHub, type TestClient, type TestHub } from './util';

let hub: TestHub;
let limited: TestHub;
beforeAll(async () => {
  hub = await startHub();
  limited = await startHub({ env: { MAX_INSTANCES: '1' } });
});
afterAll(async () => { await hub.stop(); await limited.stop(); });

const healthy = async (h: TestHub): Promise<boolean> => (await fetch(`${h.url}/health`)).status === 200;
const api = (h: TestHub, u: TestClient, path: string) =>
  fetch(`${h.url}/api${path}`, { headers: { Authorization: `Bearer ${u.user.accessToken}` } });
const eventOf = (c: TestClient, type: string, timeout = 8000) => c.waitFor('gameEvent', (e) => e.type === type, timeout);

async function evilLobby(h: TestHub = hub) {
  const u = await live(h, 'evil');
  await u.emitAck('createLobby', { name: 'evil' });
  await u.waitFor('gameStarting');
  return u;
}

describe('Game subprocess lifecycle', () => {
  it('TEST-PROC-01: subprocess games get a process; READY → gameStarting; gameAction is forwarded as PLAYER_ACTION', async () => {
    const u = await live(hub, 'fake');
    await u.emitAck('createLobby', { name: 'p' });
    await u.waitFor('gameStarting');
    u.socket.emit('gameAction', { type: 'ping', payload: { n: 1 } });
    const ev = await u.waitFor('gameEvent', (e) => e.type === 'ipc' && e.data.type === 'PLAYER_ACTION');
    expect(ev.data.payload).toMatchObject({ userId: u.user.userId, action: 'ping', data: { n: 1 } });
    u.close();
  });

  it('TEST-PROC-02: subprocess crash → gameCrashed with exit code', async () => {
    const u = await evilLobby();
    u.socket.emit('gameAction', { type: 'exit', payload: { code: 3 } });
    expect(await u.waitFor('gameCrashed')).toMatchObject({ code: 3 });
    u.close();
  });

  it('TEST-PROC-03: MAX_INSTANCES is enforced (INSTANCE_LIMIT) and a freed slot is reusable once the lobby dissolves', async () => {
    const a = await live(limited, 'fake');
    const b = await live(limited, 'fake');
    expect((await a.emitAck('createLobby', { name: '1' })).ok).toBe(true);
    expect((await b.emitAck('createLobby', { name: '2' })).error.code).toBe('INSTANCE_LIMIT');
    await a.emitAck('leaveLobby');
    let res: any;
    for (let i = 0; i < 30; i++) {
      res = await b.emitAck('createLobby', { name: '3' });
      if (res.ok) break;
      await sleep(100);
    }
    expect(res.ok).toBe(true);
    closeAll(a, b);
  });

  it('TEST-PROC-04: lobby settings reach the subprocess as env (LOBBY_SETTINGS) and are size-limited', async () => {
    const u = await live(hub, 'evil');
    await u.emitAck('createLobby', { name: 's', settings: { map: 'x' } });
    u.socket.emit('gameAction', { type: 'env', payload: {} });
    expect(JSON.parse((await eventOf(u, 'env')).settings)).toMatchObject({ map: 'x' });
    await u.emitAck('leaveLobby');
    const big = await u.emitAck('createLobby', { name: 'big', settings: { blob: 'x'.repeat(9000) } });
    expect(big.error.code).toBe('SETTINGS_TOO_LARGE');
    u.close();
  });
});

describe('Malicious subprocess', () => {
  it('TEST-SEC-01: hub secrets (JWT_SECRET, ADMIN_TOKEN) are not in the subprocess environment', async () => {
    const u = await evilLobby();
    u.socket.emit('gameAction', { type: 'env', payload: {} });
    const env = await eventOf(u, 'env');
    expect(env.jwt).toBeNull();
    expect(env.admin).toBeNull();
    expect(env.keys.filter((k: string) => /SECRET|TOKEN|PASSWORD|KEY/i.test(k))).toEqual([]);
    expect(env.keys).toEqual(expect.arrayContaining(['GAME_ID', 'LOBBY_ID']));
    u.close();
  });

  it('TEST-SEC-02: flooding stdout/stderr does not break the hub or the lobby', async () => {
    const u = await evilLobby();
    u.socket.emit('gameAction', { type: 'flood', payload: {} });
    await eventOf(u, 'flooded', 15000);
    expect(await healthy(hub)).toBe(true);
    const other = await live(hub, 'relay');
    expect((await other.emitAck('createLobby', { name: 'after' })).ok).toBe(true);
    expect((await u.emitAck('session:getState')).ok).toBe(true);
    closeAll(u, other);
  });

  it('TEST-SEC-03: flooding the IPC channel stays bounded; the hub stays responsive', async () => {
    const u = await evilLobby();
    u.socket.emit('gameAction', { type: 'ipcflood', payload: {} });
    await eventOf(u, 'spam-done', 15000);
    expect(await healthy(hub)).toBe(true);
    u.close();
  });

  it('TEST-SEC-04: invalid / foreign / oversized SAVE_META is rejected and never crashes the hub', async () => {
    const u = await evilLobby();
    u.socket.emit('gameAction', { type: 'badmeta', payload: {} });
    await eventOf(u, 'badmeta-done');
    await sleep(500);
    expect(await healthy(hub)).toBe(true);
    for (const key of ['steal', 'cross', 'big']) expect((await api(hub, u, `/userdata/evil/${key}`)).status).toBe(404);
    expect((await api(hub, u, '/userdata/fake/cross')).status).toBe(404);
    expect((await u.emitAck('session:getState')).ok).toBe(true);
    u.close();
  });

  it('TEST-SEC-05: malformed IPC messages (unknown type, missing payload) never crash the hub', async () => {
    const u = await evilLobby();
    u.socket.emit('gameAction', { type: 'badmsg', payload: {} });
    await eventOf(u, 'badmsg-done');
    await sleep(300);
    expect(await healthy(hub)).toBe(true);
    u.close();
  });
});
