import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectClient, connectRegistered, registerUser, startHub, type TestHub } from './helpers/hub';

let hub: TestHub;
beforeAll(async () => { hub = await startHub(); });
afterAll(async () => { await hub.stop(); });

describe('Session & Spielregistrierung (#16)', () => {
  it('hello enthält Protokollversion, Session und Capabilities', async () => {
    const u = await registerUser(hub);
    const c = await connectClient(hub, u);
    const hello = await c.waitFor('hello');
    expect(hello.protocolVersion).toBeGreaterThanOrEqual(2);
    expect(hello.sessionId).toBeTruthy();
    expect(hello.capabilities).toContain('gameRegistration');
    c.close();
  });

  it('createLobby/listLobbies ohne Registrierung → GAME_NOT_REGISTERED', async () => {
    const c = await connectClient(hub, await registerUser(hub));
    const created = await c.emitAck('createLobby', { name: 'x' });
    expect(created).toMatchObject({ ok: false, error: { code: 'GAME_NOT_REGISTERED' } });
    const listed = await c.emitAck('listLobbies');
    expect(listed.error.code).toBe('GAME_NOT_REGISTERED');
    c.close();
  });

  it('unbekanntes Spiel → UNKNOWN_GAME', async () => {
    const c = await connectClient(hub, await registerUser(hub));
    const res = await c.emitAck('session:registerGame', { gameId: 'nope' });
    expect(res.error.code).toBe('UNKNOWN_GAME');
    c.close();
  });

  it('Spielwechsel in einer Lobby → LEAVE_LOBBY_FIRST', async () => {
    const c = await connectRegistered(hub, await registerUser(hub), 'relay');
    await c.emitAck('createLobby', { name: 'a' });
    const res = await c.emitAck('session:registerGame', { gameId: 'other' });
    expect(res.error.code).toBe('LEAVE_LOBBY_FIRST');
    await c.emitAck('leaveLobby');
    expect((await c.emitAck('session:registerGame', { gameId: 'other' })).ok).toBe(true);
    c.close();
  });

  it('ohne Ack kommen Fehler als error + errorDetail Event', async () => {
    const c = await connectClient(hub, await registerUser(hub));
    c.socket.emit('createLobby', { name: 'x' });
    const detail = await c.waitFor('errorDetail');
    expect(detail.code).toBe('GAME_NOT_REGISTERED');
    expect(c.count('error')).toBe(1);
    c.close();
  });
});

