import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCode, JoinRequestRejectReason, LobbyChangeReason, LobbyStatus } from '../src';
import { startHub, type TestHub } from '../../server/test/helpers/hub';
import { Fleet, PASSWORD, rejectsWith, sleep } from './helpers';

let hub: TestHub;
let fleet: Fleet;
beforeAll(async () => {
  hub = await startHub();
});
afterAll(async () => {
  await hub.stop();
});
afterEach(async () => {
  await fleet?.closeAll();
});

describe('lobbies: create / list / join / leave', () => {
  it('createLobby + lobbyCreated, listLobbies + lobbyList, getLobbyInfo + lobbyInfo, getSessionState', async () => {
    fleet = new Fleet(hub);
    const host = await fleet.player('other');
    const viewer = await fleet.player('other');

    const lobby = await host.client.createLobby({ name: 'Open room', settings: { mode: 'duel' } });
    expect(lobby).toMatchObject({ gameId: 'other', name: 'Open room', hostId: host.userId, status: LobbyStatus.Open, isPrivate: false, locked: false, maxPlayers: 4, settings: { mode: 'duel' } });
    expect(lobby.players.map((p) => p.userId)).toEqual([host.userId]);
    expect((await host.rec.waitFor('lobbyCreated'))[0].id).toBe(lobby.id);

    const listed = await viewer.client.listLobbies();
    expect(listed.map((l) => l.id)).toContain(lobby.id);
    expect((await viewer.rec.waitFor('lobbyList'))[0].map((l: any) => l.id)).toContain(lobby.id);

    expect((await host.client.getLobbyInfo()).id).toBe(lobby.id);
    expect((await host.rec.waitFor('lobbyInfo'))[0].id).toBe(lobby.id);
    const state = await host.client.getSessionState();
    expect(state.lobby?.id).toBe(lobby.id);
    expect(state.state).toMatchObject({ gameId: 'other', lobbyId: lobby.id });
    expect((await viewer.client.getSessionState()).lobby).toBeUndefined();
  });

  it('joinLobby / leaveLobby report lobbyUpdated with PlayerJoined / PlayerLeft; host leaving hands over the host role', async () => {
    fleet = new Fleet(hub);
    const host = await fleet.player('other');
    const guest = await fleet.player('other');
    const lobby = await host.client.createLobby({ name: 'join-leave' });

    const joined = await guest.client.joinLobby(lobby.id);
    expect(joined.players.map((p) => p.userId)).toEqual(expect.arrayContaining([host.userId, guest.userId]));
    const [upd, reason] = await host.rec.waitFor('lobbyUpdated', (_l: any, r: any) => r === LobbyChangeReason.PlayerJoined);
    expect(reason).toBe('player_joined');
    expect(upd.players.map((p: any) => p.userId)).toContain(guest.userId);

    await guest.client.leaveLobby();
    await host.rec.updated(LobbyChangeReason.PlayerLeft, (l) => !l.players.some((p: any) => p.userId === guest.userId));
    expect((await guest.client.getSessionState()).lobby).toBeUndefined();

    await guest.client.joinLobby(lobby.id);
    await host.client.leaveLobby();
    const [handed] = await guest.rec.updated(LobbyChangeReason.HostLeft, (l) => l.hostId === guest.userId);
    expect(handed.players.map((p: any) => p.userId)).not.toContain(host.userId);
  });

  it('private lobbies are hidden from listLobbies and joinable by invite code (case-insensitive)', async () => {
    fleet = new Fleet(hub);
    const host = await fleet.player('other');
    const guest = await fleet.player('other');
    const lobby = await host.client.createLobby({ name: 'secret', isPrivate: true });
    expect(lobby.isPrivate).toBe(true);
    expect(lobby.inviteCode).toMatch(/^[A-Z0-9]{6}$/i);
    expect((await guest.client.listLobbies()).map((l) => l.id)).not.toContain(lobby.id);
    expect((await rejectsWith(guest.client.joinLobby(lobby.id))).code).toBe(ErrorCode.LobbyPrivate);
    const joined = await guest.client.joinLobbyByCode(lobby.inviteCode!.toLowerCase());
    expect(joined.id).toBe(lobby.id);
  });

  it('full, in-progress and closed lobbies via setLobbyState and max players', async () => {
    fleet = new Fleet(hub);
    const host = await fleet.player('relay'); // maxPlayers 2
    const guest = await fleet.player('relay');
    const third = await fleet.player('relay');
    const lobby = await host.client.createLobby({ name: 'state' });
    const full = await guest.client.joinLobby(lobby.id);
    expect(full.status).toBe(LobbyStatus.Full);
    expect((await rejectsWith(third.client.joinLobby(lobby.id))).code).toBe(ErrorCode.LobbyFull);
    expect((await third.client.listLobbies()).map((l) => l.id)).not.toContain(lobby.id);

    await expect(guest.client.setLobbyState('in_progress')).rejects.toMatchObject({ code: ErrorCode.NotHost });
    const started = await host.client.setLobbyState('in_progress');
    expect(started.status).toBe(LobbyStatus.InProgress);
    const [updated] = await guest.rec.updated(LobbyChangeReason.StateChanged, (l) => l.status === LobbyStatus.InProgress);
    expect(updated.id).toBe(lobby.id);
    expect((await rejectsWith(host.client.setLobbyState('in_progress'))).code).toBe(ErrorCode.InvalidState);

    const closed = await host.client.setLobbyState('closed');
    expect(closed.status).toBe(LobbyStatus.Closed);
  });

  it('serverless setLobbyState: a late joiner is refused while in_progress', async () => {
    fleet = new Fleet(hub);
    const host = await fleet.player('other');
    const late = await fleet.player('other');
    const lobby = await host.client.createLobby({ name: 'running' });
    await host.client.setLobbyState('in_progress');
    expect((await rejectsWith(late.client.joinLobby(lobby.id))).code).toBe(ErrorCode.LobbyInProgress);
  });

  it('input and state errors use ErrorCode values', async () => {
    fleet = new Fleet(hub);
    const a = await fleet.player('other');
    expect((await rejectsWith(a.client.getLobbyInfo())).code).toBe(ErrorCode.NotInLobby);
    expect((await rejectsWith(a.client.joinLobby('does-not-exist'))).code).toBe(ErrorCode.LobbyNotFound);
    expect((await rejectsWith(a.client.joinLobbyByCode('!!'))).code).toBe(ErrorCode.InvalidInviteCode);
    expect((await rejectsWith(a.client.joinLobbyByCode('ZZZZZZ'))).code).toBe(ErrorCode.InviteCodeNotFound);
    expect((await rejectsWith(a.client.createLobby({ name: 'big', settings: { blob: 'x'.repeat(20_000) } }))).code).toBe(ErrorCode.SettingsTooLarge);
    await a.client.createLobby({ name: 'one' });
    expect((await rejectsWith(a.client.createLobby({ name: 'two' }))).code).toBe(ErrorCode.AlreadyInLobby);
    expect((await rejectsWith(a.client.registerGame('relay'))).code).toBe(ErrorCode.LeaveLobbyFirst);
    const other = await fleet.player('relay');
    const relayLobby = await other.client.createLobby({ name: 'relay-lobby' });
    expect((await rejectsWith(a.client.joinLobby(relayLobby.id))).code).toBe(ErrorCode.AlreadyInLobby);
  });
});

