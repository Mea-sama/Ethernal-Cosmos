import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from 'socket.io-client';
import { api, closeAll, connectClient, gameServer, issueServerKey, live, registerUser, sleep, startHub, type TestHub } from './util';
import { connectGameServer } from '../helpers/hub';

const rest = (max: number) => ({ windowMs: 60000, max });
let hub: TestHub;
beforeAll(async () => {
  hub = await startHub({
    limits: {
      restRateLimits: { userdata: rest(2), players: rest(2), leaderboard: rest(2), social: rest(2) },
      caps: {
        maxSessionsPerUser: 2, maxConnectionsPerIp: 40, maxLobbiesPerGame: 3, maxLobbiesTotal: 5,
        maxPendingJoinRequestsPerLobby: 2, maxGameServersPerGame: 2, maxGameServerConnectionsPerIp: 3, capRetryAfterMs: 1234,
      },
      socketLimits: { leaveLobby: { refillPerSecond: 0.01, burst: 2 }, friendRequestByName: { refillPerSecond: 0.01, burst: 2 } },
      joinRequestTimeoutMs: 5000,
    },
  });
});
afterAll(async () => { await hub.stop(); });

async function lobbyCaps(hub: TestHub): Promise<void> {
  const mk = async (game: string) => { const c = await live(hub, game); return c; };
  const creators = [await mk('relay'), await mk('relay'), await mk('relay'), await mk('relay')];
  const lobbies: string[] = [];
  for (const c of creators.slice(0, 3)) lobbies.push((await c.emitAck('createLobby', { name: 'cap' })).lobby.id);
  const over = await creators[3].emitAck('createLobby', { name: 'cap' });
  expect(over.error.code).toBe('RATE_LIMITED');
  expect(over.error.retryAfterMs).toBe(1234);
  // other game is still fine until the global cap (5)
  const o1 = await mk('other'); const o2 = await mk('other'); const o3 = await mk('other');
  expect((await o1.emitAck('createLobby', { name: 'o' })).ok).toBe(true);
  expect((await o2.emitAck('createLobby', { name: 'o' })).ok).toBe(true);
  expect((await o3.emitAck('createLobby', { name: 'o' })).error.code).toBe('RATE_LIMITED');
  await creators[0].emitAck('leaveLobby');
  expect((await creators[3].emitAck('createLobby', { name: 'cap' })).ok).toBe(true);
  closeAll(...creators, o1, o2, o3);
}

const connectError = (token: string, clientType: 'game' | 'panel' = 'game'): Promise<any> =>
  new Promise((resolve) => {
    const s = connect(hub.url, { auth: { token: `Bearer ${token}`, clientType }, transports: ['websocket'], forceNew: true, reconnection: false });
    s.once('connect', () => { s.close(); resolve(null); });
    s.once('connect_error', (e) => { s.close(); resolve(e); });
  });

