import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCode, LobbyChangeReason, LobbyServerStatus, LobbyStatus, ServerSupport } from '../src';
import {
  connectGameServer,
  issueServerKey,
  startHub,
  type GsClient,
  type TestHub,
} from '../../server/test/helpers/hub';
import { Fleet, rejectsWith, sleep, uname } from './helpers';

let hub: TestHub;
let fleet: Fleet;
const servers: GsClient[] = [];
beforeAll(async () => {
  hub = await startHub();
});
afterAll(async () => {
  await hub.stop();
});
afterEach(async () => {
  await fleet?.closeAll();
  servers.splice(0).forEach((s) => s.close());
});

async function gameServer(gameId: string, region?: string): Promise<GsClient> {
  const { key } = await issueServerKey(hub, gameId);
  const s = await connectGameServer(hub, { serverKey: key, gameId, serverId: uname('srv'), region, capacity: 5 });
  servers.push(s);
  return s;
}

describe('game subprocess (fake game)', () => {
  it('gameStarting on READY; sendGameAction reaches the subprocess and its gameEvent comes back', async () => {
    fleet = new Fleet(hub);
    const host = await fleet.player('fake');
    const lobby = await host.client.createLobby({ name: 'sub' });
    expect((await host.rec.waitFor('gameStarting'))[0]).toEqual({ lobbyId: lobby.id, gameId: 'fake' });
    await host.client.sendGameAction('ping', { n: 1 });
    const [ev] = await host.rec.waitFor('gameEvent', (e: any) => e.type === 'ipc' && e.data?.payload?.action === 'ping');
    expect(ev.data).toMatchObject({ type: 'PLAYER_ACTION', payload: { userId: host.userId, action: 'ping', data: { n: 1 } } });
  });

  it('relay-only games have no game logic: GAME_NOT_RUNNING; outside a lobby: NOT_IN_LOBBY', async () => {
    fleet = new Fleet(hub);
    const host = await fleet.player('relay');
    expect((await rejectsWith(host.client.sendGameAction('x', 1))).code).toBe(ErrorCode.NotInLobby);
    await host.client.createLobby({ name: 'r' });
    expect((await rejectsWith(host.client.sendGameAction('x', 1))).code).toBe(ErrorCode.GameNotRunning);
  });
});

describe('game servers: serverPreference and server events', () => {
  it('registerGame reports serverSupport; mode none skips an available server; any binds one in the requested region', async () => {
    fleet = new Fleet(hub);
    const host = await fleet.player();
    const reg = await host.client.registerGame('gs-opt');
    expect(reg.game).toMatchObject({ id: 'gs-opt', serverSupport: ServerSupport.Optional, regions: ['eu', 'us'] });
    expect(reg.state.gameId).toBe('gs-opt');
    await gameServer('gs-opt', 'eu');

    const free = await host.client.createLobby({ name: 'free', serverPreference: { mode: 'none' } });
    expect(free.server).toBeUndefined();
    await host.client.leaveLobby();

    const bound = await host.client.createLobby({ name: 'bound', serverPreference: { mode: 'any', region: 'eu' } });
    expect(bound.server).toMatchObject({ serverId: expect.any(String), region: 'eu' });
    const other = await fleet.player('gs-opt');
    const listed = (await other.client.listLobbies()).find((l) => l.id === bound.id);
    expect(listed).toMatchObject({ serverBound: true, region: 'eu' });
  });

  it('required games without a server fail with NO_GAME_SERVER_AVAILABLE', async () => {
    fleet = new Fleet(hub);
    const host = await fleet.player('gs-req');
    expect((await rejectsWith(host.client.createLobby({ name: 'nope' }))).code).toBe(ErrorCode.NoGameServerAvailable);
  });

  it('gameState, gameOver and playerKicked pushed by the game server', async () => {
    fleet = new Fleet(hub);
    const s = await gameServer('gs-opt');
    const host = await fleet.player('gs-opt');
    const guest = await fleet.player('gs-opt');
    const lobby = await host.client.createLobby({ name: 'gs-events', serverPreference: { mode: 'any' } });
    await guest.client.joinLobby(lobby.id);

    expect((await s.emitAck('lobby:state', { lobbyId: lobby.id, state: { round: 1 } })).ok).toBe(true);
    expect((await guest.rec.waitFor('gameState'))[0]).toEqual({ round: 1 });

    expect((await s.emitAck('lobby:kick', { lobbyId: lobby.id, userId: guest.userId })).ok).toBe(true);
    expect((await guest.rec.waitFor('playerKicked'))[0]).toEqual({ lobbyId: lobby.id });

    expect((await s.emitAck('lobby:gameOver', { lobbyId: lobby.id, result: { winner: host.userId } })).ok).toBe(true);
    expect((await host.rec.waitFor('gameOver'))[0]).toEqual({ winner: host.userId });
    const [closed] = await host.rec.updated(LobbyChangeReason.StateChanged, (l) => l.status === LobbyStatus.Closed);
    expect(closed.id).toBe(lobby.id);
  });

  it('server loss and rebind: lobbyUpdated carries ServerLost then ServerRebound', async () => {
    fleet = new Fleet(hub);
    const a = await gameServer('gs-req');
    const host = await fleet.player('gs-req');
    const lobby = await host.client.createLobby({ name: 'rebind' });
    expect(lobby.server).toBeTruthy();
    await gameServer('gs-req');
    a.close();
    const [lost] = await host.rec.updated(LobbyChangeReason.ServerLost);
    expect(lost.serverStatus).toBe(LobbyServerStatus.Lost);
    const [rebound] = await host.rec.updated(LobbyChangeReason.ServerRebound);
    expect(rebound.id).toBe(lobby.id);
    expect(rebound.serverStatus ?? LobbyServerStatus.Ok).toBe(LobbyServerStatus.Ok);
    expect((await host.client.getSessionState()).lobby?.status).not.toBe(LobbyStatus.Closed);
  });

  it('server draining, resume, and a lobby crash when a required server never comes back', async () => {
    fleet = new Fleet(hub);
    const s = await gameServer('gs-req');
    const host = await fleet.player('gs-req');
    const lobby = await host.client.createLobby({ name: 'drain' });
    await s.emitAck('server:status', { draining: true });
    expect((await host.rec.updated(LobbyChangeReason.ServerDraining))[0].serverStatus).toBe(LobbyServerStatus.Draining);
    await s.emitAck('server:status', { draining: false });
    s.close();
    await host.rec.updated(LobbyChangeReason.ServerLost);
    const crashed = await host.rec.waitFor('gameCrashed', () => true, 10_000);
    expect(crashed[0]).toEqual({ lobbyId: lobby.id, code: null });
    await sleep(50);
  });

  it('server resume: the same serverId reconnecting yields ServerResumed', async () => {
    fleet = new Fleet(hub);
    const { key } = await issueServerKey(hub, 'gs-req');
    const serverId = uname('resume');
    const s = await connectGameServer(hub, { serverKey: key, gameId: 'gs-req', serverId });
    const host = await fleet.player('gs-req');
    await host.client.createLobby({ name: 'resume' });
    s.close();
    await host.rec.updated(LobbyChangeReason.ServerLost);
    const s2 = await connectGameServer(hub, { serverKey: key, gameId: 'gs-req', serverId });
    servers.push(s2);
    const [back] = await host.rec.updated(LobbyChangeReason.ServerResumed);
    expect(back.serverStatus).toBe(LobbyServerStatus.Ok);
  });
});
