import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  api, closeAll, connectGameServer, gameServer, issueServerKey, live, serverId, sleep, startHub, updatedWith, type GsClient, type TestClient, type TestHub,
} from './util';

let hub: TestHub;
// One hub per test: lobbies of servers closed by an earlier test would otherwise be rebound onto the next test's servers
beforeEach(async () => { hub = await startHub(); });
afterEach(async () => { await hub.stop(); });

const noEvent = (c: TestClient, event: string, pred: (a: any) => boolean = () => true): boolean => c.count(event, pred) === 0;
const lobbyOf = async (c: TestClient, name: string, extra: Record<string, unknown> = {}): Promise<any> => (await c.emitAck('createLobby', { name, ...extra })).lobby;

describe('E2E: serverSupport none / optional / required', () => {
  it('TEST-GSE2E-01: none game is serverless; serverPreference is ignored and no server is ever assigned', async () => {
    const u = await live(hub, 'relay');
    const l = await lobbyOf(u, 'plain', { serverPreference: { region: 'eu' } });
    expect(l.server).toBeUndefined();
    const listing = (await (await live(hub, 'relay')).emitAck('listLobbies')).lobbies.find((x: any) => x.id === l.id);
    expect(listing.serverBound).toBeFalsy();
    u.close();
  });

  it('TEST-GSE2E-02: required game: create with and without serverPreference needs a server; the lobby appears only once bound', async () => {
    const u = await live(hub, 'gs-req');
    expect((await u.emitAck('createLobby', { name: 'a' })).error.code).toBe('NO_GAME_SERVER_AVAILABLE');
    expect((await u.emitAck('createLobby', { name: 'b', serverPreference: { region: 'eu' } })).error.code).toBe('NO_GAME_SERVER_AVAILABLE');
    expect((await u.emitAck('session:getState')).lobby).toBeUndefined();
    const s = await gameServer(hub, 'gs-req', { region: 'us' });
    const l = await lobbyOf(u, 'c');
    expect(l.server).toMatchObject({ region: 'us' });
    expect((await s.waitFor('lobby:assigned', (d) => d.lobby.id === l.id)).reason).toBe('new_lobby');
    closeAll(u, s);
  });

  it('TEST-GSE2E-03: optional game: serverless first, a server joining later binds only new lobbies; the old one stays serverless', async () => {
    const u = await live(hub, 'gs-opt');
    const first = await lobbyOf(u, 'first', { serverPreference: { region: 'eu' } });
    expect(first.server).toBeUndefined();
    const s = await gameServer(hub, 'gs-opt');
    await sleep(100);
    expect((await u.emitAck('session:getState')).lobby.server).toBeUndefined();
    expect(s.count('lobby:assigned')).toBe(0);
    const u2 = await live(hub, 'gs-opt');
    expect((await lobbyOf(u2, 'second')).server?.serverId).toBeTruthy();
    expect(s.count('lobby:assigned')).toBe(1);
    closeAll(u, u2, s);
  });

  it('TEST-GSE2E-04: serverless optional lobby ignores game-server actions (NOT_LOBBY_SERVER / NOT_ALLOWED)', async () => {
    const s = await gameServer(hub, 'gs-opt');
    const u = await live(hub, 'gs-opt');
    const l = await lobbyOf(u, 'free', { serverPreference: { mode: 'none' } });
    expect(l.server).toBeUndefined();
    for (const [ev, data] of [
      ['lobby:kick', { lobbyId: l.id, userId: u.user.userId }],
      ['lobby:setState', { lobbyId: l.id, state: 'in_progress' }],
      ['lobby:state', { lobbyId: l.id, state: 1 }],
      ['lobby:relay', { lobbyId: l.id, type: 't' }],
      ['lobby:close', { lobbyId: l.id }],
    ] as const) expect((await s.emitAck(ev, data)).error.code).toBe('NOT_LOBBY_SERVER');
    expect((await s.emitAck('data:set', { lobbyId: l.id, userId: u.user.userId, key: 'k', value: 1 })).error.code).toBe('NOT_ALLOWED');
    expect((await u.emitAck('session:getState')).lobby.status).not.toBe('closed');
    closeAll(u, s);
  });
});

