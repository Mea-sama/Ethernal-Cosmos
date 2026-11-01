import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeAll, connectGameServer, gameServer, issueServerKey, live, serverId, sleep, startHub, updatedWith, type TestHub,
} from './util';

let hub: TestHub;
beforeAll(async () => { hub = await startHub(); });
afterAll(async () => { await hub.stop(); });

const rejects = (p: Promise<unknown>): Promise<string> => p.then(() => 'connected', (e: Error) => e.message);
const ADMIN = { Authorization: 'Bearer admin-test' };

describe('Game-server registry & credentials', () => {
  it('TEST-GS-01: registerGame reports serverSupport and regions; default is none', async () => {
    const a = await live(hub, 'gs-req');
    expect((await a.emitAck('session:registerGame', { gameId: 'gs-req' })).game).toMatchObject({ serverSupport: 'required', regions: ['eu', 'us'] });
    const b = await live(hub, 'relay');
    expect((await b.emitAck('session:registerGame', { gameId: 'relay' })).game.serverSupport).toBe('none');
    closeAll(a, b);
  });

  it('TEST-GS-02: valid key connects; invalid, foreign-game and revoked keys get INVALID_SERVER_KEY', async () => {
    const { id, key } = await issueServerKey(hub, 'gs-opt');
    (await connectGameServer(hub, { serverKey: key, gameId: 'gs-opt', serverId: serverId('k') })).close();
    expect(await rejects(connectGameServer(hub, { serverKey: 'esk_' + 'x'.repeat(48), gameId: 'gs-opt', serverId: serverId('k') }))).toBe('INVALID_SERVER_KEY');
    expect(await rejects(connectGameServer(hub, { serverKey: key, gameId: 'gs-req', serverId: serverId('k') }))).toBe('INVALID_SERVER_KEY');
    const rotated = await issueServerKey(hub, 'gs-opt');
    expect((await fetch(`${hub.url}/admin/game-servers/keys/${id}`, { method: 'DELETE', headers: ADMIN })).status).toBe(204);
    expect(await rejects(connectGameServer(hub, { serverKey: key, gameId: 'gs-opt', serverId: serverId('k') }))).toBe('INVALID_SERVER_KEY');
    (await connectGameServer(hub, { serverKey: rotated.key, gameId: 'gs-opt', serverId: serverId('k') })).close();
  });

  it('TEST-GS-03: game with serverSupport none → GAME_SERVER_NOT_ALLOWED; unknown game → UNKNOWN_GAME', async () => {
    const auth = { serverKey: 'esk_' + 'y'.repeat(48), serverId: serverId('k') };
    expect(await rejects(connectGameServer(hub, { ...auth, gameId: 'relay' }))).toBe('GAME_SERVER_NOT_ALLOWED');
    expect(await rejects(connectGameServer(hub, { ...auth, gameId: 'nope' }))).toBe('UNKNOWN_GAME');
  });

  it('TEST-GS-04: admin API rejects missing/wrong token (401), refuses games without server support (403), never lists plaintext keys', async () => {
    expect((await fetch(`${hub.url}/admin/game-servers/gs-opt/keys`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${hub.url}/admin/game-servers/relay/keys`, { method: 'POST', headers: ADMIN })).status).toBe(403);
    const list = await (await fetch(`${hub.url}/admin/game-servers/gs-opt/keys`, { headers: ADMIN })).json();
    expect(JSON.stringify(list)).not.toContain('esk_');
  });
});

describe('Lobby ↔ server binding', () => {
  it('TEST-GS-05: required game without a server → NO_GAME_SERVER_AVAILABLE and no ghost lobby', async () => {
    const u = await live(hub, 'gs-req');
    expect((await u.emitAck('createLobby', { name: 'x' })).error.code).toBe('NO_GAME_SERVER_AVAILABLE');
    expect((await u.emitAck('session:getState')).lobby).toBeUndefined();
    expect((await u.emitAck('createLobby', { name: 'y' })).error.code).toBe('NO_GAME_SERVER_AVAILABLE');
    u.close();
  });

  it('TEST-GS-06: required with server: lobby bound (lobby:assigned reason=new_lobby), listing exposes only serverBound/region', async () => {
    const s = await gameServer(hub, 'gs-req', { region: 'eu' });
    const u = await live(hub, 'gs-req');
    const created = await u.emitAck('createLobby', { name: 'bound' });
    expect(created.lobby.server).toMatchObject({ region: 'eu' });
    const assigned = await s.waitFor('lobby:assigned');
    expect(assigned).toMatchObject({ reason: 'new_lobby' });
    expect(assigned.lobby.id).toBe(created.lobby.id);
    expect(assigned.previousServerId).toBeUndefined();
    const other = await live(hub, 'gs-req');
    const listing = (await other.emitAck('listLobbies')).lobbies.find((l: any) => l.id === created.lobby.id);
    expect(listing).toMatchObject({ serverBound: true, region: 'eu' });
    expect(listing.server).toBeUndefined();
    closeAll(u, other, s);
  });

  it('TEST-GS-07: optional: serverless without server, bound with one, serverPreference mode none bypasses it', async () => {
    const u = await live(hub, 'gs-opt');
    expect((await u.emitAck('createLobby', { name: 'solo' })).lobby.server).toBeUndefined();
    await u.emitAck('leaveLobby');
    const s = await gameServer(hub, 'gs-opt');
    expect((await u.emitAck('createLobby', { name: 'srv' })).lobby.server?.serverId).toBeTruthy();
    await u.emitAck('leaveLobby');
    expect((await u.emitAck('createLobby', { name: 'free', serverPreference: { mode: 'none' } })).lobby.server).toBeUndefined();
    closeAll(u, s);
  });

  it('TEST-GS-08: server rejects or times out: optional → serverless, required → LOBBY_START_FAILED', async () => {
    const s = await gameServer(hub, 'gs-opt');
    s.assignBehaviour = false;
    const u = await live(hub, 'gs-opt');
    expect((await u.emitAck('createLobby', { name: 'rej' })).lobby.server).toBeUndefined();
    await u.emitAck('leaveLobby');
    s.assignBehaviour = 'ignore';
    expect((await u.emitAck('createLobby', { name: 'timeout' })).lobby.server).toBeUndefined();
    closeAll(u, s);
    const r = await gameServer(hub, 'gs-req');
    r.assignBehaviour = false;
    const u2 = await live(hub, 'gs-req');
    expect((await u2.emitAck('createLobby', { name: 'rej' })).error.code).toBe('LOBBY_START_FAILED');
    expect((await u2.emitAck('session:getState')).lobby).toBeUndefined();
    closeAll(u2, r);
  });

  it('TEST-GS-09: capacity, region preference with fallback, and draining decide placement', async () => {
    const eu = await gameServer(hub, 'gs-req', { region: 'eu', capacity: 1 });
    const us = await gameServer(hub, 'gs-req', { region: 'us', capacity: 1 });
    const [a, b, c] = [await live(hub, 'gs-req'), await live(hub, 'gs-req'), await live(hub, 'gs-req')];
    expect((await a.emitAck('createLobby', { name: '1', serverPreference: { region: 'us' } })).lobby.server.region).toBe('us');
    expect((await b.emitAck('createLobby', { name: '2', serverPreference: { region: 'us' } })).lobby.server.region).toBe('eu');
    expect((await c.emitAck('createLobby', { name: '3' })).error.code).toBe('NO_GAME_SERVER_AVAILABLE');
    await a.emitAck('leaveLobby');
    await sleep(100);
    await us.emitAck('server:status', { draining: true });
    expect((await c.emitAck('createLobby', { name: '4' })).error.code).toBe('NO_GAME_SERVER_AVAILABLE');
    await us.emitAck('server:status', { draining: false });
    expect((await c.emitAck('createLobby', { name: '5' })).lobby.server.region).toBe('us');
    closeAll(a, b, c, eu, us);
  });
});

describe('Server ↔ lobby protocol', () => {
  it('TEST-GS-10: hub→server events and server→hub commands (relay, state, setState, setSettings, kick, gameOver)', async () => {
    const s = await gameServer(hub, 'gs-req');
    const [host, guest] = [await live(hub, 'gs-req'), await live(hub, 'gs-req')];
    const { lobby } = await host.emitAck('createLobby', { name: 'proto' });
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });
    expect(await s.waitFor('player:joined', (d) => d.userId === guest.user.userId)).toMatchObject({ lobbyId: lobby.id });
    await s.waitFor('lobby:updated', (d) => d.reason === 'player_joined');
    await guest.emitAck('gameAction', { type: 'move', payload: { x: 1 } });
    expect(await s.waitFor('player:action')).toMatchObject({ lobbyId: lobby.id, userId: guest.user.userId, type: 'move', payload: { x: 1 } });
    expect((await s.emitAck('lobby:relay', { lobbyId: lobby.id, type: 'tick', payload: 1 })).ok).toBe(true);
    expect(await guest.waitFor('message')).toMatchObject({ from: 'server', type: 'tick' });
    expect((await s.emitAck('lobby:relay', { lobbyId: lobby.id, toUserId: host.user.userId, type: 'whisper' })).ok).toBe(true);
    await host.waitFor('message', (m) => m.type === 'whisper');
    expect(guest.count('message', (m) => m.type === 'whisper')).toBe(0);
    expect((await s.emitAck('lobby:state', { lobbyId: lobby.id, state: { phase: 1 } })).ok).toBe(true);
    expect(await guest.waitFor('gameState')).toEqual({ phase: 1 });
    expect((await s.emitAck('lobby:setState', { lobbyId: lobby.id, state: 'in_progress' })).lobby.status).toBe('in_progress');
    expect((await s.emitAck('lobby:setSettings', { lobbyId: lobby.id, settings: { map: 'a' } })).lobby.settings).toEqual({ map: 'a' });
    expect((await s.emitAck('lobby:kick', { lobbyId: lobby.id, userId: guest.user.userId })).ok).toBe(true);
    await guest.waitFor('playerKicked');
    await s.waitFor('player:left', (d) => d.userId === guest.user.userId && d.reason === 'kicked');
    expect((await s.emitAck('lobby:gameOver', { lobbyId: lobby.id, result: { winner: 'x' } })).ok).toBe(true);
    expect(await host.waitFor('gameOver')).toEqual({ winner: 'x' });
    await s.waitFor('lobby:closed', (d) => d.lobbyId === lobby.id);
    expect((await s.emitAck('lobby:setState', { lobbyId: lobby.id, state: 'in_progress' })).error.code).toBe('INVALID_STATE');
    closeAll(host, guest, s);
  });

  it('TEST-GS-11: a server cannot act on lobbies of another server (NOT_LOBBY_SERVER for every command)', async () => {
    const s1 = await gameServer(hub, 'gs-req');
    const u1 = await live(hub, 'gs-req');
    const { lobby } = await u1.emitAck('createLobby', { name: 'mine' });
    const s2 = await gameServer(hub, 'gs-req');
    for (const [ev, data] of [
      ['lobby:relay', { lobbyId: lobby.id, type: 't' }], ['lobby:state', { lobbyId: lobby.id, state: 1 }],
      ['lobby:kick', { lobbyId: lobby.id, userId: u1.user.userId }], ['lobby:setState', { lobbyId: lobby.id, state: 'closed' }],
      ['lobby:setSettings', { lobbyId: lobby.id, settings: {} }], ['lobby:gameOver', { lobbyId: lobby.id }], ['lobby:close', { lobbyId: lobby.id }],
    ] as const) {
      expect((await s2.emitAck(ev, data)).error.code, ev).toBe('NOT_LOBBY_SERVER');
    }
    expect((await s2.emitAck('lobby:close', { lobbyId: 'does-not-exist' })).error.code).toBe('NOT_LOBBY_SERVER');
    expect((await u1.emitAck('session:getState')).lobby.status).not.toBe('closed');
    closeAll(u1, s1, s2);
  });

  it('TEST-GS-12: the server is never a lobby participant', async () => {
    const s = await gameServer(hub, 'gs-opt');
    const u = await live(hub, 'gs-opt');
    const { lobby } = await u.emitAck('createLobby', { name: 'p' });
    expect(lobby.players.map((p: any) => p.userId)).toEqual([u.user.userId]);
    closeAll(u, s);
  });
});

describe('Server sessions, loss and rebind', () => {
  it('TEST-GS-13: reconnect with the same serverId within grace resumes (resumed:true + lobbies)', async () => {
    const { key } = await issueServerKey(hub, 'gs-req');
    const id = serverId('resume');
    const s = await connectGameServer(hub, { serverKey: key, gameId: 'gs-req', serverId: id });
    const u = await live(hub, 'gs-req');
    const { lobby } = await u.emitAck('createLobby', { name: 'r' });
    s.close();
    await sleep(300);
    const s2 = await connectGameServer(hub, { serverKey: key, gameId: 'gs-req', serverId: id });
    const hello = await s2.waitFor('hello');
    expect(hello.resumed).toBe(true);
    expect(hello.lobbies.map((l: any) => l.id)).toContain(lobby.id);
    expect((await s2.emitAck('lobby:relay', { lobbyId: lobby.id, type: 'ok' })).ok).toBe(true);
    closeAll(u, s2);
  });

  it('TEST-GS-14: required lobby of a lost server is closed with gameCrashed after grace; gameAction → SERVER_UNAVAILABLE meanwhile', async () => {
    const s = await gameServer(hub, 'gs-req');
    const u = await live(hub, 'gs-req');
    const { lobby } = await u.emitAck('createLobby', { name: 'lost' });
    s.close();
    await sleep(200);
    expect((await u.emitAck('gameAction', { type: 'a', payload: 1 })).error.code).toBe('SERVER_UNAVAILABLE');
    expect(await u.waitFor('gameCrashed', (d) => d.lobbyId === lobby.id, 4000)).toMatchObject({ code: null });
    expect((await u.emitAck('session:getState')).lobby.status).toBe('closed');
    u.close();
  });

  it('TEST-GS-15: same serverId with a new connection replaces the old one (takeover)', async () => {
    const { key } = await issueServerKey(hub, 'gs-opt');
    const id = serverId('take');
    const a = await connectGameServer(hub, { serverKey: key, gameId: 'gs-opt', serverId: id });
    const b = await connectGameServer(hub, { serverKey: key, gameId: 'gs-opt', serverId: id });
    await new Promise<void>((r) => (a.socket.connected ? a.socket.once('disconnect', () => r()) : r()));
    expect(a.socket.connected).toBe(false);
    expect(b.socket.connected).toBe(true);
    b.close();
  });

  it('TEST-GS-16: server loss → lobbyUpdated server_lost (serverStatus lost); resume → server_resumed (serverStatus ok)', async () => {
    const { key } = await issueServerKey(hub, 'gs-req');
    const id = serverId('lost');
    const s = await connectGameServer(hub, { serverKey: key, gameId: 'gs-req', serverId: id });
    const u = await live(hub, 'gs-req');
    const { lobby } = await u.emitAck('createLobby', { name: 'l' });
    s.close();
    expect((await updatedWith(u, 'server_lost')).serverStatus).toBe('lost');
    const s2 = await connectGameServer(hub, { serverKey: key, gameId: 'gs-req', serverId: id });
    const back = await updatedWith(u, 'server_resumed');
    expect(back).toMatchObject({ serverStatus: 'ok', id: lobby.id });
    closeAll(u, s2);
  });

  it('TEST-GS-17: after grace the lobby is rebound to another server: lobby:assigned reason=server_rebound (+previousServerId, lostAt), members get server_rebound', async () => {
    const a = await gameServer(hub, 'gs-req');
    const u = await live(hub, 'gs-req');
    const { lobby } = await u.emitAck('createLobby', { name: 'rb' });
    const b = await gameServer(hub, 'gs-req');
    a.close();
    const re = await b.waitFor('lobby:assigned', (d) => d.lobby.id === lobby.id, 5000);
    expect(re).toMatchObject({ reason: 'server_rebound', previousServerId: expect.any(String), lostAt: expect.any(Number) });
    expect(re.lobby.status).not.toBe('closed');
    await updatedWith(u, 'server_rebound');
    expect(u.count('gameCrashed')).toBe(0);
    expect((await u.emitAck('session:getState')).lobby.status).not.toBe('closed');
    closeAll(u, b);
  });

  it('TEST-GS-18: optional lobby without a replacement server continues serverless (server cleared, reason server_lost)', async () => {
    const a = await gameServer(hub, 'gs-opt');
    const u = await live(hub, 'gs-opt');
    expect((await u.emitAck('createLobby', { name: 'cont' })).lobby.server).toBeTruthy();
    a.close();
    expect((await updatedWith(u, 'server_lost', (l) => !l.server)).status).not.toBe('closed');
    u.close();
  });

  it('TEST-GS-19: draining marks lobbies (server_draining), refuses new lobbies, and can return to ok', async () => {
    const s = await gameServer(hub, 'gs-req', { capacity: 5 });
    const u = await live(hub, 'gs-req');
    await u.emitAck('createLobby', { name: 'd' });
    await s.emitAck('server:status', { draining: true });
    expect((await updatedWith(u, 'server_draining')).serverStatus).toBe('draining');
    const u2 = await live(hub, 'gs-req');
    expect((await u2.emitAck('createLobby', { name: 'n' })).error.code).toBe('NO_GAME_SERVER_AVAILABLE');
    await s.emitAck('server:status', { draining: false });
    await updatedWith(u, 'server_draining', (l) => l.serverStatus === 'ok');
    closeAll(u, u2, s);
  });
});