describe('lobbies: host actions', () => {
  it('kickPlayer, transferHost, host-only guards', async () => {
    fleet = new Fleet(hub);
    const host = await fleet.player('other');
    const b = await fleet.player('other');
    const c = await fleet.player('other');
    const lobby = await host.client.createLobby({ name: 'host-actions' });
    await b.client.joinLobby(lobby.id);
    await c.client.joinLobby(lobby.id);

    expect((await rejectsWith(b.client.kickPlayer(c.userId))).code).toBe(ErrorCode.NotHost);
    expect((await rejectsWith(b.client.transferHost(c.userId))).code).toBe(ErrorCode.NotHost);
    expect((await rejectsWith(b.client.lockLobby())).code).toBe(ErrorCode.NotHost);
    expect((await rejectsWith(host.client.kickPlayer(host.userId))).code).toBe(ErrorCode.CannotKickSelf);
    expect((await rejectsWith(host.client.kickPlayer('nobody'))).code).toBe(ErrorCode.PlayerNotFound);
    expect((await rejectsWith(host.client.transferHost(host.userId))).code).toBe(ErrorCode.AlreadyHost);

    await host.client.kickPlayer(c.userId);
    expect((await c.rec.waitFor('playerKicked'))[0]).toEqual({ lobbyId: lobby.id });
    const [afterKick] = await b.rec.updated(LobbyChangeReason.Kicked);
    expect(afterKick.players.map((p: any) => p.userId)).not.toContain(c.userId);
    expect((await c.client.getSessionState()).lobby).toBeUndefined();

    await host.client.transferHost(b.userId);
    const [transferred] = await b.rec.updated(LobbyChangeReason.HostTransferred, (l) => l.hostId === b.userId);
    expect(transferred.hostId).toBe(b.userId);
    await b.client.kickPlayer(host.userId);
  });

  it('lock/unlock gate joins; join request flow: accept, decline, cancel, by code', async () => {
    fleet = new Fleet(hub);
    const host = await fleet.player('other');
    const a = await fleet.player('other');
    const b = await fleet.player('other');
    const c = await fleet.player('other');
    const lobby = await host.client.createLobby({ name: 'locked', isPrivate: true });

    await host.client.lockLobby();
    const [lockedLobby] = await host.rec.updated(LobbyChangeReason.Locked);
    expect(lockedLobby.locked).toBe(true);
    expect((await rejectsWith(a.client.joinLobbyByCode(lobby.inviteCode!))).code).toBe(ErrorCode.LobbyLocked);

    // accepted
    const pendingA = a.client.requestJoinLobbyByCode(lobby.inviteCode!);
    const [req] = await host.rec.waitFor('joinRequestReceived', (d: any) => d.requesterId === a.userId);
    expect(req).toMatchObject({ lobbyId: lobby.id, requesterId: a.userId, username: a.username });
    expect((await a.rec.waitFor('joinRequestPending'))[0]).toEqual({ lobbyId: lobby.id });
    await host.client.respondJoinRequest(a.userId, true);
    expect((await pendingA).id).toBe(lobby.id);
    expect((await a.rec.waitFor('joinRequestAccepted'))[0].lobby.id).toBe(lobby.id);

    // declined
    const pendingB = rejectsWith(b.client.requestJoinLobbyByCode(lobby.inviteCode!));
    await host.rec.waitFor('joinRequestReceived', (d: any) => d.requesterId === b.userId);
    await host.client.respondJoinRequest(b.userId, false);
    expect((await pendingB).code).toBe(ErrorCode.LobbyLocked);
    expect((await b.rec.waitFor('joinRequestRejected'))[0]).toEqual({ lobbyId: lobby.id, reason: JoinRequestRejectReason.Declined });
    expect((await rejectsWith(host.client.respondJoinRequest(b.userId, true))).code).toBe(ErrorCode.JoinRequestNotFound);

    // cancelled by the requester
    const pendingC = rejectsWith(c.client.requestJoinLobbyByCode(lobby.inviteCode!));
    await host.rec.waitFor('joinRequestReceived', (d: any) => d.requesterId === c.userId);
    await c.client.cancelJoinRequest(lobby.id);
    expect((await pendingC).code).toBe(ErrorCode.JoinRequestNotFound);
    expect((await host.rec.waitFor('joinRequestWithdrawn', (d: any) => d.requesterId === c.userId))[0].reason).toBe('cancelled');
    expect((await rejectsWith(c.client.cancelJoinRequest(lobby.id))).code).toBe(ErrorCode.JoinRequestNotFound);

    // unlock: pending requests end with reason "unlocked", then plain joins work
    const pendingC2 = rejectsWith(c.client.requestJoinLobbyByCode(lobby.inviteCode!));
    await c.rec.waitFor('joinRequestPending', () => c.rec.count('joinRequestPending') >= 2);
    await host.client.unlockLobby();
    await host.rec.updated(LobbyChangeReason.Unlocked);
    expect((await c.rec.waitFor('joinRequestRejected', (d: any) => d.reason === JoinRequestRejectReason.Unlocked))[0].lobbyId).toBe(lobby.id);
    expect((await pendingC2).code).toBe(ErrorCode.LobbyLocked);
    expect((await c.client.joinLobbyByCode(lobby.inviteCode!)).id).toBe(lobby.id);
  });

  it('requestJoinLobby by ID on a locked public lobby waits for the host', async () => {
    fleet = new Fleet(hub);
    const host = await fleet.player('other');
    const guest = await fleet.player('other');
    const lobby = await host.client.createLobby({ name: 'locked-public' });
    await host.client.lockLobby();
    expect((await rejectsWith(guest.client.joinLobby(lobby.id))).code).toBe(ErrorCode.LobbyLocked);
    const pending = guest.client.requestJoinLobby(lobby.id);
    await host.rec.waitFor('joinRequestReceived', (d: any) => d.requesterId === guest.userId);
    await host.client.respondJoinRequest(guest.userId, true);
    expect((await pending).id).toBe(lobby.id);
  });

  it('requestJoinLobby joins immediately when the lobby is not locked', async () => {
    fleet = new Fleet(hub);
    const host = await fleet.player('other');
    const guest = await fleet.player('other');
    const lobby = await host.client.createLobby({ name: 'unlocked' });
    expect((await guest.client.requestJoinLobby(lobby.id)).id).toBe(lobby.id);
    expect((await rejectsWith(guest.client.requestJoinLobby('nope'))).code).toBe(ErrorCode.LobbyNotFound);
  });
});

