import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCode, EthernalError, GameServerClient, LobbyAssignReason, LobbyChangeReason } from '../src';
import type { GameServerClientOptions, LobbyAssignment } from '../src';
import { issueServerKey, startHub, type TestHub } from '../../server/test/helpers/hub';
import { Fleet, PASSWORD, befriend, rejectsWith, sleep, uname } from './helpers';

const GAME = 'gs-req';
let hub: TestHub;
let fleet: Fleet;
const servers: SampleServer[] = [];

beforeAll(async () => {
  hub = await startHub();
});
afterAll(async () => {
  await hub.stop();
});
afterEach(async () => {
  // players leave first so their lobbies close and are not rebound into the next test
  await fleet?.leaveAll();
  await fleet?.closeAll();
  for (const s of servers.splice(0)) s.gs.disconnect();
  await sleep(50);
});

/** A tiny authoritative game server: counts "tap" actions per lobby and answers with state + relay messages. */
class SampleServer {
  readonly gs: GameServerClient;
  readonly assignments: LobbyAssignment[] = [];
  readonly counters = new Map<string, number>();
  readonly joined: string[] = [];
  readonly left: Array<{ userId: string; reason: string }> = [];

  constructor(opts: Omit<GameServerClientOptions, 'serverUrl' | 'serverKey' | 'gameId' | 'serverId' | 'capacity'> & { key: string; serverId?: string; capacity?: number; gameId?: string }) {
    const { key, serverId, capacity, gameId, ...rest } = opts;
    this.gs = new GameServerClient({ serverUrl: hub.url, serverKey: key, gameId: gameId ?? GAME, serverId: serverId ?? uname('srv'), capacity: capacity ?? 5, ...rest });
    this.gs.on('lobby:assigned', (a, accepted) => {
      if (accepted) {
        this.assignments.push(a);
        this.counters.set(a.lobby.id, this.counters.get(a.lobby.id) ?? 0);
      }
    });
    this.gs.on('player:joined', (d) => this.joined.push(d.userId));
    this.gs.on('player:left', (d) => this.left.push({ userId: d.userId, reason: d.reason }));
    this.gs.on('player:action', async (d) => {
      if (d.type !== 'tap') return;
      const n = (this.counters.get(d.lobbyId) ?? 0) + 1;
      this.counters.set(d.lobbyId, n);
      await this.gs.sendState(d.lobbyId, { taps: n });
      await this.gs.sendToLobby(d.lobbyId, 'tapped', { by: d.userId, n });
    });
  }

  get serverId(): string {
    return (this.gs as any).opts.serverId;
  }
}

async function sample(opts: { region?: string; capacity?: number; serverId?: string; onAssign?: GameServerClientOptions['onAssign'] } = {}): Promise<SampleServer> {
  const { key } = await issueServerKey(hub, GAME);
  const s = new SampleServer({ key, ...opts });
  servers.push(s);
  await s.gs.connect();
  return s;
}

const withServer = { serverPreference: { mode: 'any' as const } };

