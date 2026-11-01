import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api, befriend, closeAll, connectClient, connectRegistered, gameServer, ipcEvent, live, registerUser, sleep, startHub, type TestClient, type TestHub,
} from './util';

let hub: TestHub;
let authHub: TestHub;
let limitedHub: TestHub;
beforeAll(async () => {
  hub = await startHub({ limits: { joinRequestTimeoutMs: 900 } });
  authHub = await startHub({ env: { ACCESS_TOKEN_TTL_SECONDS: '5', AUTH_EXPIRY_GRACE_MS: '300' } });
  limitedHub = await startHub({ limits: { socketLimits: { listLobbies: { refillPerSecond: 0.01, burst: 1 } } } });
});
afterAll(async () => { await Promise.all([hub.stop(), authHub.stop(), limitedHub.stop()]); });

const post = (h: TestHub, route: string, body: unknown, token?: string) =>
  fetch(`${h.url}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const disconnected = (c: { socket: { connected: boolean; once(e: string, f: () => void): unknown } }): Promise<void> =>
  new Promise<void>((r) => (c.socket.connected ? c.socket.once('disconnect', () => r()) : r()));

describe('Sessions & registration', () => {
  it('TEST-SESS-01: hello announces protocol version, session id, capabilities', async () => {
    const c = await connectClient(hub, await registerUser(hub));
    const hello = await c.waitFor('hello');
    expect(hello.protocolVersion).toBeGreaterThanOrEqual(2);
    expect(hello.sessionId).toBeTruthy();
    expect(hello.capabilities).toContain('gameRegistration');
    c.close();
  });

  it('TEST-SESS-02: createLobby/listLobbies before registerGame fail with GAME_NOT_REGISTERED (ack form)', async () => {
    const c = await connectClient(hub, await registerUser(hub));
    expect(await c.emitAck('createLobby', { name: 'x' })).toMatchObject({ ok: false, error: { code: 'GAME_NOT_REGISTERED' } });
    expect((await c.emitAck('listLobbies')).error.code).toBe('GAME_NOT_REGISTERED');
    c.close();
  });

  it('TEST-SESS-03: unknown game id is rejected with UNKNOWN_GAME', async () => {
    const c = await connectClient(hub, await registerUser(hub));
    expect((await c.emitAck('session:registerGame', { gameId: 'nope' })).error.code).toBe('UNKNOWN_GAME');
    c.close();
  });

  it('TEST-SESS-04: switching game while in a lobby fails with LEAVE_LOBBY_FIRST, works after leaving', async () => {
    const c = await connectRegistered(hub, await registerUser(hub), 'relay');
    await c.emitAck('createLobby', { name: 'a' });
    expect((await c.emitAck('session:registerGame', { gameId: 'other' })).error.code).toBe('LEAVE_LOBBY_FIRST');
    await c.emitAck('leaveLobby');
    expect((await c.emitAck('session:registerGame', { gameId: 'other' })).ok).toBe(true);
    c.close();
  });

  it('TEST-SESS-05: without ack, errors arrive as error + errorDetail events', async () => {
    const c = await connectClient(hub, await registerUser(hub));
    c.socket.emit('createLobby', { name: 'x' });
    expect((await c.waitFor('errorDetail')).code).toBe('GAME_NOT_REGISTERED');
    expect(c.count('error')).toBe(1);
    c.close();
  });

  it('TEST-SESS-06: registerGame returns the registry entry; getState reflects it', async () => {
    const c = await connectRegistered(hub, await registerUser(hub), 'relay');
    const reg = await c.emitAck('session:registerGame', { gameId: 'relay' });
    expect(reg.game).toMatchObject({ id: 'relay', serverSupport: 'none' });
    expect((await c.emitAck('session:getState')).ok).toBe(true);
    c.close();
  });
});

describe('Lobby lifecycle', () => {
  it('TEST-LOBBY-01: creating a second lobby while in one fails with ALREADY_IN_LOBBY', async () => {
    const c = await live(hub);
    expect((await c.emitAck('createLobby', { name: 'a' })).ok).toBe(true);
    expect((await c.emitAck('createLobby', { name: 'b' })).error.code).toBe('ALREADY_IN_LOBBY');
    c.close();
  });

  it('TEST-LOBBY-02: full lobby rejects joiners with LOBBY_FULL; duplicate join and bad codes have stable codes', async () => {
    const [a, b, c] = [await live(hub), await live(hub), await live(hub)];
    const lobby = (await a.emitAck('createLobby', { name: 'r' })).lobby;
    expect((await a.emitAck('joinLobby', { lobbyId: lobby.id })).error.code).toBe('ALREADY_IN_LOBBY');
    expect((await b.emitAck('joinLobby', { lobbyId: lobby.id })).ok).toBe(true);
    expect((await c.emitAck('joinLobby', { lobbyId: lobby.id })).error.code).toBe('LOBBY_FULL');
    expect((await c.emitAck('joinLobbyByCode', { code: 'abc' })).error.code).toBe('INVALID_INVITE_CODE');
    expect((await c.emitAck('joinLobbyByCode', { code: 'ZZZZZZ' })).error.code).toBe('INVITE_CODE_NOT_FOUND');
    closeAll(a, b, c);
  });

  it('TEST-LOBBY-03: host leaves, oldest remaining player becomes host', async () => {
    const [a, b, c] = [await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce')];
    const lobby = (await a.emitAck('createLobby', { name: 'h' })).lobby;
    await b.emitAck('joinLobby', { lobbyId: lobby.id });
    await c.emitAck('joinLobby', { lobbyId: lobby.id });
    await a.emitAck('leaveLobby');
    const updated = await b.waitFor('lobbyUpdated', (l: any) => l.players.length === 2 && !l.players.some((p: any) => p.userId === a.user.userId));
    expect(updated.hostId).toBe(b.user.userId);
    closeAll(a, b, c);
  });

  it('TEST-LOBBY-04: last player leaving dissolves the lobby (gone from listLobbies)', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    const lobby = (await a.emitAck('createLobby', { name: 'gone' })).lobby;
    expect((await b.emitAck('listLobbies')).lobbies.map((l: any) => l.id)).toContain(lobby.id);
    await a.emitAck('leaveLobby');
    expect((await b.emitAck('listLobbies')).lobbies.find((l: any) => l.id === lobby.id)).toBeUndefined();
    closeAll(a, b);
  });

  it('TEST-LOBBY-05: private lobby is hidden from listLobbies; join by code works case-insensitively', async () => {
    const [host, guest] = [await live(hub), await live(hub)];
    const created = (await host.emitAck('createLobby', { name: 'geheim', isPrivate: true })).lobby;
    expect(created.inviteCode).toHaveLength(6);
    expect((await guest.emitAck('listLobbies')).lobbies.map((l: any) => l.id)).not.toContain(created.id);
    expect((await guest.emitAck('joinLobbyByCode', { code: created.inviteCode.toLowerCase() })).ok).toBe(true);
    closeAll(host, guest);
  });

  it('TEST-LOBBY-06: private lobby cannot be joined or requested by ID (LOBBY_PRIVATE); no ID leaks to strangers', async () => {
    const [host, guest, spy] = [await live(hub), await live(hub), await live(hub)];
    const created = (await host.emitAck('createLobby', { name: 'geheim', isPrivate: true })).lobby;
    expect((await guest.emitAck('joinLobby', { lobbyId: created.id })).error.code).toBe('LOBBY_PRIVATE');
    expect((await guest.emitAck('requestJoinLobby', { lobbyId: created.id })).error.code).toBe('LOBBY_PRIVATE');
    await sleep(150);
    expect(spy.events.some((e) => e.event.startsWith('presence:') || e.event === 'friend:presence')).toBe(false);
    expect(JSON.stringify(spy.events)).not.toContain(created.id);
    closeAll(host, guest, spy);
  });

  it('TEST-LOBBY-07: non-host kick/transfer/lock/unlock/setLobbyState are rejected with NOT_HOST', async () => {
    const [host, guest] = [await live(hub), await live(hub)];
    const lobby = (await host.emitAck('createLobby', { name: 'perm' })).lobby;
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });
    for (const [ev, data] of [
      ['kickPlayer', { playerId: host.user.userId }],
      ['transferHost', { playerId: guest.user.userId }],
      ['lockLobby', undefined],
      ['unlockLobby', undefined],
      ['setLobbyState', { state: 'in_progress' }],
    ] as const) {
      const res = await guest.emitAck(ev, data);
      expect(res, ev).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
    }
    closeAll(host, guest);
  });

  it('TEST-LOBBY-08: host kick notifies the victim; there is no ban, an immediate rejoin succeeds', async () => {
    const [host, guest] = [await live(hub), await live(hub)];
    const lobby = (await host.emitAck('createLobby', { name: 'kick' })).lobby;
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });
    expect((await host.emitAck('kickPlayer', { playerId: host.user.userId })).error.code).toBe('CANNOT_KICK_SELF');
    expect((await host.emitAck('kickPlayer', { playerId: guest.user.userId })).ok).toBe(true);
    expect((await guest.waitFor('playerKicked')).lobbyId).toBe(lobby.id);
    expect((await guest.emitAck('joinLobby', { lobbyId: lobby.id })).ok).toBe(true);
    closeAll(host, guest);
  });

  it('TEST-LOBBY-09: killed socket keeps the seat during grace (connected:false), then the player is removed and host transferred', async () => {
    const [host, guest] = [await live(hub, 'relay'), await live(hub, 'relay')];
    const lobby = (await host.emitAck('createLobby', { name: 'drop' })).lobby;
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });
    host.close();
    const dropped = await guest.waitFor('lobbyUpdated', (l: any) => l.players.some((p: any) => p.connected === false));
    expect(dropped.players).toHaveLength(2);
    const after = await guest.waitFor('lobbyUpdated', (l: any) => l.players.length === 1, 6000);
    expect(after.hostId).toBe(guest.user.userId);
    guest.close();
  });

  it('TEST-LOBBY-10: oversized settings → SETTINGS_TOO_LARGE; failed subprocess start leaves no ghost lobby', async () => {
    const c = await live(hub);
    expect((await c.emitAck('createLobby', { name: 'a', settings: { blob: 'x'.repeat(9000) } })).error.code).toBe('SETTINGS_TOO_LARGE');
    expect((await c.emitAck('getLobbyInfo')).error.code).toBe('NOT_IN_LOBBY');
    c.close();
    const b = await connectRegistered(hub, await registerUser(hub), 'broken');
    expect((await b.emitAck('createLobby', { name: 'x' })).error.code).toBe('LOBBY_START_FAILED');
    expect((await b.emitAck('getLobbyInfo')).error.code).toBe('NOT_IN_LOBBY');
    expect((await b.emitAck('listLobbies')).lobbies.filter((l: any) => l.gameId === 'broken')).toHaveLength(0);
    expect((await b.emitAck('createLobby', { name: 'y' })).error.code).toBe('LOBBY_START_FAILED');
    b.close();
  });

  it('TEST-LOBBY-11: names are trimmed; empty/whitespace names are INVALID_INPUT', async () => {
    const c = await live(hub);
    expect((await c.emitAck('createLobby', { name: '   ' })).error.code).toBe('INVALID_INPUT');
    expect((await c.emitAck('createLobby', { name: '  Hallo  ' })).lobby.name).toBe('Hallo');
    c.close();
  });

  it('TEST-LOBBY-12: a second game socket of the same user takes over (session:replaced), the lobby stays', async () => {
    const u = await registerUser(hub);
    const first = await connectRegistered(hub, u, 'relay');
    const lobby = (await first.emitAck('createLobby', { name: 't' })).lobby;
    const second = await connectClient(hub, u);
    await first.waitFor('session:replaced');
    expect((await second.waitFor('session:resumed')).lobby.id).toBe(lobby.id);
    await sleep(300);
    expect((await second.emitAck('getLobbyInfo')).lobby.players[0].connected).not.toBe(false);
    second.close();
  });

  it('TEST-LOBBY-13: lobbies are bound to the registered game; the client cannot choose gameId (GAME_MISMATCH)', async () => {
    const [host, same, other] = [await live(hub, 'relay'), await live(hub, 'relay'), await live(hub, 'other')];
    const created = await host.emitAck('createLobby', { gameId: 'other', name: 'Raum' });
    expect(created.lobby).toMatchObject({ gameId: 'relay', maxPlayers: 2 });
    expect((await other.emitAck('listLobbies')).lobbies.every((l: any) => l.gameId === 'other')).toBe(true);
    expect((await same.emitAck('listLobbies')).lobbies.map((l: any) => l.id)).toContain(created.lobby.id);
    expect((await other.emitAck('joinLobby', { lobbyId: created.lobby.id })).error.code).toBe('GAME_MISMATCH');
    closeAll(host, same, other);
  });

  it('TEST-LOBBY-14: listings only expose publicSettingKeys and never invite codes', async () => {
    const [host, viewer] = [await live(hub, 'fake'), await live(hub, 'fake')];
    await host.emitAck('createLobby', { name: 'f', isPrivate: false, settings: { mode: 'ffa', secret: 'x' } });
    const listing = (await viewer.emitAck('listLobbies')).lobbies.find((l: any) => l.name === 'f');
    expect(listing.settings).toEqual({ mode: 'ffa' });
    expect(listing.inviteCode).toBeUndefined();
    closeAll(host, viewer);
  });

  it('TEST-LOBBY-15: setLobbyState: host only, in_progress locks joining, repeat is INVALID_STATE, closed is final', async () => {
    const [host, other] = [await live(hub), await live(hub)];
    const lobby = (await host.emitAck('createLobby', { name: 'st' })).lobby;
    expect((await host.emitAck('setLobbyState', { state: 'in_progress' })).lobby.status).toBe('in_progress');
    expect((await other.emitAck('joinLobby', { lobbyId: lobby.id })).ok).toBe(false);
    expect((await host.emitAck('setLobbyState', { state: 'in_progress' })).error.code).toBe('INVALID_STATE');
    expect((await host.emitAck('setLobbyState', { state: 'closed' })).lobby.status).toBe('closed');
    closeAll(host, other);
  });

  it('TEST-LOBBY-16: lobbyUpdated carries a reason (player_joined, host_transferred)', async () => {
    const [host, guest] = [await live(hub), await live(hub)];
    const lobby = (await host.emitAck('createLobby', { name: 'reason' })).lobby;
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });
    await host.waitFor('lobbyUpdated', () => true);
    expect(host.events.find((e) => e.event === 'lobbyUpdated' && e.args[1] === 'player_joined')).toBeTruthy();
    await host.emitAck('transferHost', { playerId: guest.user.userId });
    await guest.waitFor('lobbyUpdated', (l: any) => l.hostId === guest.user.userId);
    expect(guest.events.some((e) => e.event === 'lobbyUpdated' && e.args[1] === 'host_transferred')).toBe(true);
    closeAll(host, guest);
  });
});

describe('Join requests', () => {
  const pair = async () => {
    const [host, guest] = [await live(hub), await live(hub)];
    const lobbyId = (await host.emitAck('createLobby', { name: 'l' })).lobby.id as string;
    await host.emitAck('lockLobby');
    return { host, guest, lobbyId };
  };

  it('TEST-JOIN-01: locked lobby rejects joinLobby (LOBBY_LOCKED); requestJoinLobby → pending, host accepts', async () => {
    const { host, guest, lobbyId } = await pair();
    expect((await guest.emitAck('joinLobby', { lobbyId })).error.code).toBe('LOBBY_LOCKED');
    expect(await guest.emitAck('requestJoinLobby', { lobbyId })).toMatchObject({ ok: true, pending: true });
    expect((await host.waitFor('joinRequestReceived')).requesterId).toBe(guest.user.userId);
    expect((await host.emitAck('respondJoinRequest', { requesterId: guest.user.userId, accept: true })).ok).toBe(true);
    expect((await guest.waitFor('joinRequestAccepted')).lobby.players).toHaveLength(2);
    closeAll(host, guest);
  });

  it('TEST-JOIN-02: decline → requester gets joinRequestRejected(declined); unknown request → JOIN_REQUEST_NOT_FOUND', async () => {
    const { host, guest, lobbyId } = await pair();
    await guest.emitAck('requestJoinLobby', { lobbyId });
    await host.waitFor('joinRequestReceived');
    await host.emitAck('respondJoinRequest', { requesterId: guest.user.userId, accept: false });
    expect(await guest.waitFor('joinRequestRejected')).toEqual({ lobbyId, reason: 'declined' });
    expect((await host.emitAck('respondJoinRequest', { requesterId: guest.user.userId, accept: true })).error.code).toBe('JOIN_REQUEST_NOT_FOUND');
    closeAll(host, guest);
  });

  it('TEST-JOIN-03: unanswered request times out: requester gets rejected(timeout), host gets withdrawn(timeout)', async () => {
    const { host, guest, lobbyId } = await pair();
    await guest.emitAck('requestJoinLobby', { lobbyId });
    await host.waitFor('joinRequestReceived');
    expect(await guest.waitFor('joinRequestRejected', () => true, 4000)).toEqual({ lobbyId, reason: 'timeout' });
    expect(await host.waitFor('joinRequestWithdrawn', () => true, 4000)).toEqual({ lobbyId, requesterId: guest.user.userId, reason: 'timeout' });
    closeAll(host, guest);
  });

  it('TEST-JOIN-04: cancelJoinRequest notifies host and requester sessions; second cancel → JOIN_REQUEST_NOT_FOUND', async () => {
    const { host, guest, lobbyId } = await pair();
    await guest.emitAck('requestJoinLobby', { lobbyId });
    await host.waitFor('joinRequestReceived');
    expect((await guest.emitAck('cancelJoinRequest', { lobbyId })).ok).toBe(true);
    const expected = { lobbyId, requesterId: guest.user.userId, reason: 'cancelled' };
    expect(await host.waitFor('joinRequestWithdrawn')).toEqual(expected);
    expect(await guest.waitFor('joinRequestWithdrawn')).toEqual(expected);
    expect((await guest.emitAck('cancelJoinRequest', { lobbyId })).error.code).toBe('JOIN_REQUEST_NOT_FOUND');
    closeAll(host, guest);
  });

  it('TEST-JOIN-05: requester disconnect withdraws the request for the host', async () => {
    const { host, guest, lobbyId } = await pair();
    await guest.emitAck('requestJoinLobby', { lobbyId });
    await host.waitFor('joinRequestReceived');
    guest.close();
    expect(await host.waitFor('joinRequestWithdrawn', () => true, 8000)).toMatchObject({ lobbyId, reason: 'cancelled' });
    expect((await host.emitAck('getJoinRequests')).incoming).toEqual([]);
    host.close();
  });

  it('TEST-JOIN-06: host leaving informs the requester (lobby_closed / host_changed)', async () => {
    const { host, guest, lobbyId } = await pair();
    await guest.emitAck('requestJoinLobby', { lobbyId });
    await host.waitFor('joinRequestReceived');
    await host.emitAck('leaveLobby');
    const rej = await guest.waitFor('joinRequestRejected');
    expect(rej.lobbyId).toBe(lobbyId);
    expect(['lobby_closed', 'host_changed']).toContain(rej.reason);
    closeAll(host, guest);
  });

  it('TEST-JOIN-07: getJoinRequests mirrors both sides and carries expiresAt', async () => {
    const { host, guest, lobbyId } = await pair();
    await guest.emitAck('requestJoinLobby', { lobbyId });
    const pending = await guest.waitFor('joinRequestPending');
    const received = await host.waitFor('joinRequestReceived');
    expect(received).toMatchObject({ lobbyId, requesterId: guest.user.userId, expiresAt: pending.expiresAt });
    const h = await host.emitAck('getJoinRequests');
    expect(h.incoming).toEqual([{ lobbyId, requesterId: guest.user.userId, username: guest.user.username, expiresAt: pending.expiresAt }]);
    expect(h.outgoing).toBeUndefined();
    const g = await guest.emitAck('getJoinRequests');
    expect(g.incoming).toEqual([]);
    expect(g.outgoing).toMatchObject({ lobbyId, requesterId: guest.user.userId });
    closeAll(host, guest);
  });

  it('TEST-JOIN-08: requestJoinLobby on an unlocked lobby joins immediately; unlock lets joinLobby work again', async () => {
    const [host, guest, late] = [await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce')];
    const lobbyId = (await host.emitAck('createLobby', { name: 'u' })).lobby.id;
    expect(await guest.emitAck('requestJoinLobby', { lobbyId })).toMatchObject({ ok: true, pending: false });
    await host.emitAck('lockLobby');
    expect((await late.emitAck('joinLobby', { lobbyId })).error.code).toBe('LOBBY_LOCKED');
    await host.emitAck('unlockLobby');
    expect((await late.emitAck('joinLobby', { lobbyId })).ok).toBe(true);
    closeAll(host, guest, late);
  });
});

describe('Relay', () => {
  it('TEST-COMM-01: sendToLobby reaches the other members, never the sender', async () => {
    const [a, b, c] = [await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce')];
    const lobby = (await a.emitAck('createLobby', { name: 'relay' })).lobby;
    await b.emitAck('joinLobby', { lobbyId: lobby.id });
    await c.emitAck('joinLobby', { lobbyId: lobby.id });
    for (const [s, others] of [[a, [b, c]], [b, [a, c]], [c, [a, b]]] as const) {
      expect((await s.emitAck('sendToLobby', { type: 'hi', payload: s.user.username })).ok).toBe(true);
      for (const o of others) expect(await o.waitFor('message', (m) => m.payload === s.user.username)).toMatchObject({ from: s.user.userId, type: 'hi' });
    }
    await sleep(100);
    for (const x of [a, b, c]) expect(x.count('message', (m) => m.from === x.user.userId)).toBe(0);
    closeAll(a, b, c);
  });

  it('TEST-COMM-02: sendToPlayer works in-lobby; other-lobby/self/no-lobby have stable error codes', async () => {
    const [a, b, outsider] = [await live(hub), await live(hub), await live(hub)];
    const lobby = (await a.emitAck('createLobby', { name: 'dm' })).lobby;
    await b.emitAck('joinLobby', { lobbyId: lobby.id });
    expect((await a.emitAck('sendToPlayer', { playerId: b.user.userId, type: 'dm', payload: 2 })).ok).toBe(true);
    await b.waitFor('message', (m) => m.type === 'dm');
    expect((await a.emitAck('sendToPlayer', { playerId: outsider.user.userId, type: 'dm', payload: 2 })).error.code).toBe('PLAYER_NOT_IN_LOBBY');
    expect((await a.emitAck('sendToPlayer', { playerId: a.user.userId, type: 'dm', payload: 2 })).error.code).toBe('CANNOT_TARGET_SELF');
    expect((await outsider.emitAck('sendToLobby', { type: 'x', payload: 1 })).error.code).toBe('NOT_IN_LOBBY');
    closeAll(a, b, outsider);
  });

  it('TEST-COMM-03: binary relay validates type code and size, delivers valid frames', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    const lobby = (await a.emitAck('createLobby', { name: 'bin' })).lobby;
    await b.emitAck('joinLobby', { lobbyId: lobby.id });
    expect((await a.emitAck('sendToLobbyBinary', { typeCode: 70000, payload: new Uint8Array(2) })).error.code).toBe('INVALID_BINARY_TYPECODE');
    expect((await a.emitAck('sendToLobbyBinary', { typeCode: 1, payload: new Uint8Array(5000) })).error.code).toBe('BINARY_PAYLOAD_TOO_LARGE');
    expect((await a.emitAck('sendToLobbyBinary', { typeCode: 1, payload: new Uint8Array(1000) })).ok).toBe(true);
    expect((await a.emitAck('sendToLobbyBinary', { typeCode: 1, payload: new Uint8Array(1001) })).error.code).toBe('BINARY_PAYLOAD_TOO_LARGE');
    expect((await a.emitAck('sendToLobbyBinary', { typeCode: 65535, payload: new Uint8Array([1, 2]) })).ok).toBe(true);
    expect((await b.waitFor('messageBinary', (m) => m.typeCode === 65535)).typeCode).toBe(65535);
    closeAll(a, b);
  });

  it('TEST-COMM-04: JSON relay validates type and size; seq increases monotonically', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    const lobby = (await a.emitAck('createLobby', { name: 'rl' })).lobby;
    await b.emitAck('joinLobby', { lobbyId: lobby.id });
    expect((await a.emitAck('sendToLobby', { type: 'bad type!', payload: 1 })).error.code).toBe('INVALID_MESSAGE_TYPE');
    expect((await a.emitAck('sendToLobby', { type: 't', payload: 'x'.repeat(20000) })).error.code).toBe('PAYLOAD_TOO_LARGE');
    const r1 = await a.emitAck('sendToLobby', { type: 't', payload: 1 });
    const r2 = await a.emitAck('sendToLobby', { type: 't', payload: 2 });
    expect(r2.seq).toBe(r1.seq + 1);
    closeAll(a, b);
  });

  it('TEST-COMM-05: relay is rejected for a client in no lobby even right after joining via another session (NOT_IN_LOBBY)', async () => {
    const u = await registerUser(hub);
    const c = await connectRegistered(hub, u, 'relay');
    expect((await c.emitAck('sendToLobby', { type: 't', payload: 1 })).error.code).toBe('NOT_IN_LOBBY');
    expect((await c.emitAck('sendToLobbyBinary', { typeCode: 1, payload: new Uint8Array(1) })).error.code).toBe('NOT_IN_LOBBY');
    c.close();
  });
});

describe('Reconnect grace', () => {
  it('TEST-RECON-01: reconnect within grace restores the lobby (hello.lobbyId, session:resumed) and relay works', async () => {
    const [host, guest] = [await live(hub), await live(hub)];
    const lobby = (await host.emitAck('createLobby', { name: 'r' })).lobby;
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });
    const user = guest.user;
    guest.close();
    await host.waitFor('lobbyUpdated', (l: any) => l.players.some((p: any) => p.connected === false));
    const back = await connectClient(hub, user);
    const hello = await back.waitFor('hello');
    expect(hello).toMatchObject({ lobbyId: lobby.id, gameId: 'relay' });
    expect((await back.waitFor('session:resumed')).lobby.id).toBe(lobby.id);
    await host.waitFor('lobbyUpdated', (l: any) => l.players.length === 2 && l.players.every((p: any) => p.connected !== false));
    await host.emitAck('sendToLobby', { type: 'ping', payload: 1 });
    expect((await back.waitFor('message')).type).toBe('ping');
    closeAll(host, back);
  });

  it('TEST-RECON-02: grace expiry removes the player and transfers host; the lobby survives for the rest', async () => {
    const [host, guest] = [await live(hub), await live(hub)];
    const lobby = (await host.emitAck('createLobby', { name: 'r' })).lobby;
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });
    host.close();
    const after = await guest.waitFor('lobbyUpdated', (l: any) => l.players.length === 1, 6000);
    expect(after.hostId).toBe(guest.user.userId);
    guest.close();
  });

  it('TEST-RECON-03: reconnectGraceMs 0 removes the player immediately', async () => {
    const [host, guest] = [await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce')];
    const lobby = (await host.emitAck('createLobby', { name: 'r' })).lobby;
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });
    guest.close();
    const after = await host.waitFor('lobbyUpdated', (l: any) => l.players.length === 1, 3000);
    expect(after.players[0].userId).toBe(host.user.userId);
    host.close();
  });

  it('TEST-RECON-04: takeover by a new session keeps the lobby (session:replaced → session:resumed)', async () => {
    const u = await registerUser(hub);
    const old = await connectRegistered(hub, u, 'relay');
    const lobby = (await old.emitAck('createLobby', { name: 't' })).lobby;
    const fresh = await connectClient(hub, u);
    await old.waitFor('session:replaced');
    expect((await fresh.waitFor('session:resumed')).lobby.id).toBe(lobby.id);
    closeAll(old, fresh);
  });

  it('TEST-RECON-05: subprocess receives PLAYER_DISCONNECT, PLAYER_RECONNECT and (after grace) PLAYER_LEAVE', async () => {
    const [host, guest] = [await live(hub, 'fake'), await live(hub, 'fake')];
    const lobby = (await host.emitAck('createLobby', { name: 'p' })).lobby;
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });
    await host.waitFor('gameEvent', ipcEvent('PLAYER_JOIN'));
    const g = guest.user;
    guest.close();
    await host.waitFor('gameEvent', ipcEvent('PLAYER_DISCONNECT'));
    const back = await connectClient(hub, g);
    await host.waitFor('gameEvent', ipcEvent('PLAYER_RECONNECT'));
    expect(host.count('gameEvent', ipcEvent('PLAYER_LEAVE'))).toBe(0);
    back.close();
    await host.waitFor('gameEvent', ipcEvent('PLAYER_LEAVE'), 6000);
    host.close();
  });

  it('TEST-RECON-06: explicit leaveLobby sends PLAYER_LEAVE immediately (no grace)', async () => {
    const [host, guest] = [await live(hub, 'fake'), await live(hub, 'fake')];
    const lobby = (await host.emitAck('createLobby', { name: 'p' })).lobby;
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });
    await guest.emitAck('leaveLobby');
    await host.waitFor('gameEvent', ipcEvent('PLAYER_LEAVE'), 2000);
    closeAll(host, guest);
  });
});

describe('User data integrity', () => {
  it('TEST-DATA-01: PUT without visibility keeps the existing visibility and bumps the version', async () => {
    const u = await registerUser(hub);
    await api(hub, u, 'PUT', '/userdata/relay/score', { value: 1, visibility: 'lobby' });
    await api(hub, u, 'PUT', '/userdata/relay/score', { value: 2 });
    const { body } = await api(hub, u, 'GET', '/userdata/relay/score');
    expect(body).toMatchObject({ value: 2, visibility: 'lobby', version: 2, writeScope: 'client' });
  });

  it('TEST-DATA-02: serverKeys are read-only for clients (REST single+PATCH transactional, socket); subprocess writes via SAVE_META', async () => {
    const host = await live(hub, 'fake');
    await host.emitAck('createLobby', { name: 'd' });
    const u = host.user;
    expect((await api(hub, u, 'PUT', '/userdata/fake/rank.points', { value: 999999 })).body.code).toBe('DATA_READ_ONLY');
    expect((await api(hub, u, 'PATCH', '/userdata/fake', [{ key: 'ok', value: 1 }, { key: 'rank.points', value: 1 }])).status).toBe(403);
    expect((await api(hub, u, 'GET', '/userdata/fake/ok')).status).toBe(404);
    expect((await host.emitAck('setUserData', { gameId: 'fake', key: 'rank.points', value: 1 })).ok).toBe(false);
    host.socket.emit('gameAction', { type: 'save', payload: { gameId: 'fake', value: 42 } });
    let got: any;
    for (let i = 0; i < 50 && !got; i++) {
      const r = await api(hub, u, 'GET', '/userdata/fake/rank.points');
      if (r.status === 200) got = r.body;
      else await sleep(100);
    }
    expect(got).toMatchObject({ value: 42, writeScope: 'server', visibility: 'private' });
    expect((await api(hub, u, 'DELETE', '/userdata/fake/rank.points')).body.code).toBe('DATA_READ_ONLY');
    host.close();
  });

  it('TEST-DATA-03: getPlayerData matrix: private never; lobby for lobby-mates; friends for friends; self sees all but public; strangers/unknown users NOT_ALLOWED', async () => {
    const [a, mate, friend, stranger] = [await live(hub, 'other'), await live(hub, 'other'), await live(hub, 'other'), await live(hub, 'other')];
    await befriend(a, friend);
    await a.emitAck('bulkSetUserData', { gameId: 'other', entries: [
      { key: 'priv', value: 1, visibility: 'private' }, { key: 'lob', value: 2, visibility: 'lobby' }, { key: 'fri', value: 3, visibility: 'friends' }] });
    const keysOf = async (c: TestClient, id = a.user.userId) => (await c.emitAck('getPlayerData', { playerId: id, gameId: 'other' }));
    expect((await keysOf(friend)).entries.map((e: any) => e.key)).toEqual(['fri']);
    for (const c of [stranger, mate]) expect((await keysOf(c)).error.code).toBe('NOT_ALLOWED');
    const lobby = (await a.emitAck('createLobby', { name: 'v' })).lobby;
    await mate.emitAck('joinLobby', { lobbyId: lobby.id });
    await friend.emitAck('joinLobby', { lobbyId: lobby.id });
    expect((await keysOf(mate)).entries.map((e: any) => e.key)).toEqual(['lob']);
    expect((await keysOf(friend)).entries.map((e: any) => e.key).sort()).toEqual(['fri', 'lob']);
    expect((await keysOf(stranger)).error.code).toBe('NOT_ALLOWED');
    expect((await keysOf(a)).entries.map((e: any) => e.key).sort()).toEqual(['fri', 'lob', 'priv']);
    const missing = await keysOf(stranger, 'no-such-user');
    expect(missing.error).toEqual((await keysOf(stranger)).error);
    const rest = await api(hub, stranger.user, 'GET', `/players/${a.user.userId}/data/relay`);
    const restMissing = await api(hub, stranger.user, 'GET', '/players/no-such-user/data/relay');
    expect([rest.status, restMissing.status]).toEqual([403, 403]);
    expect(rest.body).toEqual(restMissing.body);
    closeAll(a, mate, friend, stranger);
  });

  it('TEST-DATA-04: validation: unknown game, bad key chars, value size, per-game quota', async () => {
    const u = await registerUser(hub);
    expect(await api(hub, u, 'PUT', '/userdata/does-not-exist/k', { value: 1 })).toMatchObject({ status: 400, body: { code: 'UNKNOWN_GAME' } });
    expect((await api(hub, u, 'PUT', '/userdata/relay/bad key!', { value: 1 })).status).toBe(400);
    expect(await api(hub, u, 'PUT', '/userdata/relay/big', { value: 'x'.repeat(20000) })).toMatchObject({ status: 413, body: { code: 'DATA_VALUE_TOO_LARGE' } });
    for (let i = 0; i < 200; i += 100) {
      const entries = Array.from({ length: 100 }, (_, j) => ({ key: `k${i + j}`, value: 1 }));
      expect((await api(hub, u, 'PATCH', '/userdata/relay', entries)).status).toBe(200);
    }
    expect(await api(hub, u, 'PUT', '/userdata/relay/k-extra', { value: 1 })).toMatchObject({ status: 413, body: { code: 'DATA_QUOTA_EXCEEDED' } });
    expect((await api(hub, u, 'PUT', '/userdata/relay/k0', { value: 2 })).status).toBe(200);
  });

  it('TEST-DATA-05: socket parity: setUserData / bulkSetUserData / deleteUserData / getUserData and codes', async () => {
    const c = await live(hub);
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

  it('TEST-DATA-06: SAVE_META for a game other than the lobby game is discarded', async () => {
    const host = await live(hub, 'fake');
    await host.emitAck('createLobby', { name: 'd' });
    host.socket.emit('gameAction', { type: 'save', payload: { gameId: 'relay', value: 1 } });
    await sleep(800);
    expect((await api(hub, host.user, 'GET', '/userdata/relay/rank.points')).status).toBe(404);
    host.close();
  });

  it('TEST-DATA-07: leaderboard lists public numeric keys written by the game server, sorted desc; private keys never appear', async () => {
    const gs = await gameServer(hub, 'gs-opt');
    const [a, b] = [await live(hub, 'gs-opt'), await live(hub, 'gs-opt')];
    const lobby = (await a.emitAck('createLobby', { name: 'lb' })).lobby;
    await b.emitAck('joinLobby', { lobbyId: lobby.id });
    for (const [c, v] of [[a, 10], [b, 30]] as const) {
      expect((await gs.emitAck('data:set', { lobbyId: lobby.id, userId: c.user.userId, key: 'lb', value: v, visibility: 'public' })).ok).toBe(true);
    }
    await gs.emitAck('data:set', { lobbyId: lobby.id, userId: a.user.userId, key: 'lbp', value: 99 });
    const rows = (await api(hub, a.user, 'GET', '/leaderboard/gs-opt/lb?limit=5')).body as Array<{ userId: string }>;
    expect(rows.map((r) => r.userId)).toEqual([b.user.userId, a.user.userId]);
    expect(JSON.stringify((await api(hub, a.user, 'GET', '/leaderboard/gs-opt/lbp')).body)).not.toContain(a.user.userId);
    closeAll(a, b, gs);
  });
});

describe('Auth lifecycle', () => {
  it('TEST-AUTH-01: socket without refresh gets AUTH_EXPIRED after expiry and is disconnected', async () => {
    const c = await connectClient(authHub, await registerUser(authHub));
    expect((await c.waitFor('errorDetail', (d: any) => d.code === 'AUTH_EXPIRED', 8000)).code).toBe('AUTH_EXPIRED');
    await disconnected(c);
    expect(c.socket.connected).toBe(false);
  });

  it('TEST-AUTH-02: auth:refresh keeps the socket alive beyond the original expiry', async () => {
    const user = await registerUser(authHub);
    const c = await connectClient(authHub, user);
    await sleep(1000);
    let refreshToken = user.refreshToken;
    for (const wait of [2000, 0]) {
      const res = await (await post(authHub, '/auth/refresh', { refreshToken })).json();
      refreshToken = res.refreshToken;
      expect((await c.emitAck('auth:refresh', { token: res.accessToken })).ok).toBe(true);
      await sleep(wait);
    }
    await sleep(2800); // the original token (TTL 5s + 300ms grace) is dead by now
    expect(c.socket.connected).toBe(true);
    expect(c.count('errorDetail', (d: any) => d.code === 'AUTH_EXPIRED')).toBe(0);
    c.close();
  });

  it('TEST-AUTH-03: auth:refresh with another user\'s token is INVALID_TOKEN', async () => {
    const c = await connectClient(authHub, await registerUser(authHub));
    const other = await registerUser(authHub);
    expect(await c.emitAck('auth:refresh', { token: other.accessToken })).toMatchObject({ ok: false, error: { code: 'INVALID_TOKEN' } });
    c.close();
  });

  it('TEST-AUTH-04: logout disconnects all sockets of the user', async () => {
    const user = await registerUser(authHub);
    const c = await connectClient(authHub, user);
    expect((await post(authHub, '/auth/logout', { refreshToken: user.refreshToken })).status).toBe(204);
    await disconnected(c);
    expect(c.socket.connected).toBe(false);
  });

  it('TEST-AUTH-05: logout-all revokes refresh tokens and disconnects sockets', async () => {
    const user = await registerUser(authHub);
    const c = await connectClient(authHub, user);
    expect((await post(authHub, '/auth/logout-all', {}, user.accessToken)).status).toBe(204);
    await disconnected(c);
    expect(c.socket.connected).toBe(false);
    expect((await post(authHub, '/auth/refresh', { refreshToken: user.refreshToken })).status).toBe(401);
  });

  it('TEST-AUTH-06: refresh rotation: a reused refresh token is REFRESH_TOKEN_REVOKED', async () => {
    const u = await registerUser(hub);
    expect((await post(hub, '/auth/refresh', { refreshToken: u.refreshToken })).status).toBe(200);
    const reuse = await post(hub, '/auth/refresh', { refreshToken: u.refreshToken });
    expect(reuse.status).toBe(401);
    expect((await reuse.json()).code).toBe('REFRESH_TOKEN_REVOKED');
  });

  it('TEST-AUTH-07: usernames are unique and login is case-insensitive; REST errors carry code + error text', async () => {
    const name = `CaseUser${Date.now().toString(36)}`;
    const reg = (n: string) => post(hub, '/auth/register', { username: n, password: 'password123' });
    expect((await reg(name)).status).toBe(201);
    const dup = await reg(name.toLowerCase());
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ code: 'USERNAME_TAKEN', error: expect.any(String) });
    const login = await post(hub, '/auth/login', { username: name.toUpperCase(), password: 'password123' });
    expect((await login.json()).user.username).toBe(name);
    const bad = await post(hub, '/auth/login', { username: name, password: 'wrongpass' });
    expect(bad.status).toBe(401);
    expect((await bad.json()).code).toBe('INVALID_CREDENTIALS');
    const noAuth = await fetch(`${hub.url}/userdata/relay`);
    expect(noAuth.status).toBe(401);
    expect((await noAuth.json()).code).toBe('UNAUTHENTICATED');
  });

  it('TEST-AUTH-08: socket connect without / with invalid token fails with UNAUTHENTICATED / INVALID_TOKEN', async () => {
    const { io } = await import('socket.io-client');
    const attempt = (auth: Record<string, unknown>) => new Promise<string>((resolve) => {
      const s = io(hub.url, { auth, transports: ['websocket'], forceNew: true, reconnection: false });
      s.once('connect_error', (e) => { s.close(); resolve(e.message); });
      s.once('connect', () => { s.close(); resolve('connected'); });
    });
    expect(await attempt({})).toBe('UNAUTHENTICATED');
    expect(await attempt({ token: 'Bearer not-a-jwt' })).toBe('INVALID_TOKEN');
  });
});

describe('Rate limits & infra', () => {
  it('TEST-LIMIT-01: socket rate limit answers RATE_LIMITED with retryAfterMs in the ack', async () => {
    const c = await live(limitedHub);
    expect((await c.emitAck('listLobbies')).ok).toBe(true);
    const res = await c.emitAck('listLobbies');
    expect(res.error.code).toBe('RATE_LIMITED');
    expect(res.error.retryAfterMs).toBeGreaterThan(0);
    c.close();
  });

  it('TEST-LIMIT-02: HTTP auth rate limit returns 429 RATE_LIMITED', async () => {
    const strict = await startHub({ limits: { authRateLimits: { login: { windowMs: 60000, max: 2, message: 'slow down' }, register: { windowMs: 60000, max: 10000, message: 'x' }, refresh: { windowMs: 60000, max: 10000, message: 'x' } } } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) codes.push((await post(strict, '/auth/login', { username: 'nobody', password: 'password123' })).status);
      expect(codes).toContain(429);
      expect(codes[0]).not.toBe(429);
    } finally {
      await strict.stop();
    }
  });

  it('TEST-INFRA-01: /health and /api/games are reachable; test games are registered', async () => {
    expect((await fetch(`${hub.url}/health`)).status).toBe(200);
    const games = await (await fetch(`${hub.url}/api/games`)).json();
    expect(games.map((g: any) => g.id)).toEqual(expect.arrayContaining(['dudg', 'tictactoe', 'fake', 'relay']));
  });
});
