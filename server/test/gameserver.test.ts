import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectGameServer, connectRegistered, issueServerKey, registerUser, sleep, startHub, type GsClient, type TestHub } from './helpers/hub';

let hub: TestHub;
let n = 0;
const sid = (p: string): string => `${p}-${Date.now().toString(36)}-${n++}`;
beforeAll(async () => { hub = await startHub(); });
afterAll(async () => { await hub.stop(); });

async function server(gameId: string, opts: { region?: string; capacity?: number; serverId?: string } = {}): Promise<GsClient> {
  const { key } = await issueServerKey(hub, gameId);
  return connectGameServer(hub, { serverKey: key, gameId, serverId: opts.serverId ?? sid('srv'), region: opts.region, capacity: opts.capacity });
}

/** lobbyUpdated kommt als (lobby, reason) */
async function updated(c: { events: Array<{ event: string; args: any[] }> }, reason: string, pred: (l: any) => boolean = () => true, timeoutMs = 5000): Promise<{ lobby: any }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const e = c.events.find((x) => x.event === 'lobbyUpdated' && x.args[1] === reason && pred(x.args[0]));
    if (e) return { lobby: e.args[0] };
    if (Date.now() > deadline) throw new Error(`timeout lobbyUpdated/${reason}`);
    await sleep(20);
  }
}

const rejects = (p: Promise<unknown>): Promise<string> => p.then(() => 'connected', (e: Error) => e.message);

describe('Registry serverSupport (#50)', () => {
  it('registerGame liefert serverSupport und regions; Default ist none', async () => {
    const a = await connectRegistered(hub, await registerUser(hub), 'gs-req');
    const res = await a.emitAck('session:registerGame', { gameId: 'gs-req' });
    expect(res.game).toMatchObject({ serverSupport: 'required', regions: ['eu', 'us'] });
    expect((await a.emitAck('session:registerGame', { gameId: 'gs-req' })).ok).toBe(true);
    a.close();
    const b = await connectRegistered(hub, await registerUser(hub), 'relay');
    expect((await b.emitAck('session:getState')).ok).toBe(true);
    const reg = await b.emitAck('session:registerGame', { gameId: 'relay' });
    expect(reg.game.serverSupport).toBe('none');
    b.close();
  });
});