describe('E2E: multi-region and multi-server', () => {
  it('TEST-GSE2E-05: region preference picks the matching server; unknown/unavailable region falls back to any server', async () => {
    const eu = await gameServer(hub, 'gs-req', { region: 'eu', capacity: 5 });
    const [a, b, c] = [await live(hub, 'gs-req'), await live(hub, 'gs-req'), await live(hub, 'gs-req')];
    expect((await lobbyOf(a, '1', { serverPreference: { region: 'eu' } })).server.region).toBe('eu');
    expect((await lobbyOf(b, '2', { serverPreference: { region: 'us' } })).server.region).toBe('eu');
    const us = await gameServer(hub, 'gs-req', { region: 'us', capacity: 5 });
    const d = await live(hub, 'gs-req');
    expect((await lobbyOf(d, '3', { serverPreference: { region: 'us' } })).server.region).toBe('us');
    expect((await lobbyOf(c, '4', { serverPreference: { region: 'eu' } })).server.region).toBe('eu');
    closeAll(a, b, c, d, eu, us);
  });

  it('TEST-GSE2E-06: two servers of one game share load; neither exceeds its capacity and a full fleet answers NO_GAME_SERVER_AVAILABLE', async () => {
    const s1 = await gameServer(hub, 'gs-req', { capacity: 2 });
    const s2 = await gameServer(hub, 'gs-req', { capacity: 2 });
    const users = await Promise.all(Array.from({ length: 5 }, () => live(hub, 'gs-req')));
    const ids: string[] = [];
    for (const u of users.slice(0, 4)) ids.push((await lobbyOf(u, 'spread')).server.serverId);
    expect(ids.filter((i) => i === s1.events[0].args[0].serverId)).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(s1.count('lobby:assigned')).toBe(2);
    expect(s2.count('lobby:assigned')).toBe(2);
    expect((await users[4].emitAck('createLobby', { name: 'full' })).error.code).toBe('NO_GAME_SERVER_AVAILABLE');
    closeAll(...users, s1, s2);
  });

  it('TEST-GSE2E-07: one server hosts several lobbies; actions and commands stay isolated per lobby', async () => {
    const s = await gameServer(hub, 'gs-req', { capacity: 3 });
    const [a, b, c] = [await live(hub, 'gs-req'), await live(hub, 'gs-req'), await live(hub, 'gs-req')];
    const [la, lb, lc] = [await lobbyOf(a, 'A'), await lobbyOf(b, 'B'), await lobbyOf(c, 'C')];
    expect(new Set([la, lb, lc].map((l) => l.server.serverId)).size).toBe(1);
    expect(s.count('lobby:assigned')).toBe(3);
    await b.emitAck('gameAction', { type: 'ping', payload: 'b' });
    expect(await s.waitFor('player:action', (d) => d.userId === b.user.userId)).toMatchObject({ lobbyId: lb.id, payload: 'b' });
    expect((await s.emitAck('lobby:state', { lobbyId: la.id, state: { only: 'a' } })).ok).toBe(true);
    expect(await a.waitFor('gameState')).toEqual({ only: 'a' });
    await sleep(100);
    expect(noEvent(b, 'gameState') && noEvent(c, 'gameState')).toBe(true);
    expect((await s.emitAck('lobby:close', { lobbyId: lc.id })).ok).toBe(true);
    expect((await s.emitAck('lobby:relay', { lobbyId: la.id, type: 'still-ok' })).ok).toBe(true);
    expect((await c.emitAck('session:getState')).lobby.status).toBe('closed');
    expect((await a.emitAck('session:getState')).lobby.status).not.toBe('closed');
    closeAll(a, b, c, s);
  });
});