describe('Lobby-Workflow (#17)', () => {
  it('Lobby gehört automatisch zum registrierten Spiel; nur gleiches Spiel kann beitreten', async () => {
    const host = await connectRegistered(hub, await registerUser(hub), 'relay');
    const sameGame = await connectRegistered(hub, await registerUser(hub), 'relay');
    const otherGame = await connectRegistered(hub, await registerUser(hub), 'other');

    const created = await host.emitAck('createLobby', { name: 'Raum' });
    expect(created.ok).toBe(true);
    expect(created.lobby.gameId).toBe('relay');
    expect(created.lobby.maxPlayers).toBe(2);

    expect((await otherGame.emitAck('listLobbies')).lobbies.every((l: any) => l.gameId === 'other')).toBe(true);
    expect((await sameGame.emitAck('listLobbies')).lobbies.map((l: any) => l.id)).toContain(created.lobby.id);

    const wrong = await otherGame.emitAck('joinLobby', { lobbyId: created.lobby.id });
    expect(wrong.error.code).toBe('GAME_MISMATCH');

    const ok = await sameGame.emitAck('joinLobby', { lobbyId: created.lobby.id });
    expect(ok.ok).toBe(true);
    expect(ok.lobby.players).toHaveLength(2);
    for (const c of [host, sameGame, otherGame]) c.close();
  });

  it('Client darf gameId nicht frei wählen (Legacy-Feld wird ignoriert)', async () => {
    const c = await connectRegistered(hub, await registerUser(hub), 'relay');
    const res = await c.emitAck('createLobby', { gameId: 'other', name: 'x' });
    expect(res.lobby.gameId).toBe('relay');
    c.close();
  });

  it('Name wird getrimmt; leerer Name und zu große Settings werden abgelehnt', async () => {
    const c = await connectRegistered(hub, await registerUser(hub), 'relay');
    expect((await c.emitAck('createLobby', { name: '   ' })).error.code).toBe('INVALID_INPUT');
    const big = await c.emitAck('createLobby', { name: 'a', settings: { blob: 'x'.repeat(9000) } });
    expect(big.error.code).toBe('SETTINGS_TOO_LARGE');
    const ok = await c.emitAck('createLobby', { name: '  Hallo  ' });
    expect(ok.lobby.name).toBe('Hallo');
    c.close();
  });

  it('private Lobby: Beitritt per ID verboten, per Code erlaubt; nicht in Liste und nicht in Presence-Broadcasts', async () => {
    const host = await connectRegistered(hub, await registerUser(hub), 'relay');
    const guest = await connectRegistered(hub, await registerUser(hub), 'relay');
    const spy = await connectRegistered(hub, await registerUser(hub), 'relay');

    const created = await host.emitAck('createLobby', { name: 'geheim', isPrivate: true });
    expect(created.lobby.inviteCode).toHaveLength(6);

    expect((await guest.emitAck('listLobbies')).lobbies.map((l: any) => l.id)).not.toContain(created.lobby.id);
    expect((await guest.emitAck('joinLobby', { lobbyId: created.lobby.id })).error.code).toBe('LOBBY_PRIVATE');
    expect((await guest.emitAck('requestJoinLobby', { lobbyId: created.lobby.id })).error.code).toBe('LOBBY_PRIVATE');

    // Presence geht nur noch an Freunde — der Fremde erhält weder Events noch die Lobby-ID
    await new Promise((r) => setTimeout(r, 150));
    expect(spy.events.some((e) => e.event.startsWith('presence:') || e.event === 'friend:presence')).toBe(false);
    expect(JSON.stringify(spy.events)).not.toContain(created.lobby.id);

    const joined = await guest.emitAck('joinLobbyByCode', { code: created.lobby.inviteCode.toLowerCase() });
    expect(joined.ok).toBe(true);
    for (const c of [host, guest, spy]) c.close();
  });

  it('Lobby voll, doppelter Beitritt, Code ungültig/unbekannt', async () => {
    const [a, b, c3] = await Promise.all([1, 2, 3].map(async () => connectRegistered(hub, await registerUser(hub), 'relay')));
    const lobby = (await a.emitAck('createLobby', { name: 'r' })).lobby;
    expect((await a.emitAck('joinLobby', { lobbyId: lobby.id })).error.code).toBe('ALREADY_IN_LOBBY');
    expect((await b.emitAck('joinLobby', { lobbyId: lobby.id })).ok).toBe(true);
    expect((await c3.emitAck('joinLobby', { lobbyId: lobby.id })).error.code).toBe('LOBBY_FULL');
    expect((await c3.emitAck('joinLobbyByCode', { code: 'abc' })).error.code).toBe('INVALID_INVITE_CODE');
    expect((await c3.emitAck('joinLobbyByCode', { code: 'ZZZZZZ' })).error.code).toBe('INVITE_CODE_NOT_FOUND');
    for (const c of [a, b, c3]) c.close();
  });

  it('Listing filtert Settings nach publicSettingKeys und verbirgt Invite-Codes', async () => {
    const host = await connectRegistered(hub, await registerUser(hub), 'fake');
    const viewer = await connectRegistered(hub, await registerUser(hub), 'fake');
    await host.emitAck('createLobby', { name: 'f', settings: { mode: 'ffa', secret: 'x' } });
    const { lobbies } = await viewer.emitAck('listLobbies');
    expect(lobbies[0].settings).toEqual({ mode: 'ffa' });
    host.close(); viewer.close();
  });

  it('fehlgeschlagener Subprocess-Start hinterlässt keine Ghost-Lobby', async () => {
    const c = await connectRegistered(hub, await registerUser(hub), 'broken');
    const res = await c.emitAck('createLobby', { name: 'x' });
    expect(res.error.code).toBe('LOBBY_START_FAILED');
    expect((await c.emitAck('getLobbyInfo')).error.code).toBe('NOT_IN_LOBBY');
    expect((await c.emitAck('listLobbies')).lobbies.filter((l: any) => l.gameId === 'broken')).toHaveLength(0);
    // erneuter Versuch ist möglich (nicht ALREADY_IN_LOBBY)
    expect((await c.emitAck('createLobby', { name: 'y' })).error.code).toBe('LOBBY_START_FAILED');
    c.close();
  });

  it('Host verlässt → Host-Übergabe; letzter Spieler → Lobby aufgelöst', async () => {
    const a = await connectRegistered(hub, await registerUser(hub), 'relay');
    const b = await connectRegistered(hub, await registerUser(hub), 'relay');
    const lobby = (await a.emitAck('createLobby', { name: 'h' })).lobby;
    await b.emitAck('joinLobby', { lobbyId: lobby.id });
    await a.emitAck('leaveLobby');
    const updated = await b.waitFor('lobbyUpdated', (l: any) => l.players.length === 1);
    expect(updated.hostId).toBe(b.user.userId);
    await b.emitAck('leaveLobby');
    expect((await a.emitAck('listLobbies')).lobbies.find((l: any) => l.id === lobby.id)).toBeUndefined();
    a.close(); b.close();
  });
});

