import path from 'path';
import { createClient } from '@libsql/client';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, befriend, closeAll, connectClient, connectRegistered, FAST_SOCIAL, gameServer, live, registerUser, sleep, startHub, type TestHub } from './util';

let hub: TestHub;
beforeAll(async () => { hub = await startHub({ env: FAST_SOCIAL }); });
afterAll(async () => { await hub.stop(); });

const loginRaw = (username: string, password: string) =>
  fetch(`${hub.url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });

const refreshRaw = (refreshToken: string) =>
  fetch(`${hub.url}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }) });

async function countRows(sql: string, args: string[]): Promise<number> {
  const db = createClient({ url: `file:${path.join(hub.dataDir, 'ethernal.db').replace(/\\/g, '/')}` });
  try {
    return Number((await db.execute({ sql, args })).rows[0].n);
  } finally {
    db.close();
  }
}

describe('Account lifecycle', () => {
  it('TEST-ACCOUNT-01: password change validates, revokes other sessions/tokens and returns a fresh pair', async () => {
    const u = await registerUser(hub);
    const other = await connectClient(hub, u, 'panel');
    const current = await connectClient(hub, u);
    const second = await (await fetch(`${hub.url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u.username, password: 'password123' }) })).json();

    expect((await api(hub, u, 'POST', '/auth/password', { currentPassword: 'wrong-password', newPassword: 'newpassword1' })).body.code).toBe('INVALID_CREDENTIALS');
    expect((await api(hub, u, 'POST', '/auth/password', { currentPassword: 'password123', newPassword: 'short' })).status).toBe(400);
    expect((await fetch(`${hub.url}/auth/password`, { method: 'POST' })).status).toBe(401);
    expect((await loginRaw(u.username, 'password123')).status).toBe(200);

    const res = await api(hub, u, 'POST', '/auth/password', { currentPassword: 'password123', newPassword: 'newpassword1', socketId: current.socket.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ user: { id: u.userId, username: u.username } });
    expect(await other.waitFor('session:replaced')).toEqual({ reason: 'password_changed' });
    await sleep(200);
    expect(current.socket.connected).toBe(true);
    expect(current.count('session:replaced')).toBe(0);

    // alte Tokens sind tot, neue funktionieren
    expect((await refreshRaw(u.refreshToken)).status).toBe(401);
    expect((await refreshRaw(second.refreshToken)).status).toBe(401);
    expect((await api(hub, u, 'GET', '/social/blocks')).status).toBe(401);
    const fresh = { ...u, accessToken: res.body.accessToken, refreshToken: res.body.refreshToken };
    expect((await api(hub, fresh, 'GET', '/social/blocks')).status).toBe(200);
    expect((await refreshRaw(res.body.refreshToken)).status).toBe(200);
    await expect(connectClient(hub, u)).rejects.toBeTruthy();
    closeAll(await connectClient(hub, fresh));

    expect((await loginRaw(u.username, 'password123')).status).toBe(401);
    expect((await loginRaw(u.username, 'newpassword1')).status).toBe(200);
    closeAll(other, current);
  });

  it('TEST-ACCOUNT-02: delete requires the password; afterwards login, tokens and sockets are dead', async () => {
    const u = await registerUser(hub);
    const c = await connectClient(hub, u);
    expect((await api(hub, u, 'DELETE', '/auth/account', { password: 'nope-nope' })).body.code).toBe('INVALID_CREDENTIALS');
    expect((await api(hub, u, 'DELETE', '/auth/account', {})).status).toBe(400);
    expect((await fetch(`${hub.url}/auth/account`, { method: 'DELETE' })).status).toBe(401);
    expect(c.socket.connected).toBe(true);

    expect((await api(hub, u, 'DELETE', '/auth/account', { password: 'password123' })).status).toBe(204);
    await sleep(300);
    expect(c.socket.connected).toBe(false);
    expect((await loginRaw(u.username, 'password123')).status).toBe(401);
    expect((await refreshRaw(u.refreshToken)).status).toBe(401);
    expect((await api(hub, u, 'GET', '/social/blocks')).status).toBe(401);
    expect((await api(hub, u, 'GET', '/account/export')).status).toBe(401);
    // der Name ist wieder frei
    expect((await fetch(`${hub.url}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u.username, password: 'password123' }) })).status).toBe(201);
  });

  it('TEST-ACCOUNT-03: complete purge: no row about the user remains and counterparts are cleaned up', async () => {
    const [a, f, blocker, stranger] = [await live(hub), await live(hub), await live(hub), await live(hub)];
    const id = a.user.userId;
    await befriend(a, f);
    await a.emitAck('dm:send', { toUserId: f.user.userId, text: 'bye' });
    await f.waitFor('dm:received');
    await f.emitAck('dm:send', { toUserId: id, text: 'hello' });
    await a.emitAck('block:add', { userId: stranger.user.userId });
    await blocker.emitAck('block:add', { userId: id });
    await stranger.emitAck('friend:request', { username: a.user.username });
    await api(hub, a.user, 'PUT', '/userdata/relay/score', { value: 5, visibility: 'public' });
    await a.emitAck('createLobby', { name: 'gone' });
    await a.emitAck('lobby:invite', { friendId: f.user.userId });

    expect((await api(hub, a.user, 'DELETE', '/auth/account', { password: 'password123' })).status).toBe(204);
    expect(await f.waitFor('friend:removed', (e) => e.userId === id)).toEqual({ userId: id, reason: 'account_deleted' });
    await sleep(500);

    const tables: Array<[string, string]> = [
      ['users', 'id = ?'],
      ['user_data', 'user_id = ?'],
      ['refresh_tokens', 'user_id = ?'],
      ['social_settings', 'user_id = ?'],
      ['notifications', 'user_id = ?'],
      ['user_blocks', 'blocker_id = ? OR blocked_id = ?'],
      ['friendships', 'user_a = ? OR user_b = ?'],
      ['friend_requests', 'from_user = ? OR to_user = ?'],
      ['direct_messages', 'from_user = ? OR to_user = ?'],
    ];
    for (const [table, where] of tables) {
      const args = where.includes('OR') ? [id, id] : [id];
      expect(await countRows(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, args), table).toBe(0);
    }
    expect((await f.emitAck('friend:list')).friends).toEqual([]);
    expect((await f.emitAck('lobby:invites')).invites).toEqual([]);
    expect((await blocker.emitAck('block:list')).blocks).toEqual([]);
    expect((await stranger.emitAck('friend:requests')).outgoing).toEqual([]);
    closeAll(f, blocker, stranger);
  });

  it('TEST-ACCOUNT-04: deleting the host migrates the lobby; deleting the last member closes it; game server gets player:left account_deleted', async () => {
    const s = await gameServer(hub, 'gs-req');
    const host = await connectRegistered(hub, await registerUser(hub), 'gs-req');
    const guest = await connectRegistered(hub, await registerUser(hub), 'gs-req');
    const { lobby } = await host.emitAck('createLobby', { name: 'migrate' });
    await guest.emitAck('joinLobby', { lobbyId: lobby.id });
    await s.waitFor('player:joined', (d) => d.userId === guest.user.userId);

    expect((await api(hub, host.user, 'DELETE', '/auth/account', { password: 'password123' })).status).toBe(204);
    expect(await s.waitFor('player:left', (d) => d.userId === host.user.userId)).toMatchObject({ lobbyId: lobby.id, reason: 'account_deleted' });
    const after = await guest.emitAck('getLobbyInfo');
    expect(after.lobby.players.map((p: any) => p.userId)).toEqual([guest.user.userId]);
    expect(after.lobby.hostId).toBe(guest.user.userId);

    expect((await api(hub, guest.user, 'DELETE', '/auth/account', { password: 'password123' })).status).toBe(204);
    await s.waitFor('player:left', (d) => d.userId === guest.user.userId && d.reason === 'account_deleted');
    await s.waitFor('lobby:closed', (d) => d.lobbyId === lobby.id);
    closeAll(s);
  });

  it('TEST-ACCOUNT-05: export contains the own data only (profile, data, friends, DMs, notifications, settings, blocks)', async () => {
    const [a, f, b, x] = [await live(hub), await live(hub), await live(hub), await live(hub)];
    await befriend(a, f);
    await a.emitAck('dm:send', { toUserId: f.user.userId, text: 'to-friend' });
    await f.emitAck('dm:send', { toUserId: a.user.userId, text: 'from-friend' });
    await a.emitAck('block:add', { userId: b.user.userId });
    await a.emitAck('social:setSettings', { status: 'busy' });
    await api(hub, a.user, 'PUT', '/userdata/relay/score', { value: 7, visibility: 'private' });
    await x.emitAck('dm:send', { toUserId: b.user.userId, text: 'nope' });
    await f.emitAck('social:setSettings', { status: 'away' });

    const res = await api(hub, a.user, 'GET', '/account/export');
    expect(res.status).toBe(200);
    expect(res.body.profile).toMatchObject({ id: a.user.userId, username: a.user.username });
    expect(res.body.profile.createdAt).toBeGreaterThan(0);
    expect(res.body.userData).toEqual([expect.objectContaining({ gameId: 'relay', key: 'score', value: 7, visibility: 'private' })]);
    expect(res.body.friends).toEqual([{ userId: f.user.userId, username: f.user.username }]);
    expect(res.body.messages.map((m: any) => m.text).sort()).toEqual(['from-friend', 'to-friend']);
    expect(res.body.notifications.length).toBeGreaterThan(0);
    expect(res.body.settings).toMatchObject({ status: 'busy' });
    expect(res.body.blocks.map((e: any) => e.userId)).toEqual([b.user.userId]);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('password');
    expect(text).not.toContain('away');
    expect(text).not.toContain('nope');
    expect((await fetch(`${hub.url}/account/export`)).status).toBe(401);
    closeAll(a, f, b, x);
  });

  it('TEST-ACCOUNT-06: a deleted user cannot reconnect and a stale socket token stops working', async () => {
    const u = await registerUser(hub);
    expect((await api(hub, u, 'DELETE', '/auth/account', { password: 'password123' })).status).toBe(204);
    const err = await new Promise<Error>((resolve) => {
      const s = connect(hub.url, { auth: { token: `Bearer ${u.accessToken}`, clientType: 'game' }, transports: ['websocket'], forceNew: true, reconnection: false });
      s.once('connect_error', (e) => { s.close(); resolve(e); });
      s.once('connect', () => { s.close(); resolve(new Error('connected')); });
    });
    expect(err.message).toBe('INVALID_TOKEN');
  });
});