async function lostServerFixture(game: string, { withTaker }: { withTaker: boolean }): Promise<{ a: GsClient; b?: GsClient; u: TestClient; g: TestClient; lobby: any }> {
  const a = await gameServer(hub, game);
  const [u, g] = [await live(hub, game), await live(hub, game)];
  const lobby = await lobbyOf(u, 'loss');
  await g.emitAck('joinLobby', { lobbyId: lobby.id });
  await a.emitAck('lobby:setState', { lobbyId: lobby.id, state: 'in_progress' });
  const b = withTaker ? await gameServer(hub, game) : undefined;
  return { a, b, u, g, lobby };
}

describe('E2E: server loss, resume, rebind', () => {
  it('TEST-GSE2E-08: loss then resume inside the grace keeps lobby and status; members see server_lost then server_resumed, never gameCrashed', async () => {
    const { key } = await issueServerKey(hub, 'gs-req');
    const id = serverId('res');
    const s = await connectGameServer(hub, { serverKey: key, gameId: 'gs-req', serverId: id });
    const [u, g] = [await live(hub, 'gs-req'), await live(hub, 'gs-req')];
    const lobby = await lobbyOf(u, 'res');
    await g.emitAck('joinLobby', { lobbyId: lobby.id });
    await s.emitAck('lobby:setState', { lobbyId: lobby.id, state: 'in_progress' });
    s.close();
    for (const m of [u, g]) expect((await updatedWith(m, 'server_lost')).serverStatus).toBe('lost');
    const s2 = await connectGameServer(hub, { serverKey: key, gameId: 'gs-req', serverId: id });
    const hello = await s2.waitFor('hello');
    expect(hello).toMatchObject({ resumed: true });
    expect(hello.lobbies.map((l: any) => l.id)).toContain(lobby.id);
    for (const m of [u, g]) expect(await updatedWith(m, 'server_resumed')).toMatchObject({ id: lobby.id, serverStatus: 'ok', status: 'in_progress' });
    expect((await g.emitAck('gameAction', { type: 'x', payload: 1 })).ok).toBe(true);
    await s2.waitFor('player:action', (d) => d.userId === g.user.userId);
    await sleep(1800);
    expect(noEvent(u, 'gameCrashed')).toBe(true);
    expect((await u.emitAck('session:getState')).lobby.status).toBe('in_progress');
    closeAll(u, g, s2);
  });

  it('TEST-GSE2E-09: loss beyond the grace rebinds to another server (previousServerId/lostAt, status kept); members get server_rebound, not gameCrashed', async () => {
    const { a, b, u, g, lobby } = await lostServerFixture('gs-req', { withTaker: true });
    const lostId = a.events[0].args[0].serverId;
    const t0 = Date.now();
    a.close();
    const re = await b!.waitFor('lobby:assigned', (d) => d.lobby.id === lobby.id, 6000);
    expect(re).toMatchObject({ reason: 'server_rebound', previousServerId: lostId });
    expect(re.lostAt).toBeGreaterThanOrEqual(t0 - 50);
    expect(re.lostAt).toBeLessThanOrEqual(Date.now());
    expect(re.lobby.status).toBe('in_progress');
    expect(re.lobby.players.map((p: any) => p.userId).sort()).toEqual([u.user.userId, g.user.userId].sort());
    for (const m of [u, g]) {
      const upd = await updatedWith(m, 'server_rebound');
      expect(upd.server.serverId).toBe(b!.events[0].args[0].serverId);
      expect(upd.serverStatus).toBe('ok');
    }
    await sleep(300);
    expect(noEvent(u, 'gameCrashed') && noEvent(g, 'gameCrashed')).toBe(true);
    expect((await g.emitAck('gameAction', { type: 'again', payload: 2 })).ok).toBe(true);
    await b!.waitFor('player:action', (d) => d.type === 'again');
    expect((await b!.emitAck('lobby:relay', { lobbyId: lobby.id, type: 'hi' })).ok).toBe(true);
    closeAll(u, g, b!);
  });

  it('TEST-GSE2E-10: a rejecting replacement does not take over; the required lobby closes with gameCrashed (code null)', async () => {
    const { a, b, u, g, lobby } = await lostServerFixture('gs-req', { withTaker: true });
    b!.assignBehaviour = false;
    a.close();
    for (const m of [u, g]) expect(await m.waitFor('gameCrashed', (d) => d.lobbyId === lobby.id, 6000)).toMatchObject({ code: null });
    expect(b!.count('lobby:assigned', (d) => d.reason === 'server_rebound')).toBeGreaterThanOrEqual(1);
    expect((await u.emitAck('session:getState')).lobby.status).toBe('closed');
    closeAll(u, g, b!);
  });

  it('TEST-GSE2E-11: required lobby with no replacement at all closes with gameCrashed after the grace', async () => {
    const { a, u, g, lobby } = await lostServerFixture('gs-req', { withTaker: false });
    a.close();
    await updatedWith(u, 'server_lost');
    for (const m of [u, g]) expect(await m.waitFor('gameCrashed', (d) => d.lobbyId === lobby.id, 6000)).toMatchObject({ code: null });
    expect((await g.emitAck('gameAction', { type: 'x', payload: 1 })).error).toBeTruthy();
    closeAll(u, g);
  });

  it('TEST-GSE2E-12: optional lobby: no replacement → serverless continuation; with a replacement → rebound instead', async () => {
    const { a, u, g } = await lostServerFixture('gs-opt', { withTaker: false });
    a.close();
    expect((await updatedWith(u, 'server_lost', (l) => !l.server)).status).toBe('in_progress');
    await sleep(200);
    expect(noEvent(u, 'gameCrashed') && noEvent(g, 'gameCrashed')).toBe(true);
    expect((await g.emitAck('gameAction', { type: 'free', payload: 1 })).error?.code).not.toBe('SERVER_UNAVAILABLE');

    const f = await lostServerFixture('gs-opt', { withTaker: true });
    f.a.close();
    await f.b!.waitFor('lobby:assigned', (d) => d.lobby.id === f.lobby.id && d.reason === 'server_rebound', 6000);
    expect((await updatedWith(f.u, 'server_rebound')).server).toBeTruthy();
    closeAll(u, g, f.u, f.g, f.b!);
  });
});