describe('Beitrittsanfragen (#14)', () => {
  it('Anfrage an gesperrte Lobby wirft keinen TypeError mehr (BUG-JOIN-01) und funktioniert end-to-end', async () => {
    const host = await connectRegistered(hub, await registerUser(hub), 'relay');
    const guest = await connectRegistered(hub, await registerUser(hub), 'relay');
    const lobby = (await host.emitAck('createLobby', { name: 'l' })).lobby;
    await host.emitAck('lockLobby');
    expect((await guest.emitAck('joinLobby', { lobbyId: lobby.id })).error.code).toBe('LOBBY_LOCKED');

    const req = await guest.emitAck('requestJoinLobby', { lobbyId: lobby.id });
    expect(req).toMatchObject({ ok: true, pending: true });
    const received = await host.waitFor('joinRequestReceived');
    expect(received.requesterId).toBe(guest.user.userId);

    expect((await host.emitAck('respondJoinRequest', { requesterId: guest.user.userId, accept: true })).ok).toBe(true);
    const accepted = await guest.waitFor('joinRequestAccepted');
    expect(accepted.lobby.players).toHaveLength(2);
    host.close(); guest.close();
  });

  it('Host lehnt ab / Anfrage unbekannt', async () => {
    const host = await connectRegistered(hub, await registerUser(hub), 'relay');
    const guest = await connectRegistered(hub, await registerUser(hub), 'relay');
    const lobby = (await host.emitAck('createLobby', { name: 'l' })).lobby;
    await host.emitAck('lockLobby');
    await guest.emitAck('requestJoinLobby', { lobbyId: lobby.id });
    await host.waitFor('joinRequestReceived');
    await host.emitAck('respondJoinRequest', { requesterId: guest.user.userId, accept: false });
    expect((await guest.waitFor('joinRequestRejected')).reason).toBe('declined');
    expect((await host.emitAck('respondJoinRequest', { requesterId: guest.user.userId, accept: true })).error.code).toBe('JOIN_REQUEST_NOT_FOUND');
    host.close(); guest.close();
  });
});