describe('GameServerClient', () => {
  it('connect resolves with hello; heartbeat/updateStatus report the server; bad keys and games are typed errors', async () => {
    const s = await sample({ region: 'eu', capacity: 3 });
    expect(s.gs.isConnected()).toBe(true);
    expect(await s.gs.heartbeat()).toMatchObject({ serverId: s.serverId, gameId: GAME, region: 'eu', capacity: 3, load: 0, draining: false, connected: true });
    expect((await s.gs.updateStatus({ capacity: 7 })).capacity).toBe(7);

    const bad = new GameServerClient({ serverUrl: hub.url, serverKey: 'esk_' + 'x'.repeat(48), gameId: GAME, serverId: uname('bad'), capacity: 1 });
    const err = await rejectsWith(bad.connect());
    expect(err).toBeInstanceOf(EthernalError);
    expect(err.code).toBe(ErrorCode.InvalidServerKey);
    const noSupport = new GameServerClient({ serverUrl: hub.url, serverKey: 'esk_' + 'y'.repeat(48), gameId: 'relay', serverId: uname('bad'), capacity: 1 });
    expect((await rejectsWith(noSupport.connect())).code).toBe(ErrorCode.GameServerNotAllowed);
    await rejectsWith(s.gs.sendToLobby('not-mine', 'x', 1)).then((e) => expect(e.code).toBe(ErrorCode.NotLobbyServer));
    const idle = new GameServerClient({ serverUrl: hub.url, serverKey: 'k', gameId: GAME, serverId: 'x', capacity: 1 });
    expect((await rejectsWith(idle.heartbeat())).code).toBe('NOT_CONNECTED');
  });

  it('serves two lobbies at once: assignments, player events, actions, state, relay, settings, game over', async () => {
    const s = await sample();
    fleet = new Fleet(hub);
    const a = await fleet.player(GAME);
    const b = await fleet.player(GAME);
    const c = await fleet.player(GAME);
    const lobbyA = await a.client.createLobby({ name: 'A', ...withServer });
    const lobbyB = await b.client.createLobby({ name: 'B', ...withServer });
    expect(lobbyA.server?.serverId).toBe(s.serverId);
    expect(lobbyB.server?.serverId).toBe(s.serverId);
    expect(s.assignments.map((x) => x.lobby.id).sort()).toEqual([lobbyA.id, lobbyB.id].sort());
    expect(s.assignments[0]).toMatchObject({ reason: LobbyAssignReason.NewLobby, lobby: { status: 'open' } });
    expect(s.assignments[0].previousServerId).toBeUndefined();
    expect(s.assignments.find((x) => x.lobby.id === lobbyA.id)?.players).toEqual([{ userId: a.userId, username: a.username }]);
    expect([...s.gs.lobbies.keys()].sort()).toEqual([lobbyA.id, lobbyB.id].sort());
    expect((await s.gs.heartbeat()).load).toBe(2);

    await c.client.joinLobby(lobbyA.id);
    await sleep(100);
    expect(s.joined).toEqual([c.userId]);

    await a.client.sendGameAction('tap', {});
    await c.client.sendGameAction('tap', {});
    await b.client.sendGameAction('tap', {});
    await a.rec.waitFor('gameState', (st: any) => st.taps === 2);
    await b.rec.waitFor('gameState', (st: any) => st.taps === 1);
    const [msg] = await c.rec.waitFor('message', (m: any) => m.type === 'tapped' && m.payload.n === 2);
    expect(msg).toMatchObject({ from: 'server', payload: { by: c.userId } });
    expect(b.rec.count('message', (m: any) => m.payload?.by === a.userId)).toBe(0);

    // targeted state / relay
    await s.gs.sendState(lobbyA.id, { secret: 1 }, c.userId);
    await c.rec.waitFor('gameState', (st: any) => st.secret === 1);
    expect(a.rec.count('gameState', (st: any) => st.secret === 1)).toBe(0);
    await s.gs.sendToPlayer(lobbyA.id, a.userId, 'whisper', 'hi');
    await a.rec.waitFor('message', (m: any) => m.type === 'whisper');
    expect(c.rec.count('message', (m: any) => m.type === 'whisper')).toBe(0);
    expect((await rejectsWith(s.gs.sendToPlayer(lobbyA.id, b.userId, 'x'))).code).toBe(ErrorCode.PlayerNotInLobby);

    // lobby control
    const started = await s.gs.setLobbyState(lobbyA.id, 'in_progress');
    expect(started.status).toBe('in_progress');
    await s.gs.setLobbySettings(lobbyA.id, { map: 'moon' });
    const [upd] = await c.rec.waitFor('lobbyUpdated', (l: any, r: any) => r === LobbyChangeReason.SettingsChanged && l.settings?.map === 'moon');
    expect(upd.settings).toEqual({ map: 'moon' });
    await s.gs.gameOver(lobbyA.id, { winner: a.userId });
    await a.rec.waitFor('gameOver', (r: any) => r.winner === a.userId);
    await s.gs.closeLobby(lobbyB.id);
    await b.rec.waitFor('lobbyUpdated', (l: any) => l.status === 'closed');
    await sleep(100);
    expect((await s.gs.heartbeat()).load).toBe(0);
    expect(s.gs.lobbies.size).toBe(0);
  });

  it('forwards hello, lobby:updated, lobby:closed and player:disconnected/reconnected; off() detaches listeners', async () => {
    const s = await sample();
    const seen: string[] = [];
    const listener = (d: { userId: string }) => seen.push(`disc:${d.userId}`);
    s.gs.on('player:disconnected', listener);
    s.gs.on('player:reconnected', (d) => seen.push(`re:${d.userId}`));
    s.gs.on('lobby:updated', (d) => seen.push(`upd:${d.reason}`));
    s.gs.on('lobby:closed', (d) => seen.push(`closed:${d.reason}`));
    const hello = await new Promise<any>((resolve) => {
      s.gs.once('hello', resolve);
      void s.gs.connect();
    });
    expect(hello).toMatchObject({ serverId: s.serverId, gameId: GAME });

    fleet = new Fleet(hub);
    const p = await fleet.player(GAME);
    const q = await fleet.player(GAME);
    const lobby = await p.client.createLobby({ name: 'E', ...withServer });
    await q.client.joinLobby(lobby.id);
    await q.client.setSocialSettings({ status: 'online' });
    q.client.disconnect();
    await sleep(100);
    expect(seen).toContain(`disc:${q.userId}`);
    await q.client.login(q.username, PASSWORD);
    await sleep(200);
    expect(seen).toContain(`re:${q.userId}`);
    expect(seen).toContain('upd:player_joined');

    s.gs.off('player:disconnected', listener);
    const before = seen.length;
    q.client.disconnect();
    await sleep(100);
    expect(seen.length).toBe(before);
    await q.client.login(q.username, PASSWORD);
    await p.client.leaveLobby();
    await q.client.leaveLobby();
    await sleep(200);
    expect(seen.some((x) => x.startsWith('closed:'))).toBe(true);
  });

  it('data writes: authorized for members, NOT_ALLOWED for non-members; atomic ops; leaderboards', async () => {
    const s = await sample();
    fleet = new Fleet(hub);
    const a = await fleet.player(GAME);
    const b = await fleet.player(GAME);
    const outsider = await fleet.player(GAME);
    const lobbyA = await a.client.createLobby({ name: 'A', ...withServer });
    const lobbyB = await b.client.createLobby({ name: 'B', ...withServer });
    const { gs } = s;

    await gs.setUserData(lobbyA.id, a.userId, 'rank', { tier: 'gold' }, { visibility: 'lobby' });
    await gs.bulkSetUserData(lobbyA.id, a.userId, [{ key: 'xp', value: 10 }, { key: 'title', value: 'Ace', visibility: 'friends', writeScope: 'server' }]);
    const entries = await gs.getUserData(lobbyA.id, a.userId);
    expect(entries.find((e) => e.key === 'title')).toMatchObject({ value: 'Ace', visibility: 'friends', writeScope: 'server' });
    expect(entries.find((e) => e.key === 'xp')).toMatchObject({ value: 10, visibility: 'private' });
    // server-scoped keys are read-only for the player
    expect((await rejectsWith(a.client.setUserData(GAME, 'title', 'Hacked'))).code).toBe(ErrorCode.DataReadOnly);

    // non-members / wrong lobby
    expect((await rejectsWith(gs.setUserData(lobbyA.id, b.userId, 'xp', 1))).code).toBe(ErrorCode.NotAllowed);
    expect((await rejectsWith(gs.getUserData(lobbyA.id, outsider.userId))).code).toBe(ErrorCode.NotAllowed);
    expect((await rejectsWith(gs.incrementUserData(lobbyB.id, a.userId, 'wins', 1))).code).toBe(ErrorCode.NotAllowed);

    // atomic ops
    expect(await gs.incrementUserData(lobbyA.id, a.userId, 'wins', 2, { visibility: 'public' })).toMatchObject({ key: 'wins', value: 2, version: 1 });
    expect(await gs.incrementUserData(lobbyB.id, b.userId, 'wins', 5, { visibility: 'public' })).toMatchObject({ value: 5 });
    const conflict = await rejectsWith(gs.setUserDataIf(lobbyA.id, a.userId, 'wins', 9, 7));
    expect(conflict.code).toBe(ErrorCode.VersionConflict);
    expect((conflict as EthernalError).data).toEqual({ current: { value: 2, version: 1 } });
    expect(await gs.setUserDataIf(lobbyA.id, a.userId, 'wins', 3, 1)).toMatchObject({ value: 3, version: 2 });
    expect(await gs.transactUserData(lobbyA.id, a.userId, [{ op: 'increment', key: 'wins', by: 1 }, { op: 'delete', key: 'xp' }])).toMatchObject([{ key: 'wins', value: 4, version: 3 }, { key: 'xp', version: 0 }]);

    // clients cannot touch the public key, but the owner reads it
    expect((await rejectsWith(a.client.setUserData(GAME, 'wins', 99))).code).toBe(ErrorCode.DataReadOnly);
    expect((await a.client.getUserData(GAME)).find((e) => e.key === 'wins')).toMatchObject({ value: 4, visibility: 'public' });

    // leaderboard: rank, pagination, me/around, friends scope, leaderboardVisible
    await gs.incrementUserData(lobbyA.id, a.userId, 'streak', 1, { visibility: 'public' });
    expect(await a.client.getLeaderboard(GAME, 'wins')).toMatchObject([{ rank: 1, userId: b.userId, value: 5 }, { rank: 2, userId: a.userId, value: 4 }]);
    expect(await a.client.getLeaderboard(GAME, 'wins', { order: 'asc', limit: 1 })).toMatchObject([{ rank: 1, userId: a.userId }]);
    expect(await a.client.getLeaderboard(GAME, 'wins', { offset: 1 })).toMatchObject([{ rank: 2, userId: a.userId }]);
    const withMe = await a.client.getLeaderboard(GAME, 'wins', { me: true, limit: 1 });
    expect(withMe).toMatchObject({ total: 2, me: { rank: 2, userId: a.userId }, entries: [{ rank: 1 }] });
    const around = await a.client.getLeaderboard(GAME, 'wins', { around: 'me', range: 1 });
    expect(around.entries.map((e) => e.rank)).toEqual([1, 2]);
    expect(await a.client.getLeaderboard(GAME, 'wins', { scope: 'friends' })).toMatchObject([{ rank: 1, userId: a.userId }]);
    await befriend(a, b);
    expect((await a.client.getLeaderboard(GAME, 'wins', { scope: 'friends' })).map((e) => e.userId)).toEqual([b.userId, a.userId]);

    expect((await b.client.setSocialSettings({ leaderboardVisible: false })).leaderboardVisible).toBe(false);
    expect((await a.client.getLeaderboard(GAME, 'wins')).map((e) => e.userId)).toEqual([a.userId]);
    expect((await b.client.getLeaderboard(GAME, 'wins', { me: true })).me).toMatchObject({ userId: b.userId, rank: 1 });
    expect((await rejectsWith(a.client.getLeaderboard(GAME, 'wins', { limit: 0 }))).code).toBe(ErrorCode.InvalidInput);
  });

  it('kick with reason; a rejecting server makes createLobby fail; drain stops new lobbies', async () => {
    const s = await sample();
    fleet = new Fleet(hub);
    const host = await fleet.player(GAME);
    const guest = await fleet.player(GAME);
    const lobby = await host.client.createLobby({ name: 'K', ...withServer });
    await guest.client.joinLobby(lobby.id);
    await s.gs.kickPlayer(lobby.id, guest.userId, 'cheating');
    expect((await guest.rec.waitFor('playerKicked'))[0]).toEqual({ lobbyId: lobby.id, reason: 'cheating' });
    expect((await rejectsWith(guest.client.joinLobby(lobby.id))).code).toBe(ErrorCode.KickedFromLobby);
    await sleep(50);
    expect(s.left).toContainEqual({ userId: guest.userId, reason: 'kicked' });
    expect((await rejectsWith(s.gs.kickPlayer(lobby.id, guest.userId))).code).toBe(ErrorCode.PlayerNotFound);

    const info = await s.gs.drain();
    expect(info.draining).toBe(true);
    await host.rec.updated(LobbyChangeReason.ServerDraining, (l) => l.serverStatus === 'draining');
    const other = await fleet.player(GAME);
    expect((await rejectsWith(other.client.createLobby({ name: 'N', ...withServer }))).code).toBe(ErrorCode.NoGameServerAvailable);
    expect((await s.gs.undrain()).draining).toBe(false);
    await host.rec.updated(LobbyChangeReason.ServerDraining, (l) => l.serverStatus === 'ok');
    await other.client.createLobby({ name: 'N', ...withServer });
  });

  it('onAssign can reject (reason is passed on) or throw', async () => {
    let calls = 0;
    await sample({ onAssign: async () => (++calls === 1 ? { accept: false, reason: 'busy' } : true) });
    fleet = new Fleet(hub);
    const p = await fleet.player(GAME);
    expect((await rejectsWith(p.client.createLobby({ name: 'x', ...withServer }))).code).toBe(ErrorCode.LobbyStartFailed);
    expect((await p.client.createLobby({ name: 'y', ...withServer })).server).toBeTruthy();
    expect(calls).toBe(2);
  });

  it('resume: reconnecting with the same serverId within the grace keeps the lobbies', async () => {
    const s = await sample();
    fleet = new Fleet(hub);
    const p = await fleet.player(GAME);
    const lobby = await p.client.createLobby({ name: 'R', ...withServer });
    const lost = p.rec.updated(LobbyChangeReason.ServerLost, (l) => l.serverStatus === 'lost');
    s.gs.disconnect();
    await lost;
    expect((await rejectsWith(p.client.sendGameAction('tap', {}))).code).toBe(ErrorCode.ServerUnavailable);
    const hello = await s.gs.connect();
    expect(hello.resumed).toBe(true);
    expect(hello.lobbies.map((l) => l.id)).toEqual([lobby.id]);
    expect(s.gs.lobbies.has(lobby.id)).toBe(true);
    await p.rec.updated(LobbyChangeReason.ServerResumed, (l) => l.serverStatus === 'ok');
    await p.client.sendGameAction('tap', {});
    await p.rec.waitFor('gameState', (st: any) => st.taps === 1);
  });

  it('rebind: when server A is lost, server B of the same game receives lobby:assigned with reason server_rebound', async () => {
    const a = await sample();
    fleet = new Fleet(hub);
    const p = await fleet.player(GAME);
    const q = await fleet.player(GAME);
    const lobby = await p.client.createLobby({ name: 'Rebind', ...withServer });
    await q.client.joinLobby(lobby.id);
    expect(a.assignments).toHaveLength(1);

    const b = await sample();
    const lostAtLeast = Date.now();
    a.gs.disconnect();
    await p.rec.updated(LobbyChangeReason.ServerLost);
    await sleep(0);
    const rebound = await new Promise<LobbyAssignment>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no rebind')), 8000);
      b.gs.on('lobby:assigned', (assignment) => {
        clearTimeout(t);
        resolve(assignment);
      });
    });
    expect(rebound).toMatchObject({ reason: LobbyAssignReason.ServerRebound, previousServerId: a.serverId, lobby: { id: lobby.id } });
    expect(rebound.lostAt).toBeGreaterThanOrEqual(lostAtLeast - 50);
    expect(rebound.players.map((x) => x.userId).sort()).toEqual([p.userId, q.userId].sort());
    const [upd] = await p.rec.updated(LobbyChangeReason.ServerRebound, (l) => l.server?.serverId === b.serverId);
    expect(upd.server.serverId).toBe(b.serverId);
    expect(b.gs.lobbies.has(lobby.id)).toBe(true);

    // B now runs the lobby
    await q.client.sendGameAction('tap', {});
    await p.rec.waitFor('gameState', (st: any) => st.taps === 1);
    expect(a.counters.size).toBe(1);
    expect(b.counters.get(lobby.id)).toBe(1);
    // no gameCrashed for a successful rebind
    expect(p.rec.count('gameCrashed')).toBe(0);
  });
});