describe('E2E: draining', () => {
  it('TEST-GSE2E-13: draining server keeps its lobbies running but gets no new ones; new lobbies go to another server', async () => {
    const s1 = await gameServer(hub, 'gs-req', { capacity: 5 });
    const u = await live(hub, 'gs-req');
    const l1 = await lobbyOf(u, 'old');
    const s2 = await gameServer(hub, 'gs-req', { capacity: 5 });
    await s1.emitAck('server:status', { draining: true });
    expect((await updatedWith(u, 'server_draining')).serverStatus).toBe('draining');
    const u2 = await live(hub, 'gs-req');
    const l2 = await lobbyOf(u2, 'new');
    expect(l2.server.serverId).toBe(s2.events[0].args[0].serverId);
    expect(s1.count('lobby:assigned')).toBe(1);
    expect((await u.emitAck('gameAction', { type: 'go', payload: 1 })).ok).toBe(true);
    await s1.waitFor('player:action', (d) => d.lobbyId === l1.id);
    expect((await s1.emitAck('lobby:setState', { lobbyId: l1.id, state: 'in_progress' })).lobby.status).toBe('in_progress');
    expect(s2.count('lobby:assigned', (d) => d.lobby.id === l1.id)).toBe(0);
    closeAll(u, u2, s1, s2);
  });

  it('TEST-GSE2E-14: a draining server finishing its lobby frees it; one that drops is rebound to a non-draining server', async () => {
    const s1 = await gameServer(hub, 'gs-req', { capacity: 5 });
    const [u, v] = [await live(hub, 'gs-req'), await live(hub, 'gs-req')];
    const done = await lobbyOf(u, 'finish');
    const moving = await lobbyOf(v, 'move');
    const s2 = await gameServer(hub, 'gs-req', { capacity: 5 });
    await s1.emitAck('server:status', { draining: true });
    await updatedWith(v, 'server_draining');
    expect((await s1.emitAck('lobby:gameOver', { lobbyId: done.id, result: { ok: 1 } })).ok).toBe(true);
    expect(await u.waitFor('gameOver')).toEqual({ ok: 1 });
    s1.close();
    const re = await s2.waitFor('lobby:assigned', (d) => d.lobby.id === moving.id, 6000);
    expect(re.reason).toBe('server_rebound');
    expect((await updatedWith(v, 'server_rebound')).serverStatus).toBe('ok');
    expect(s2.count('lobby:assigned', (d) => d.lobby.id === done.id)).toBe(0);
    closeAll(u, v, s2);
  });
});