describe('Relay (#11)', () => {
  it('sendToLobby erreicht andere, nicht den Sender; sendToPlayer nur in derselben Lobby', async () => {
    const a = await connectRegistered(hub, await registerUser(hub), 'relay');
    const b = await connectRegistered(hub, await registerUser(hub), 'relay');
    const outsider = await connectRegistered(hub, await registerUser(hub), 'relay');
    const lobby = (await a.emitAck('createLobby', { name: 'relay' })).lobby;
    await b.emitAck('joinLobby', { lobbyId: lobby.id });

    expect((await a.emitAck('sendToLobby', { type: 'hi', payload: 1 })).ok).toBe(true);
    expect(await b.waitFor('message')).toMatchObject({ from: a.user.userId, type: 'hi', payload: 1 });
    expect(a.count('message')).toBe(0);

    expect((await a.emitAck('sendToPlayer', { playerId: b.user.userId, type: 'dm', payload: 2 })).ok).toBe(true);
    expect((await a.emitAck('sendToPlayer', { playerId: outsider.user.userId, type: 'dm', payload: 2 })).error.code).toBe('PLAYER_NOT_IN_LOBBY');
    expect((await outsider.emitAck('sendToLobby', { type: 'x', payload: 1 })).error.code).toBe('NOT_IN_LOBBY');
    for (const c of [a, b, outsider]) c.close();
  });

  it('Binary-Relay validiert Typcode und Größe', async () => {
    const a = await connectRegistered(hub, await registerUser(hub), 'relay');
    const b = await connectRegistered(hub, await registerUser(hub), 'relay');
    const lobby = (await a.emitAck('createLobby', { name: 'bin' })).lobby;
    await b.emitAck('joinLobby', { lobbyId: lobby.id });
    expect((await a.emitAck('sendToLobbyBinary', { typeCode: 70000, payload: new Uint8Array(2) })).error.code).toBe('INVALID_BINARY_TYPECODE');
    expect((await a.emitAck('sendToLobbyBinary', { typeCode: 1, payload: new Uint8Array(5000) })).error.code).toBe('BINARY_PAYLOAD_TOO_LARGE');
    expect((await a.emitAck('sendToLobbyBinary', { typeCode: 1, payload: new Uint8Array([1, 2]) })).ok).toBe(true);
    expect((await b.waitFor('messageBinary')).typeCode).toBe(1);
    a.close(); b.close();
  });
});

describe('P1 Lobby-Lebenszyklus & Relay-Härtung', () => {
  it('setLobbyState: nur Host, in_progress sperrt Beitritt, closed ist final', async () => {
    const host = await connectRegistered(hub, await registerUser(hub), 'relay');
    const other = await connectRegistered(hub, await registerUser(hub), 'relay');
    const { lobby } = await host.emitAck('createLobby', { name: 'st' });
    await other.emitAck('joinLobby', { lobbyId: lobby.id });
    expect((await other.emitAck('setLobbyState', { state: 'in_progress' })).ok).toBe(false);
    const res = await host.emitAck('setLobbyState', { state: 'in_progress' });
    expect(res.lobby.status).toBe('in_progress');
    expect((await host.emitAck('setLobbyState', { state: 'in_progress' })).error.code).toBe('INVALID_STATE');
    expect((await host.emitAck('setLobbyState', { state: 'closed' })).lobby.status).toBe('closed');
    host.close(); other.close();
  });

  it('Relay: ungültiger Typ, zu großer Payload, Self-Target, seq', async () => {
    const a = await connectRegistered(hub, await registerUser(hub), 'relay');
    const b = await connectRegistered(hub, await registerUser(hub), 'relay');
    const { lobby } = await a.emitAck('createLobby', { name: 'rl' });
    await b.emitAck('joinLobby', { lobbyId: lobby.id });
    expect((await a.emitAck('sendToLobby', { type: 'bad type!', payload: 1 })).error.code).toBe('INVALID_MESSAGE_TYPE');
    expect((await a.emitAck('sendToLobby', { type: 't', payload: 'x'.repeat(20000) })).error.code).toBe('PAYLOAD_TOO_LARGE');
    expect((await a.emitAck('sendToPlayer', { playerId: a.user.userId, type: 't', payload: 1 })).error.code).toBe('CANNOT_TARGET_SELF');
    const r1 = await a.emitAck('sendToLobby', { type: 't', payload: 1 });
    const r2 = await a.emitAck('sendToLobby', { type: 't', payload: 2 });
    expect(r2.seq).toBe(r1.seq + 1);
    a.close(); b.close();
  });
});