describe('session: resume after disconnect', () => {
  it('a dropped member keeps the seat during the grace period; login resumes with session:resumed', async () => {
    fleet = new Fleet(hub);
    const host = await fleet.player('other');
    const guest = await fleet.player('other');
    const lobby = await host.client.createLobby({ name: 'resume' });
    await guest.client.joinLobby(lobby.id);

    guest.client.disconnect();
    const [dropped] = await host.rec.updated(LobbyChangeReason.PlayerDisconnected);
    expect(dropped.players.find((p: any) => p.userId === guest.userId)).toMatchObject({ connected: false });

    await guest.client.login(guest.username, PASSWORD);
    const [resumed] = await guest.rec.waitFor('session:resumed');
    expect(resumed.lobby.id).toBe(lobby.id);
    expect(resumed.state).toMatchObject({ userId: guest.userId, gameId: 'other', lobbyId: lobby.id });
    const [back] = await host.rec.updated(LobbyChangeReason.PlayerReconnected);
    expect(back.players.find((p: any) => p.userId === guest.userId)?.connected).not.toBe(false);
    expect((await guest.client.getSessionState()).lobby?.id).toBe(lobby.id);
    expect((await guest.rec.waitFor('hello', (h: any) => h.lobbyId === lobby.id))[0].gameId).toBe('other');
  });

  it('the seat is released once the grace period has passed', async () => {
    fleet = new Fleet(hub);
    const host = await fleet.player('other');
    const guest = await fleet.player('other');
    const lobby = await host.client.createLobby({ name: 'timeout' });
    await guest.client.joinLobby(lobby.id);
    guest.client.disconnect();
    await sleep(100);
    await host.rec.updated(LobbyChangeReason.PlayerLeft, (l) => !l.players.some((p: any) => p.userId === guest.userId), 6000);
    await guest.client.login(guest.username, PASSWORD);
    expect((await guest.client.getSessionState()).lobby).toBeUndefined();
  });
});