describe('E2E: unauthorized server actions', () => {
  it('TEST-GSE2E-15: wrong, malformed, foreign-game and missing keys never connect; connection attempts do not disturb a healthy server', async () => {
    const good = await gameServer(hub, 'gs-req');
    const opt = await issueServerKey(hub, 'gs-opt');
    const attempt = (auth: Record<string, unknown>): Promise<string> =>
      connectGameServer(hub, auth as any).then((c) => { c.close(); return 'connected'; }, (e: Error) => e.message);
    expect(await attempt({ serverKey: 'esk_' + 'z'.repeat(48), gameId: 'gs-req', serverId: serverId('x') })).toBe('INVALID_SERVER_KEY');
    expect(await attempt({ serverKey: opt.key, gameId: 'gs-req', serverId: serverId('x') })).toBe('INVALID_SERVER_KEY');
    expect(await attempt({ serverKey: opt.key, gameId: 'relay', serverId: serverId('x') })).toBe('GAME_SERVER_NOT_ALLOWED');
    expect(await attempt({ serverKey: opt.key, gameId: 'gs-opt' })).toBe('INVALID_INPUT');
    expect(await attempt({ gameId: 'gs-opt', serverId: serverId('x') })).toBe('INVALID_INPUT');
    expect(good.socket.connected).toBe(true);
    good.close();
  });

  it('TEST-GSE2E-16: server A cannot act on, write data for, or hijack the serverId of server B and its lobby', async () => {
    const a = await gameServer(hub, 'gs-req');
    const u = await live(hub, 'gs-req');
    const l = await lobbyOf(u, 'b-owned');
    const b = await gameServer(hub, 'gs-req');
    const other = await gameServer(hub, 'gs-opt');
    for (const s of [b, other]) {
      expect((await s.emitAck('lobby:kick', { lobbyId: l.id, userId: u.user.userId })).error.code).toBe('NOT_LOBBY_SERVER');
      expect((await s.emitAck('lobby:setState', { lobbyId: l.id, state: 'in_progress' })).error.code).toBe('NOT_LOBBY_SERVER');
      expect((await s.emitAck('lobby:state', { lobbyId: l.id, state: 1 })).error.code).toBe('NOT_LOBBY_SERVER');
      expect((await s.emitAck('data:set', { lobbyId: l.id, userId: u.user.userId, key: 'k', value: 1 })).error.code).toBe('NOT_ALLOWED');
      expect((await s.emitAck('data:get', { lobbyId: l.id, userId: u.user.userId })).error.code).toBe('NOT_ALLOWED');
      expect((await s.emitAck('data:increment', { lobbyId: l.id, userId: u.user.userId, key: 'k', by: 1 })).error.code).toBe('NOT_ALLOWED');
    }
    expect((await u.emitAck('session:getState')).lobby).toMatchObject({ id: l.id, status: 'open' });
    expect(u.count('playerKicked')).toBe(0);
    expect((await a.emitAck('data:set', { lobbyId: l.id, userId: u.user.userId, key: 'k', value: 1 })).ok).toBe(true);
    closeAll(u, a, b, other);
  });

  it('TEST-GSE2E-17: data writes for non-members, former members of other lobbies and unknown ids fail; the owner writes for members only', async () => {
    const s = await gameServer(hub, 'gs-req', { capacity: 3 });
    const [m, n, stranger] = [await live(hub, 'gs-req'), await live(hub, 'gs-req'), await live(hub, 'gs-req')];
    const lm = await lobbyOf(m, 'M');
    const ln = await lobbyOf(n, 'N');
    const base = { key: 'score', value: 1 };
    expect((await s.emitAck('data:set', { ...base, lobbyId: lm.id, userId: m.user.userId })).ok).toBe(true);
    expect((await s.emitAck('data:set', { ...base, lobbyId: lm.id, userId: n.user.userId })).error.code).toBe('NOT_ALLOWED');
    expect((await s.emitAck('data:set', { ...base, lobbyId: ln.id, userId: m.user.userId })).error.code).toBe('NOT_ALLOWED');
    expect((await s.emitAck('data:set', { ...base, lobbyId: lm.id, userId: stranger.user.userId })).error.code).toBe('NOT_ALLOWED');
    expect((await s.emitAck('data:bulk', { lobbyId: lm.id, userId: m.user.userId, entries: [{ key: 'a', value: 1 }, { key: 'b', value: 2 }] })).ok).toBe(true);
    expect((await s.emitAck('data:bulk', { lobbyId: lm.id, userId: stranger.user.userId, entries: [{ key: 'a', value: 1 }] })).error.code).toBe('NOT_ALLOWED');
    closeAll(m, n, stranger, s);
  });

  it('TEST-GSE2E-18: clients cannot write public/server-scope data in server games; the server-written value survives and stays readable', async () => {
    const s = await gameServer(hub, 'gs-opt');
    const u = await live(hub, 'gs-opt');
    const l = await lobbyOf(u, 'data');
    expect(l.server).toBeTruthy();
    expect((await s.emitAck('data:set', { lobbyId: l.id, userId: u.user.userId, key: 'wins', value: 7, visibility: 'public' })).ok).toBe(true);
    expect((await u.emitAck('setUserData', { gameId: 'gs-opt', key: 'wins', value: 999, visibility: 'public' })).error.code).toBe('NOT_ALLOWED');
    expect((await u.emitAck('setUserData', { gameId: 'gs-opt', key: 'wins', value: 999 })).ok).not.toBe(true);
    expect((await u.emitAck('deleteUserData', { gameId: 'gs-opt', key: 'wins' })).ok).not.toBe(true);
    expect((await u.emitAck('setUserData', { gameId: 'gs-opt', key: 'mine', value: 1, visibility: 'public' })).error.code).toBe('NOT_ALLOWED');
    expect((await api(hub, u.user, 'PUT', '/userdata/gs-opt/wins', { value: 1000 })).status).toBeGreaterThanOrEqual(400);
    const got = await s.emitAck('data:get', { lobbyId: l.id, userId: u.user.userId });
    expect(got.entries.find((e: any) => e.key === 'wins')).toMatchObject({ value: 7, visibility: 'public', writeScope: 'server' });
    closeAll(u, s);
  });

  it('TEST-GSE2E-19: server writes stay authorised inside the 60 s window after leaving, kick, and lobby close', async () => {
    const s = await gameServer(hub, 'gs-req');
    const [a, b, c] = [await live(hub, 'gs-req'), await live(hub, 'gs-req'), await live(hub, 'gs-req')];
    const l = await lobbyOf(a, 'win');
    await b.emitAck('joinLobby', { lobbyId: l.id });
    await c.emitAck('joinLobby', { lobbyId: l.id });
    await a.emitAck('leaveLobby').catch(() => undefined);
    const w = (u: TestClient, key: string) => s.emitAck('data:set', { lobbyId: l.id, userId: u.user.userId, key, value: 1, visibility: 'public' });
    expect((await w(a, 'left')).ok).toBe(true);
    expect((await s.emitAck('lobby:kick', { lobbyId: l.id, userId: c.user.userId })).ok).toBe(true);
    expect((await w(c, 'kicked')).ok).toBe(true);
    expect((await s.emitAck('lobby:close', { lobbyId: l.id })).ok).toBe(true);
    expect((await w(b, 'closed')).ok).toBe(true);
    closeAll(a, b, c, s);
  });
});