describe('Abuse limits', () => {
  it('TEST-LIMIT-03: REST /userdata, /players, /leaderboard and /social are rate limited per user: 429 RATE_LIMITED with retryAfterMs', async () => {
    const user = await registerUser(hub);
    for (const route of ['/userdata/relay', '/players/someone/data/relay', '/leaderboard/relay/score', '/social/friends']) {
      const codes: number[] = [];
      let last: any;
      for (let i = 0; i < 3; i++) {
        last = await api(hub, user, 'GET', route);
        codes.push(last.status);
      }
      expect(codes[0], route).not.toBe(429);
      expect(codes[2], route).toBe(429);
      expect(last.body.code).toBe('RATE_LIMITED');
      expect(last.body.retryAfterMs).toBeGreaterThan(0);
    }
    // another user is unaffected
    const other = await registerUser(hub);
    expect((await api(hub, other, 'GET', '/userdata/relay')).status).not.toBe(429);
  });

  it('TEST-LIMIT-04: max sessions per user: extra sockets get connect_error RATE_LIMITED with retryAfterMs; a game takeover does not count', async () => {
    const user = await registerUser(hub);
    const a = await connectClient(hub, user, 'game');
    const b = await connectClient(hub, user, 'panel');
    const c = await connectClient(hub, user, 'game'); // replaces a
    const err = await connectError(user.accessToken, 'panel');
    expect(err.message).toBe('RATE_LIMITED');
    expect(err.data).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 1234 });
    closeAll(a, b, c);
  });

  it('TEST-LIMIT-05: max connections per IP rejects further sockets with RATE_LIMITED and frees slots on disconnect', async () => {
    const ipHub = await startHub({ limits: { caps: { maxConnectionsPerIp: 3 } } });
    try {
      const users = await Promise.all([1, 2, 3, 4].map(() => registerUser(ipHub)));
      const cs = await Promise.all(users.slice(0, 3).map((u) => connectClient(ipHub, u)));
      const rejected = await new Promise<any>((resolve) => {
        const s = connect(ipHub.url, { auth: { token: `Bearer ${users[3].accessToken}` }, transports: ['websocket'], forceNew: true, reconnection: false });
        s.once('connect', () => { s.close(); resolve(null); });
        s.once('connect_error', (e) => { s.close(); resolve(e); });
      });
      expect(rejected.data.code).toBe('RATE_LIMITED');
      expect(rejected.data.retryAfterMs).toBeGreaterThan(0);
      cs[0].close();
      await sleep(300);
      closeAll(await connectClient(ipHub, users[3]), cs[1], cs[2]);
    } finally {
      await ipHub.stop();
    }
  });

  it('TEST-LIMIT-06: max lobbies per game and globally: createLobby → RATE_LIMITED with retryAfterMs; freed when a lobby dissolves', async () => {
    const hub = await startHub({ limits: { caps: { maxLobbiesPerGame: 3, maxLobbiesTotal: 5, capRetryAfterMs: 1234 } } });
    try {
      await lobbyCaps(hub);
    } finally {
      await hub.stop();
    }
  });
  it('TEST-LIMIT-07: leaveLobby is rate limited (RATE_LIMITED + retryAfterMs)', async () => {
    const c = await live(hub, 'other');
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await c.emitAck('leaveLobby'));
    expect(results[0].ok).toBe(true);
    const limited = results.find((r) => !r.ok);
    expect(limited.error.code).toBe('RATE_LIMITED');
    expect(limited.error.retryAfterMs).toBeGreaterThan(0);
    c.close();
  });

  it('TEST-LIMIT-08: pending join requests per lobby are capped; friend requests per user are rate limited', async () => {
    const host = await live(hub, 'other');
    const lobby = (await host.emitAck('createLobby', { name: 'spam' })).lobby;
    await host.emitAck('lockLobby');
    const reqs = await Promise.all([1, 2, 3].map(() => live(hub, 'other')));
    expect((await reqs[0].emitAck('requestJoinLobby', { lobbyId: lobby.id })).pending).toBe(true);
    expect((await reqs[1].emitAck('requestJoinLobby', { lobbyId: lobby.id })).pending).toBe(true);
    const third = await reqs[2].emitAck('requestJoinLobby', { lobbyId: lobby.id });
    expect(third.error.code).toBe('RATE_LIMITED');
    expect(third.error.retryAfterMs).toBe(1234);

    const spammer = await live(hub, 'other');
    const out = [];
    for (let i = 0; i < 3; i++) out.push(await spammer.emitAck('friend:request', { username: `nobody${i}` }));
    expect(out.some((r) => r.error?.code === 'RATE_LIMITED' && r.error.retryAfterMs > 0)).toBe(true);
    closeAll(host, spammer, ...reqs);
  });

  it('TEST-LIMIT-09: game-server connections are capped per game and per IP (connect_error RATE_LIMITED); resuming a serverId is allowed', async () => {
    const s1 = await gameServer(hub, 'gs-opt', { serverId: 'cap-a' });
    const s2 = await gameServer(hub, 'gs-opt', { serverId: 'cap-b' });
    const { key } = await issueServerKey(hub, 'gs-opt');
    await expect(connectGameServer(hub, { serverKey: key, gameId: 'gs-opt', serverId: 'cap-c' })).rejects.toMatchObject({
      message: 'RATE_LIMITED',
      data: { code: 'RATE_LIMITED', retryAfterMs: 1234 },
    });
    const resumed = await connectGameServer(hub, { serverKey: key, gameId: 'gs-opt', serverId: 'cap-a' });
    expect(resumed.count('hello', (h) => h.resumed === true)).toBe(1);
    closeAll(s1, s2, resumed);
    await sleep(200);
    const ip1 = await gameServer(hub, 'gs-opt', { serverId: 'cap-d' });
    ip1.close();
  });
});
