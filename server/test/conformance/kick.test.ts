import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { befriend, closeAll, live, sleep, startHub, type TestHub } from './util';
import { FAST_SOCIAL } from './util';

let hub: TestHub;
beforeAll(async () => { hub = await startHub({ env: FAST_SOCIAL, limits: { joinRequestTimeoutMs: 3000 } }); });
afterAll(async () => { await hub.stop(); });

async function kicked(opts: { isPrivate?: boolean } = {}) {
  const [host, guest, other] = [await live(hub, 'other'), await live(hub, 'other'), await live(hub, 'other')];
  const lobby = (await host.emitAck('createLobby', { name: 'k', ...opts })).lobby;
  await guest.emitAck(opts.isPrivate ? 'joinLobbyByCode' : 'joinLobby', opts.isPrivate ? { code: lobby.inviteCode } : { lobbyId: lobby.id });
  expect((await host.emitAck('kickPlayer', { playerId: guest.user.userId, reason: 'afk' })).ok).toBe(true);
  return { host, guest, other, lobby };
}

describe('Soft kick', () => {
  it('TEST-KICK-01: kicked player gets playerKicked with the optional reason and KICKED_FROM_LOBBY on joinLobby; others are unaffected', async () => {
    const { host, guest, other, lobby } = await kicked();
    const ev = await guest.waitFor('playerKicked');
    expect(ev).toEqual({ lobbyId: lobby.id, reason: 'afk' });
    expect((await guest.emitAck('joinLobby', { lobbyId: lobby.id })).error.code).toBe('KICKED_FROM_LOBBY');
    expect((await other.emitAck('joinLobby', { lobbyId: lobby.id })).ok).toBe(true);
    closeAll(host, guest, other);
  });

  it('TEST-KICK-02: KICKED_FROM_LOBBY also applies to join by code, requestJoinLobby and joinFriend; the host is not notified of such requests', async () => {
    const { host, guest, lobby } = await kicked({ isPrivate: true });
    expect((await guest.emitAck('joinLobbyByCode', { code: lobby.inviteCode })).error.code).toBe('KICKED_FROM_LOBBY');
    expect((await guest.emitAck('requestJoinLobbyByCode', { code: lobby.inviteCode })).error.code).toBe('KICKED_FROM_LOBBY');
    await host.emitAck('lockLobby');
    const pub = await live(hub, 'other');
    const pubLobby = (await pub.emitAck('createLobby', { name: 'pub' })).lobby;
    const victim = await live(hub, 'other');
    await victim.emitAck('joinLobby', { lobbyId: pubLobby.id });
    await pub.emitAck('lockLobby');
    await pub.emitAck('kickPlayer', { playerId: victim.user.userId });
    const before = pub.events.length;
    expect((await victim.emitAck('requestJoinLobby', { lobbyId: pubLobby.id })).error.code).toBe('KICKED_FROM_LOBBY');
    await befriend(pub, victim);
    expect((await victim.emitAck('lobby:joinFriend', { friendId: pub.user.userId })).error.code).toBe('KICKED_FROM_LOBBY');
    await sleep(100);
    expect(pub.events.slice(before).some((e) => e.event === 'joinRequestReceived')).toBe(false);
    closeAll(host, guest, pub, victim);
  });

  it('TEST-KICK-03: host unkickPlayer lets the player rejoin; non-host → NOT_HOST; not kicked → PLAYER_NOT_FOUND', async () => {
    const { host, guest, other, lobby } = await kicked();
    await other.emitAck('joinLobby', { lobbyId: lobby.id });
    expect((await other.emitAck('unkickPlayer', { playerId: guest.user.userId })).error.code).toBe('NOT_HOST');
    expect((await host.emitAck('unkickPlayer', { playerId: other.user.userId })).error.code).toBe('PLAYER_NOT_FOUND');
    expect((await host.emitAck('unkickPlayer', { playerId: guest.user.userId })).ok).toBe(true);
    expect((await guest.emitAck('joinLobby', { lobbyId: lobby.id })).ok).toBe(true);
    closeAll(host, guest, other);
  });

  it('TEST-KICK-04: a host invite clears the kick (invite accept joins); a non-host invite of a kicked user is refused', async () => {
    const { host, guest, other, lobby } = await kicked();
    await befriend(host, guest);
    await befriend(other, guest);
    await other.emitAck('joinLobby', { lobbyId: lobby.id });
    const viaMember = await other.emitAck('lobby:invite', { friendId: guest.user.userId });
    expect(viaMember.error.code).toBe('KICKED_FROM_LOBBY');
    const inv = await host.emitAck('lobby:invite', { friendId: guest.user.userId });
    expect(inv.ok).toBe(true);
    expect((await guest.emitAck('joinLobby', { lobbyId: lobby.id })).ok).toBe(true);

    closeAll(host, guest, other);
  });

  it('TEST-KICK-05: kicking a member in reconnect grace works; the kick set dies with the lobby', async () => {
    const [host, guest] = [await live(hub, 'other'), await live(hub, 'other')];
    const lobby = (await host.emitAck('createLobby', { name: 'grace' })).lobby;
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });
    guest.close();
    await host.waitFor('lobbyUpdated', (l: any) => l.players.some((p: any) => p.connected === false));
    const res = await host.emitAck('kickPlayer', { playerId: guest.user.userId });
    expect(res.ok).toBe(true);
    expect(res.lobby.players).toHaveLength(1);
    await host.emitAck('leaveLobby');
    const fresh = await live(hub, 'other');
    expect((await fresh.emitAck('createLobby', { name: 'new' })).ok).toBe(true);
    closeAll(host, fresh);
  });
});