describe('E2E: kicks and blocks with server-bound lobbies', () => {
  it('TEST-GSE2E-20: server kick with reason: player gets playerKicked{reason}, server gets player:left kicked, KICKED_FROM_LOBBY on every rejoin path', async () => {
    const s = await gameServer(hub, 'gs-req');
    const [host, victim] = [await live(hub, 'gs-req'), await live(hub, 'gs-req')];
    const l = await lobbyOf(host, 'kick', { isPrivate: true });
    await victim.emitAck('joinLobbyByCode', { code: l.inviteCode });
    expect((await s.emitAck('lobby:kick', { lobbyId: l.id, userId: victim.user.userId, reason: 'cheating' })).ok).toBe(true);
    expect(await victim.waitFor('playerKicked')).toEqual({ lobbyId: l.id, reason: 'cheating' });
    await s.waitFor('player:left', (d) => d.userId === victim.user.userId && d.reason === 'kicked');
    expect((await victim.emitAck('joinLobbyByCode', { code: l.inviteCode })).error.code).toBe('KICKED_FROM_LOBBY');
    expect((await victim.emitAck('requestJoinLobbyByCode', { code: l.inviteCode })).error.code).toBe('KICKED_FROM_LOBBY');
    expect((await victim.emitAck('session:getState')).lobby).toBeUndefined();
    expect((await victim.emitAck('gameAction', { type: 'x', payload: 1 })).ok).not.toBe(true);
    expect((await s.emitAck('lobby:kick', { lobbyId: l.id, userId: victim.user.userId })).error.code).toBe('PLAYER_NOT_FOUND');
    closeAll(host, victim, s);
  });

  it('TEST-GSE2E-21: a kick survives a server rebind: the kicked player still cannot rejoin the rebound lobby, others can', async () => {
    const a = await gameServer(hub, 'gs-req');
    const [host, victim, other] = [await live(hub, 'gs-req'), await live(hub, 'gs-req'), await live(hub, 'gs-req')];
    const l = await lobbyOf(host, 'kickrb');
    await victim.emitAck('joinLobby', { lobbyId: l.id });
    await a.emitAck('lobby:kick', { lobbyId: l.id, userId: victim.user.userId });
    const b = await gameServer(hub, 'gs-req');
    a.close();
    await b.waitFor('lobby:assigned', (d) => d.lobby.id === l.id && d.reason === 'server_rebound', 6000);
    expect((await victim.emitAck('joinLobby', { lobbyId: l.id })).error.code).toBe('KICKED_FROM_LOBBY');
    expect((await other.emitAck('joinLobby', { lobbyId: l.id })).ok).toBe(true);
    await b.waitFor('player:joined', (d) => d.userId === other.user.userId);
    closeAll(host, victim, other, b);
  });

  it('TEST-GSE2E-22: a blocked user still joins a server-bound lobby and the server is told about every member', async () => {
    const s = await gameServer(hub, 'gs-req');
    const [a, b] = [await live(hub, 'gs-req'), await live(hub, 'gs-req')];
    expect((await a.emitAck('block:add', { userId: b.user.userId })).ok).toBe(true);
    const l = await lobbyOf(a, 'blk');
    const join = await b.emitAck('joinLobby', { lobbyId: l.id });
    expect(join.ok).toBe(true);
    expect(await s.waitFor('player:joined', (d) => d.userId === b.user.userId)).toMatchObject({ lobbyId: l.id });
    closeAll(a, b, s);
  });
});
