import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectClient, connectRegistered, registerUser, sleep, startHub, type TestHub } from './helpers/hub';

let hub: TestHub;
beforeAll(async () => { hub = await startHub(); });
afterAll(async () => { await hub.stop(); });

const ipc = (c: { events: Array<{ event: string; args: any[] }> }, type: string): number =>
  c.events.filter((e) => e.event === 'gameEvent' && e.args[0].type === 'ipc' && e.args[0].data.type === type).length;

describe('Reconnect (#18)', () => {
  it('Disconnect hält den Platz; Reconnect in der Gnadenfrist stellt die Lobby wieder her', async () => {
    const host = await connectRegistered(hub, await registerUser(hub), 'relay');
    const guest = await connectRegistered(hub, await registerUser(hub), 'relay');
    const lobby = (await host.emitAck('createLobby', { name: 'r' })).lobby;
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });

    const user = guest.user;
    guest.close();
    const dropped = await host.waitFor('lobbyUpdated', (l: any) => l.players.some((p: any) => p.connected === false));
    expect(dropped.players).toHaveLength(2);

    const back = await connectClient(hub, user);
    const hello = await back.waitFor('hello');
    expect(hello.lobbyId).toBe(lobby.id);
    expect(hello.gameId).toBe('relay');
    const resumed = await back.waitFor('session:resumed');
    expect(resumed.lobby.id).toBe(lobby.id);
    await host.waitFor('lobbyUpdated', (l: any) => l.players.every((p: any) => p.connected !== false) && l.players.length === 2);

    // Relay funktioniert wieder ohne erneutes registerGame/joinLobby
    await host.emitAck('sendToLobby', { type: 'ping', payload: 1 });
    expect((await back.waitFor('message')).type).toBe('ping');
    host.close(); back.close();
  });

  it('Gnadenfrist läuft ab → Spieler wird entfernt, Host-Übergabe, Lobby bleibt für Verbleibende', async () => {
    const host = await connectRegistered(hub, await registerUser(hub), 'relay');
    const guest = await connectRegistered(hub, await registerUser(hub), 'relay');
    const lobby = (await host.emitAck('createLobby', { name: 'r' })).lobby;
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });
    host.close();
    const after = await guest.waitFor('lobbyUpdated', (l: any) => l.players.length === 1, 6000);
    expect(after.hostId).toBe(guest.user.userId);
    guest.close();
  });

  it('Grace 0 entfernt sofort', async () => {
    const host = await connectRegistered(hub, await registerUser(hub), 'relay-nograce');
    const guest = await connectRegistered(hub, await registerUser(hub), 'relay-nograce');
    const lobby = (await host.emitAck('createLobby', { name: 'r' })).lobby;
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });
    guest.close();
    const after = await host.waitFor('lobbyUpdated', (l: any) => l.players.length === 1, 3000);
    expect(after.players[0].userId).toBe(host.user.userId);
    host.close();
  });

  it('Takeover: neue Session ersetzt die alte, Lobby bleibt bestehen', async () => {
    const u = await registerUser(hub);
    const host = await connectRegistered(hub, u, 'relay');
    const lobby = (await host.emitAck('createLobby', { name: 't' })).lobby;
    const second = await connectClient(hub, u);
    await host.waitFor('session:replaced');
    const resumed = await second.waitFor('session:resumed');
    expect(resumed.lobby.id).toBe(lobby.id);
    expect((await second.emitAck('getLobbyInfo')).lobby.players[0].connected).not.toBe(false);
    await sleep(300);
    expect((await second.emitAck('getLobbyInfo')).ok).toBe(true);
    second.close();
  });

  it('Subprocess erhält PLAYER_DISCONNECT, PLAYER_RECONNECT und bei Ablauf PLAYER_LEAVE', async () => {
    const host = await connectRegistered(hub, await registerUser(hub), 'fake');
    const guest = await connectRegistered(hub, await registerUser(hub), 'fake');
    const lobby = (await host.emitAck('createLobby', { name: 'p' })).lobby;
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });
    await host.waitFor('gameEvent', (e: any) => e.type === 'ipc' && e.data.type === 'PLAYER_JOIN');

    const g = guest.user;
    guest.close();
    await host.waitFor('gameEvent', (e: any) => e.type === 'ipc' && e.data.type === 'PLAYER_DISCONNECT');
    const back = await connectClient(hub, g);
    await host.waitFor('gameEvent', (e: any) => e.type === 'ipc' && e.data.type === 'PLAYER_RECONNECT');
    expect(ipc(host, 'PLAYER_LEAVE')).toBe(0);

    back.close();
    await host.waitFor('gameEvent', (e: any) => e.type === 'ipc' && e.data.type === 'PLAYER_LEAVE', 6000);
    host.close();
  });

  it('Explizites Verlassen sendet sofort PLAYER_LEAVE; letzter Spieler beendet den Subprocess', async () => {
    const host = await connectRegistered(hub, await registerUser(hub), 'fake');
    const guest = await connectRegistered(hub, await registerUser(hub), 'fake');
    const lobby = (await host.emitAck('createLobby', { name: 'p' })).lobby;
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });
    await guest.emitAck('leaveLobby');
    await host.waitFor('gameEvent', (e: any) => e.type === 'ipc' && e.data.type === 'PLAYER_LEAVE');
    await host.emitAck('leaveLobby');
    host.close(); guest.close();
  });
});