describe('Game-Server-Credentials (#51)', () => {
  it('gültiger Key verbindet; ungültiger/fremder/widerrufener Key nicht', async () => {
    const { id, key } = await issueServerKey(hub, 'gs-opt');
    const ok = await connectGameServer(hub, { serverKey: key, gameId: 'gs-opt', serverId: sid('k') });
    ok.close();
    expect(await rejects(connectGameServer(hub, { serverKey: 'esk_' + 'x'.repeat(48), gameId: 'gs-opt', serverId: sid('k') }))).toBe('INVALID_SERVER_KEY');
    expect(await rejects(connectGameServer(hub, { serverKey: key, gameId: 'gs-req', serverId: sid('k') }))).toBe('INVALID_SERVER_KEY');

    const rotated = await issueServerKey(hub, 'gs-opt');
    const del = await fetch(`${hub.url}/admin/game-servers/keys/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer admin-test' } });
    expect(del.status).toBe(204);
    expect(await rejects(connectGameServer(hub, { serverKey: key, gameId: 'gs-opt', serverId: sid('k') }))).toBe('INVALID_SERVER_KEY');
    (await connectGameServer(hub, { serverKey: rotated.key, gameId: 'gs-opt', serverId: sid('k') })).close();
  });

  it('Spiel mit serverSupport none → GAME_SERVER_NOT_ALLOWED; unbekanntes Spiel → UNKNOWN_GAME', async () => {
    expect(await rejects(connectGameServer(hub, { serverKey: 'esk_' + 'y'.repeat(48), gameId: 'relay', serverId: sid('k') }))).toBe('GAME_SERVER_NOT_ALLOWED');
    expect(await rejects(connectGameServer(hub, { serverKey: 'esk_' + 'y'.repeat(48), gameId: 'nope', serverId: sid('k') }))).toBe('UNKNOWN_GAME');
  });

  it('Admin-API: ohne/mit falschem Token abgewiesen; Keys werden nicht im Klartext gelistet', async () => {
    const bad = await fetch(`${hub.url}/admin/game-servers/gs-opt/keys`, { headers: { Authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
    const none = await fetch(`${hub.url}/admin/game-servers/relay/keys`, { method: 'POST', headers: { Authorization: 'Bearer admin-test' } });
    expect(none.status).toBe(403);
    const list = await (await fetch(`${hub.url}/admin/game-servers/gs-opt/keys`, { headers: { Authorization: 'Bearer admin-test' } })).json();
    expect(JSON.stringify(list)).not.toContain('esk_');
  });
});

describe('Lobby–Server-Bindung (#52, #53)', () => {
  it('required ohne Server → NO_GAME_SERVER_AVAILABLE, keine Ghost-Lobby', async () => {
    const u = await connectRegistered(hub, await registerUser(hub), 'gs-req');
    const res = await u.emitAck('createLobby', { name: 'x' });
    expect(res.error.code).toBe('NO_GAME_SERVER_AVAILABLE');
    expect((await u.emitAck('session:getState')).lobby).toBeUndefined();
    expect((await u.emitAck('createLobby', { name: 'y' })).error.code).toBe('NO_GAME_SERVER_AVAILABLE');
    u.close();
  });

  it('required mit Server: Lobby gebunden, Listing zeigt nur serverBound/region, Mitglieder sehen server', async () => {
    const s = await server('gs-req', { region: 'eu' });
    const u = await connectRegistered(hub, await registerUser(hub), 'gs-req');
    const created = await u.emitAck('createLobby', { name: 'bound' });
    expect(created.lobby.server).toMatchObject({ region: 'eu' });
    const assigned = await s.waitFor('lobby:assigned');
    expect(assigned.lobby.id).toBe(created.lobby.id);
    expect(assigned).toMatchObject({ reason: 'new_lobby' });
    expect(assigned.previousServerId).toBeUndefined();
    const other = await connectRegistered(hub, await registerUser(hub), 'gs-req');
    const listing = (await other.emitAck('listLobbies')).lobbies.find((l: any) => l.id === created.lobby.id);
    expect(listing).toMatchObject({ serverBound: true, region: 'eu' });
    expect(listing.server).toBeUndefined();
    u.close(); other.close(); s.close();
  });

  it('optional: ohne Server serverlos; mit Server gebunden; mode none umgeht den Server', async () => {
    const u0 = await connectRegistered(hub, await registerUser(hub), 'gs-opt');
    const before = await u0.emitAck('createLobby', { name: 'solo' });
    expect(before.lobby.server).toBeUndefined();
    await u0.emitAck('leaveLobby');

    const s = await server('gs-opt');
    const bound = await u0.emitAck('createLobby', { name: 'srv' });
    expect(bound.lobby.server?.serverId).toBeTruthy();
    await u0.emitAck('leaveLobby');
    const free = await u0.emitAck('createLobby', { name: 'free', serverPreference: { mode: 'none' } });
    expect(free.lobby.server).toBeUndefined();
    u0.close(); s.close();
  });

  it('optional: Server lehnt ab oder antwortet nicht → serverlos; required → LOBBY_START_FAILED', async () => {
    const s = await server('gs-opt');
    s.assignBehaviour = false;
    const u = await connectRegistered(hub, await registerUser(hub), 'gs-opt');
    expect((await u.emitAck('createLobby', { name: 'rej' })).lobby.server).toBeUndefined();
    await u.emitAck('leaveLobby');
    s.assignBehaviour = 'ignore';
    expect((await u.emitAck('createLobby', { name: 'timeout' })).lobby.server).toBeUndefined();
    u.close(); s.close();

    const r = await server('gs-req');
    r.assignBehaviour = false;
    const u2 = await connectRegistered(hub, await registerUser(hub), 'gs-req');
    expect((await u2.emitAck('createLobby', { name: 'rej' })).error.code).toBe('LOBBY_START_FAILED');
    expect((await u2.emitAck('session:getState')).lobby).toBeUndefined();
    u2.close(); r.close();
  });

  it('Kapazität, Region-Präferenz, Least-Loaded, Draining', async () => {
    const eu = await server('gs-req', { region: 'eu', capacity: 1 });
    const us = await server('gs-req', { region: 'us', capacity: 1 });
    const mk = async () => connectRegistered(hub, await registerUser(hub), 'gs-req');
    const [a, b, c] = [await mk(), await mk(), await mk()];

    const l1 = await a.emitAck('createLobby', { name: '1', serverPreference: { region: 'us' } });
    expect(l1.lobby.server.region).toBe('us');
    const l2 = await b.emitAck('createLobby', { name: '2', serverPreference: { region: 'us' } });
    expect(l2.lobby.server.region).toBe('eu'); // us voll → Fallback
    expect((await c.emitAck('createLobby', { name: '3' })).error.code).toBe('NO_GAME_SERVER_AVAILABLE');

    await a.emitAck('leaveLobby'); // Lobby aufgelöst → Slot frei
    await sleep(100);
    await us.emitAck('server:status', { draining: true });
    expect((await c.emitAck('createLobby', { name: '4' })).error.code).toBe('NO_GAME_SERVER_AVAILABLE');
    await us.emitAck('server:status', { draining: false });
    expect((await c.emitAck('createLobby', { name: '5' })).lobby.server.region).toBe('us');
    [a, b, c].forEach((x) => x.close()); eu.close(); us.close();
  });
});

describe('Server↔Lobby-Protokoll (#54)', () => {
  it('Hub→Server Events und Server→Hub Kommandos', async () => {
    const s = await server('gs-req');
    const host = await connectRegistered(hub, await registerUser(hub), 'gs-req');
    const guest = await connectRegistered(hub, await registerUser(hub), 'gs-req');
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
    host.close(); guest.close(); s.close();
  });

  it('Server darf nicht auf fremde Lobbys zugreifen', async () => {
    const s1 = await server('gs-req');
    const u1 = await connectRegistered(hub, await registerUser(hub), 'gs-req');
    const { lobby } = await u1.emitAck('createLobby', { name: 'mine' });
    const s2 = await server('gs-req');
    for (const [ev, data] of [
      ['lobby:relay', { lobbyId: lobby.id, type: 't' }],
      ['lobby:state', { lobbyId: lobby.id, state: 1 }],
      ['lobby:kick', { lobbyId: lobby.id, userId: u1.user.userId }],
      ['lobby:setState', { lobbyId: lobby.id, state: 'closed' }],
      ['lobby:setSettings', { lobbyId: lobby.id, settings: {} }],
      ['lobby:gameOver', { lobbyId: lobby.id }],
      ['lobby:close', { lobbyId: lobby.id }],
    ] as const) {
      expect((await s2.emitAck(ev, data)).error.code).toBe('NOT_LOBBY_SERVER');
    }
    expect((await s2.emitAck('lobby:close', { lobbyId: 'does-not-exist' })).error.code).toBe('NOT_LOBBY_SERVER');
    expect((await u1.emitAck('session:getState')).lobby.status).not.toBe('closed');
    u1.close(); s1.close(); s2.close();
  });

  it('Server ist nie Lobby-Teilnehmer', async () => {
    const s = await server('gs-opt');
    const u = await connectRegistered(hub, await registerUser(hub), 'gs-opt');
    const { lobby } = await u.emitAck('createLobby', { name: 'p' });
    expect(lobby.players).toHaveLength(1);
    expect(lobby.players[0].userId).toBe(u.user.userId);
    u.close(); s.close();
  });
});

describe('Server-Sitzung: Resume und Verlust (#52)', () => {
  it('Reconnect innerhalb der Frist behält Lobbys (resumed + lobbies)', async () => {
    const { key } = await issueServerKey(hub, 'gs-req');
    const serverId = sid('resume');
    const s = await connectGameServer(hub, { serverKey: key, gameId: 'gs-req', serverId });
    const u = await connectRegistered(hub, await registerUser(hub), 'gs-req');
    const { lobby } = await u.emitAck('createLobby', { name: 'r' });
    s.close();
    await sleep(300);
    const s2 = await connectGameServer(hub, { serverKey: key, gameId: 'gs-req', serverId });
    const hello = await s2.waitFor('hello');
    expect(hello.resumed).toBe(true);
    expect(hello.lobbies.map((l: any) => l.id)).toContain(lobby.id);
    expect((await s2.emitAck('lobby:relay', { lobbyId: lobby.id, type: 'ok' })).ok).toBe(true);
    u.close(); s2.close();
  });

  it('Verlust über die Frist hinaus schließt die Lobbys (gameCrashed); gameAction → SERVER_UNAVAILABLE währenddessen', async () => {
    const s = await server('gs-req');
    const u = await connectRegistered(hub, await registerUser(hub), 'gs-req');
    const { lobby } = await u.emitAck('createLobby', { name: 'lost' });
    s.close();
    await sleep(200);
    expect((await u.emitAck('gameAction', { type: 'a', payload: 1 })).error.code).toBe('SERVER_UNAVAILABLE');
    expect(await u.waitFor('gameCrashed', (d) => d.lobbyId === lobby.id, 4000)).toMatchObject({ code: null });
    expect((await u.emitAck('session:getState')).lobby.status).toBe('closed');
    u.close();
  });

  it('Gleiche serverId mit neuer Verbindung ersetzt die alte (Takeover)', async () => {
    const { key } = await issueServerKey(hub, 'gs-opt');
    const serverId = sid('take');
    const a = await connectGameServer(hub, { serverKey: key, gameId: 'gs-opt', serverId });
    const b = await connectGameServer(hub, { serverKey: key, gameId: 'gs-opt', serverId });
    await new Promise<void>((r) => (a.socket.connected ? a.socket.once('disconnect', () => r()) : r()));
    expect(a.socket.connected).toBe(false);
    expect(b.socket.connected).toBe(true);
    b.close();
  });
});

describe('Server-Verlust, Rebind, Draining (#56)', () => {
  it('lost → server_lost an Mitglieder; Resume → server_resumed, serverStatus ok', async () => {
    const { key } = await issueServerKey(hub, 'gs-req');
    const serverId = sid('lost');
    const s = await connectGameServer(hub, { serverKey: key, gameId: 'gs-req', serverId });
    const u = await connectRegistered(hub, await registerUser(hub), 'gs-req');
    const { lobby } = await u.emitAck('createLobby', { name: 'l' });
    s.close();
    const lost = await updated(u, 'server_lost');
    expect(lost.lobby.serverStatus).toBe('lost');
    const s2 = await connectGameServer(hub, { serverKey: key, gameId: 'gs-req', serverId });
    const back = await updated(u, 'server_resumed');
    expect(back.lobby.serverStatus).toBe('ok');
    expect(back.lobby.id).toBe(lobby.id);
    u.close(); s2.close();
  });

  it('Verlust: Lobby wird auf anderen Server umgebunden (rebind)', async () => {
    const a = await server('gs-req');
    const u = await connectRegistered(hub, await registerUser(hub), 'gs-req');
    const { lobby } = await u.emitAck('createLobby', { name: 'rb' });
    const b = await server('gs-req');
    a.close();
    const re = await b.waitFor('lobby:assigned', (d) => d.lobby.id === lobby.id, 5000);
    expect(re).toMatchObject({ reason: 'server_rebound', previousServerId: expect.any(String), lostAt: expect.any(Number) });
    expect(re.lobby.status).not.toBe('closed');
    await updated(u, 'server_rebound');
    expect((await u.emitAck('session:getState')).lobby.status).not.toBe('closed');
    u.close(); b.close();
  });

  it('Verlust optional ohne Ersatz: Lobby läuft serverlos weiter', async () => {
    const a = await server('gs-opt');
    const u = await connectRegistered(hub, await registerUser(hub), 'gs-opt');
    const { lobby } = await u.emitAck('createLobby', { name: 'cont' });
    expect(lobby.server).toBeTruthy();
    a.close();
    const upd = await updated(u, 'server_lost', (l) => !l.server);
    expect(upd.lobby.status).not.toBe('closed');
    u.close();
  });

  it('Draining markiert Lobbys und nimmt keine neuen an; zurück auf ok', async () => {
    const s = await server('gs-req', { capacity: 5 });
    const u = await connectRegistered(hub, await registerUser(hub), 'gs-req');
    await u.emitAck('createLobby', { name: 'd' });
    await s.emitAck('server:status', { draining: true });
    expect((await updated(u, 'server_draining')).lobby.serverStatus).toBe('draining');
    const u2 = await connectRegistered(hub, await registerUser(hub), 'gs-req');
    expect((await u2.emitAck('createLobby', { name: 'n' })).error.code).toBe('NO_GAME_SERVER_AVAILABLE');
    await s.emitAck('server:status', { draining: false });
    await updated(u, 'server_draining', (l) => l.serverStatus === 'ok');
    u.close(); u2.close(); s.close();
  });
});
