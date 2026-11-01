import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectRegistered, registerUser, startHub, type TestClient, type TestHub } from './helpers/hub';

let hub: TestHub;
beforeAll(async () => { hub = await startHub({ limits: { joinRequestTimeoutMs: 900 } }); });
afterAll(async () => { await hub.stop(); });

const pair = async (): Promise<{ host: TestClient; guest: TestClient; lobbyId: string }> => {
  const host = await connectRegistered(hub, await registerUser(hub), 'relay');
  const guest = await connectRegistered(hub, await registerUser(hub), 'relay');
  const lobby = (await host.emitAck('createLobby', { name: 'l' })).lobby;
  await host.emitAck('lockLobby');
  return { host, guest, lobbyId: lobby.id };
};

describe('Join request outcomes reach both parties (#64)', () => {
  it('pending/received carry expiresAt; getJoinRequests mirrors both sides', async () => {
    const { host, guest, lobbyId } = await pair();
    await guest.emitAck('requestJoinLobby', { lobbyId });
    const pending = await guest.waitFor('joinRequestPending');
    const received = await host.waitFor('joinRequestReceived');
    expect(pending.expiresAt).toBeGreaterThan(Date.now() - 1000);
    expect(received).toMatchObject({ lobbyId, requesterId: guest.user.userId, expiresAt: pending.expiresAt });

    const h = await host.emitAck('getJoinRequests');
    expect(h.incoming).toEqual([{ lobbyId, requesterId: guest.user.userId, username: guest.user.username, expiresAt: pending.expiresAt }]);
    expect(h.outgoing).toBeUndefined();
    const g = await guest.emitAck('getJoinRequests');
    expect(g.incoming).toEqual([]);
    expect(g.outgoing).toMatchObject({ lobbyId, requesterId: guest.user.userId });
    host.close(); guest.close();
  });

  it('decline: requester informed, request gone from pull API', async () => {
    const { host, guest, lobbyId } = await pair();
    await guest.emitAck('requestJoinLobby', { lobbyId });
    await host.waitFor('joinRequestReceived');
    await host.emitAck('respondJoinRequest', { requesterId: guest.user.userId, accept: false });
    expect(await guest.waitFor('joinRequestRejected')).toEqual({ lobbyId, reason: 'declined' });
    expect((await guest.emitAck('getJoinRequests')).outgoing).toBeUndefined();
    expect((await host.emitAck('getJoinRequests')).incoming).toEqual([]);
    host.close(); guest.close();
  });

  it('timeout: both sides informed with lobbyId', async () => {
    const { host, guest, lobbyId } = await pair();
    await guest.emitAck('requestJoinLobby', { lobbyId });
    await host.waitFor('joinRequestReceived');
    expect(await guest.waitFor('joinRequestRejected', () => true, 4000)).toEqual({ lobbyId, reason: 'timeout' });
    expect(await host.waitFor('joinRequestWithdrawn', () => true, 4000)).toEqual({ lobbyId, requesterId: guest.user.userId, reason: 'timeout' });
    expect((await host.emitAck('getJoinRequests')).incoming).toEqual([]);
    host.close(); guest.close();
  });

  it('cancel: host AND requester (all sessions) are notified', async () => {
    const { host, guest, lobbyId } = await pair();
    await guest.emitAck('requestJoinLobby', { lobbyId });
    await host.waitFor('joinRequestReceived');
    expect((await guest.emitAck('cancelJoinRequest', { lobbyId })).ok).toBe(true);
    const expected = { lobbyId, requesterId: guest.user.userId, reason: 'cancelled' };
    expect(await host.waitFor('joinRequestWithdrawn')).toEqual(expected);
    expect(await guest.waitFor('joinRequestWithdrawn')).toEqual(expected);
    expect((await guest.emitAck('cancelJoinRequest', { lobbyId })).error.code).toBe('JOIN_REQUEST_NOT_FOUND');
    host.close(); guest.close();
  });

  it('requester disconnect withdraws the request for the host', async () => {
    const { host, guest, lobbyId } = await pair();
    await guest.emitAck('requestJoinLobby', { lobbyId });
    await host.waitFor('joinRequestReceived');
    guest.close();
    expect(await host.waitFor('joinRequestWithdrawn', () => true, 8000)).toMatchObject({ lobbyId, reason: 'cancelled' });
    expect((await host.emitAck('getJoinRequests')).incoming).toEqual([]);
    host.close();
  });

  it('host leaves: requester informed with host_changed/lobby_closed', async () => {
    const { host, guest, lobbyId } = await pair();
    await guest.emitAck('requestJoinLobby', { lobbyId });
    await host.waitFor('joinRequestReceived');
    await host.emitAck('leaveLobby');
    const rej = await guest.waitFor('joinRequestRejected');
    expect(rej.lobbyId).toBe(lobbyId);
    expect(['lobby_closed', 'host_changed']).toContain(rej.reason);
    host.close(); guest.close();
  });
});
