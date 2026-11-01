import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { EthernalClient } from '../../sdk/src/index';
import {
  api,
  connectClient,
  connectRegistered,
  registerUser,
  sleep,
  startHub,
  type TestClient,
  type TestHub,
} from './helpers/hub';

async function startWithEnv(env: Record<string, string>, opts: Parameters<typeof startHub>[0] = {}): Promise<TestHub> {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return await startHub(opts);
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const FAST = { FRIEND_NAME_LOOKUP_MIN_MS: '20', SOCIAL_PURGE_INTERVAL_MS: '300' };

let hub: TestHub;
let strict: TestHub;
let retention: TestHub;
beforeAll(async () => {
  hub = await startWithEnv(FAST);
  strict = await startWithEnv(
    {
      ...FAST,
      FRIENDS_MAX: '2',
      FRIEND_REQUESTS_MAX_OUTGOING: '2',
      FRIEND_SILENT_DECLINE: 'true',
      NOTIFICATION_CAP_PER_USER: '3',
      DM_CONVERSATION_CAP: '3',
      LOBBY_INVITE_TTL_MS: '700',
    },
    {
      limits: {
        socketLimits: {
          friendRequestByName: { refillPerSecond: 0.001, burst: 3 },
          dmSend: { refillPerSecond: 0.001, burst: 4 },
        },
      },
    },
  );
  retention = await startWithEnv({
    ...FAST,
    FRIEND_REQUEST_EXPIRY_DAYS: '0.00003',
    NOTIFICATION_UNREAD_RETENTION_DAYS: '0.00003',
    DM_RETENTION_DAYS: '0.00003',
  });
});
afterAll(async () => {
  await Promise.all([hub.stop(), strict.stop(), retention.stop()]);
});

const live = async (h: TestHub, game = 'relay'): Promise<TestClient> => connectRegistered(h, await registerUser(h, 'soc'), game);

async function befriend(a: TestClient, b: TestClient): Promise<void> {
  const res = await a.emitAck('friend:request', { username: b.user.username });
  expect(res.result).toBe('REQUEST_SENT');
  await b.waitFor('friend:requestReceived', (e) => e.request.user.userId === a.user.userId);
  const request = (await b.emitAck('friend:requests')).incoming.find((r: any) => r.user.userId === a.user.userId);
  const ok = await b.emitAck('friend:respond', { requestId: request.id, accept: true });
  expect(ok.ok).toBe(true);
  await a.waitFor('friend:requestAccepted', (e) => e.friend.userId === b.user.userId);
}

/** Verbindet einen bestehenden User (offline → online) neu */
const reconnect = async (h: TestHub, c: TestClient, game?: string): Promise<TestClient> =>
  game ? connectRegistered(h, c.user, game) : connectClient(h, c.user);

const closeAll = (...cs: TestClient[]): void => cs.forEach((c) => c.close());

describe('Friends core (#26)', () => {
  it('Namensanfrage: nur REQUEST_SENT / NO_SUCH_PLAYER, gleiche Antwortform in allen Fällen', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    const existing = await a.emitAck('friend:request', { username: b.user.username });
    const missing = await a.emitAck('friend:request', { username: 'does-not-exist-xyz' });
    const self = await a.emitAck('friend:request', { username: a.user.username });
    const duplicate = await a.emitAck('friend:request', { username: b.user.username });
    expect(existing).toEqual({ ok: true, result: 'REQUEST_SENT' });
    expect(missing).toEqual({ ok: true, result: 'NO_SUCH_PLAYER' });
    expect(self).toEqual({ ok: true, result: 'REQUEST_SENT' });
    expect(duplicate).toEqual({ ok: true, result: 'REQUEST_SENT' });
    // Selbstanfrage/Duplikate erzeugen nichts
    expect((await a.emitAck('friend:requests')).outgoing).toHaveLength(1);
    expect(b.count('friend:requestReceived')).toBe(1);
    expect((await a.emitAck('friend:request', {})).error.code).toBe('INVALID_INPUT');
    closeAll(a, b);
  });

  it('Anfrage → annehmen: Events, Listen und nur {userId, username} sichtbar', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const { friends } = await x.emitAck('friend:list');
      expect(friends).toEqual([{ userId: y.user.userId, username: y.user.username }]);
    }
    const inc = await b.emitAck('friend:requests');
    expect(inc.incoming).toHaveLength(0);
    expect((await a.emitAck('friend:requests')).outgoing).toHaveLength(0);
    // Anfrage ist auch als Notification angekommen und nach Antwort wieder weg
    expect((await b.emitAck('notification:counts')).byType.friend_request).toBeUndefined();
    closeAll(a, b);
  });

  it('Ablehnen: Absender erfährt nur "declined"; nicht befreundet', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await a.emitAck('friend:request', { username: b.user.username });
    const { request } = await b.waitFor('friend:requestReceived');
    expect((await b.emitAck('friend:respond', { requestId: request.id, accept: false })).ok).toBe(true);
    const declined = await a.waitFor('friend:requestDeclined');
    expect(Object.keys(declined).sort()).toEqual(['requestId', 'user']);
    expect((await a.emitAck('friend:list')).friends).toEqual([]);
    expect((await b.emitAck('friend:respond', { requestId: request.id, accept: true })).error.code).toBe('FRIEND_REQUEST_NOT_FOUND');
    closeAll(a, b);
  });

  it('Ablehnen ist konfigurierbar still', async () => {
    const [a, b] = [await live(strict), await live(strict)];
    await a.emitAck('friend:request', { username: b.user.username });
    const { request } = await b.waitFor('friend:requestReceived');
    await b.emitAck('friend:respond', { requestId: request.id, accept: false });
    await sleep(200);
    expect(a.count('friend:requestDeclined')).toBe(0);
    closeAll(a, b);
  });

  it('Zurückziehen: Empfänger bekommt Event, Anfrage und Notification verschwinden', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await a.emitAck('friend:request', { username: b.user.username });
    const { request } = await b.waitFor('friend:requestReceived');
    expect((await b.emitAck('notification:counts')).byType.friend_request).toBe(1);
    expect((await b.emitAck('friend:cancel', { requestId: request.id })).error.code).toBe('FRIEND_REQUEST_NOT_FOUND');
    expect((await a.emitAck('friend:cancel', { requestId: request.id })).ok).toBe(true);
    await b.waitFor('friend:requestCancelled', (e) => e.requestId === request.id);
    expect((await b.emitAck('friend:requests')).incoming).toHaveLength(0);
    expect((await b.emitAck('notification:counts')).unread).toBe(0);
    closeAll(a, b);
  });

  it('Anfrage aus der Lobby per userId (nur Lobby-Mitglieder)', async () => {
    const [a, b, outsider] = [await live(hub), await live(hub), await live(hub)];
    expect((await a.emitAck('friend:request', { userId: b.user.userId })).error.code).toBe('NOT_IN_LOBBY');
    const lobby = (await a.emitAck('createLobby', { name: 'f' })).lobby;
    await b.emitAck('joinLobby', { lobbyId: lobby.id });
    expect((await a.emitAck('friend:request', { userId: outsider.user.userId })).error.code).toBe('PLAYER_NOT_IN_LOBBY');
    expect(await a.emitAck('friend:request', { userId: b.user.userId })).toEqual({ ok: true, result: 'REQUEST_SENT' });
    const { request } = await b.waitFor('friend:requestReceived');
    expect(request.source).toBe('lobby');
    await b.emitAck('friend:respond', { requestId: request.id, accept: true });
    expect((await a.emitAck('friend:list')).friends).toHaveLength(1);
    closeAll(a, b, outsider);
  });

  it('Gegenanfrage (A→B, dann B→A) akzeptiert automatisch', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await a.emitAck('friend:request', { username: b.user.username });
    await b.waitFor('friend:requestReceived');
    expect(await b.emitAck('friend:request', { username: a.user.username })).toEqual({ ok: true, result: 'REQUEST_SENT' });
    await a.waitFor('friend:requestAccepted');
    expect((await a.emitAck('friend:list')).friends).toHaveLength(1);
    expect((await a.emitAck('friend:requests')).outgoing).toHaveLength(0);
    expect((await b.emitAck('friend:requests')).outgoing).toHaveLength(0);
    closeAll(a, b);
  });

  it('Freund entfernen: beide benachrichtigt, nochmals → NOT_FRIENDS', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    expect((await a.emitAck('friend:remove', { friendId: b.user.userId })).ok).toBe(true);
    await b.waitFor('friend:removed', (e) => e.userId === a.user.userId);
    expect((await b.emitAck('friend:list')).friends).toEqual([]);
    expect((await a.emitAck('friend:remove', { friendId: b.user.userId })).error.code).toBe('NOT_FRIENDS');
    closeAll(a, b);
  });

  it('Limits: max Freunde, max ausgehende Anfragen, Rate-Limit für Namensanfragen', async () => {
    const [a, b, c, d] = [await live(strict), await live(strict), await live(strict), await live(strict)];
    await befriend(a, b);
    await befriend(a, c);
    expect((await a.emitAck('friend:request', { userId: d.user.userId })).ok).toBe(false);
    // Eigenes Limit voll: spezifischer Fehler (betrifft nur den Aufrufer)
    expect((await a.emitAck('friend:request', { username: d.user.username })).error.code).toBe('FRIEND_LIMIT_REACHED');

    const x = await live(strict);
    const targets = [await live(strict), await live(strict), await live(strict)];
    // burst 3 für Namensanfragen: Anfragen 1+2 füllen das Outgoing-Limit, 3. → REQUEST_LIMIT_REACHED, 4. → RATE_LIMITED
    expect((await x.emitAck('friend:request', { username: targets[0].user.username })).result).toBe('REQUEST_SENT');
    expect((await x.emitAck('friend:request', { username: targets[1].user.username })).result).toBe('REQUEST_SENT');
    expect((await x.emitAck('friend:request', { username: targets[2].user.username })).error.code).toBe('REQUEST_LIMIT_REACHED');
    const limited = await x.emitAck('friend:request', { username: 'nobody-here' });
    expect(limited.error.code).toBe('RATE_LIMITED');
    expect(limited.error.retryAfterMs).toBeGreaterThan(0);
    closeAll(a, b, c, d, x, ...targets);
  });

  it('Anfragen laufen ab (Scheduler) und werden aus der DB entfernt', async () => {
    const [a, b] = [await live(retention), await live(retention)];
    await a.emitAck('friend:request', { username: b.user.username });
    const { request } = await b.waitFor('friend:requestReceived');
    await sleep(3500);
    expect((await b.emitAck('friend:requests')).incoming).toHaveLength(0);
    expect((await b.emitAck('friend:respond', { requestId: request.id, accept: true })).error.code).toBe('FRIEND_REQUEST_NOT_FOUND');
    const db = createClient({ url: `file:${path.join(retention.dataDir, 'ethernal.db')}` });
    const rows = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM friend_requests WHERE id = ?', args: [request.id] });
    expect(Number(rows.rows[0].n)).toBe(0);
    db.close();
    closeAll(a, b);
  });

  it('Kaskade: DELETE /social/data entfernt Freundschaften, Anfragen, DMs, Notifications', async () => {
    const [a, b, c] = [await live(hub), await live(hub), await live(hub)];
    await befriend(a, b);
    await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'hi' });
    await c.emitAck('friend:request', { username: a.user.username });
    await a.waitFor('friend:requestReceived');
    const res = await api(hub, a.user, 'DELETE', '/social/data');
    expect(res.status).toBe(200);
    await b.waitFor('friend:removed', (e) => e.userId === a.user.userId);
    expect((await b.emitAck('friend:list')).friends).toEqual([]);
    expect((await b.emitAck('dm:conversations')).conversations).toEqual([]);
    expect((await c.emitAck('friend:requests')).outgoing).toEqual([]);
    expect((await a.emitAck('notification:counts')).total).toBe(0);
    closeAll(a, b, c);
  });

  it('REST-Parität: Anfrage, Liste, Antwort, Entfernen', async () => {
    const [a, b] = [await registerUser(hub), await registerUser(hub)];
    expect((await api(hub, a, 'POST', '/social/friends/requests', { username: 'no-such-user-abc' })).body).toEqual({ result: 'NO_SUCH_PLAYER' });
    expect((await api(hub, a, 'POST', '/social/friends/requests', { username: b.username })).body).toEqual({ result: 'REQUEST_SENT' });
    const reqs = await api(hub, b, 'GET', '/social/friends/requests');
    expect(reqs.body.incoming).toHaveLength(1);
    expect(reqs.body.incoming[0].user.userId).toBe(a.userId);
    expect((await api(hub, a, 'GET', '/social/friends/requests')).body.outgoing).toHaveLength(1);
    expect((await api(hub, b, 'POST', `/social/friends/requests/${reqs.body.incoming[0].id}/respond`, { accept: true })).status).toBe(200);
    expect((await api(hub, a, 'GET', '/social/friends')).body.friends).toEqual([{ userId: b.userId, username: b.username }]);
    expect((await api(hub, a, 'DELETE', `/social/friends/${b.userId}`)).status).toBe(200);
    expect((await api(hub, a, 'DELETE', `/social/friends/${b.userId}`)).body.code).toBe('NOT_FRIENDS');
    expect((await api(hub, a, 'GET', '/social/friends/requests').then(() => fetch(`${hub.url}/social/friends`))).status).toBe(401);
  });
});

describe('Presence-Privacy (#27)', () => {
  it('Freunde sehen Presence-Änderungen, Fremde nichts', async () => {
    const [a, b, stranger] = [await live(hub), await live(hub), await live(hub)];
    await befriend(a, b);
    const lobby = (await a.emitAck('createLobby', { name: 'p' })).lobby;
    await b.waitFor('friend:presence', (p) => p.userId === a.user.userId && p.lobbyJoinable === true);
    await sleep(200);
    expect(stranger.events.filter((e) => e.event.startsWith('presence:') || e.event === 'friend:presence')).toEqual([]);
    expect(JSON.stringify(b.events)).not.toContain(lobby.id);
    closeAll(a, b, stranger);
  });

  it('Pull: presence:friends + REST; gameId, Online-Status', async () => {
    const [a, b] = [await live(hub, 'relay'), await live(hub, 'other')];
    await befriend(a, b);
    const { presence } = await a.emitAck('presence:friends');
    expect(presence).toEqual([{ userId: b.user.userId, username: b.user.username, online: true, status: 'online', gameId: 'other' }]);
    const rest = await api(hub, a.user, 'GET', '/social/presence');
    expect(rest.body.presence).toEqual(presence);
    closeAll(a, b);
  });

  it('invisible erscheint offline (kein gameId/Lobby); Status ändern pusht', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    await a.emitAck('createLobby', { name: 'hidden' });
    expect((await a.emitAck('social:setSettings', { status: 'invisible' })).settings.status).toBe('invisible');
    const seen = await b.waitFor('friend:presence', (p) => p.userId === a.user.userId && p.online === false);
    expect(seen.status).toBe('offline');
    expect(seen.gameId).toBeUndefined();
    expect(seen.lobbyJoinable).toBeUndefined();
    expect((await b.emitAck('presence:friends')).presence[0]).toMatchObject({ online: false, status: 'offline' });
    expect((await b.emitAck('social:friendLobby', { friendId: a.user.userId })).lobby).toBeNull();
    await a.emitAck('social:setSettings', { status: 'busy' });
    await b.waitFor('friend:presence', (p) => p.userId === a.user.userId && p.status === 'busy');
    expect((await a.emitAck('social:setSettings', { status: 'nope' })).error.code).toBe('INVALID_INPUT');
    closeAll(a, b);
  });

  it('Private Lobby: nie eine Lobby-ID, lobbyJoinable=false; öffentliche: joinable ohne ID', async () => {
    const [a, b] = [await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce')];
    await befriend(a, b);
    const priv = (await a.emitAck('createLobby', { name: 'priv', isPrivate: true })).lobby;
    await b.waitFor('friend:presence', (p) => p.userId === a.user.userId && p.lobbyJoinable === false);
    await a.emitAck('leaveLobby');
    const pub = (await a.emitAck('createLobby', { name: 'pub' })).lobby;
    await b.waitFor('friend:presence', (p) => p.userId === a.user.userId && p.lobbyJoinable === true);
    const dump = JSON.stringify(b.events.filter((e) => e.event === 'friend:presence'));
    expect(dump).not.toContain(priv.id);
    expect(dump).not.toContain(pub.id);
    expect(dump).not.toContain('lobbyId');
    closeAll(a, b);
  });

  it('lastSeen nach Disconnect nur wenn erlaubt; Gnadenfrist zählt als online', async () => {
    const [a, b, c] = [await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce')];
    await befriend(a, b);
    await befriend(c, b);
    await c.emitAck('social:setSettings', { showLastSeen: false });
    a.close();
    c.close();
    const goneA = await b.waitFor('friend:presence', (p) => p.userId === a.user.userId && p.online === false);
    expect(goneA.lastSeen).toBeGreaterThan(0);
    const goneC = await b.waitFor('friend:presence', (p) => p.userId === c.user.userId && p.online === false);
    expect(goneC.lastSeen).toBeUndefined();

    // Gnadenfrist ('relay' hat 1500ms): bleibt online, danach offline
    const [d, e] = [await live(hub, 'relay'), await live(hub, 'relay')];
    await befriend(d, e);
    await d.emitAck('createLobby', { name: 'grace' });
    d.close();
    await sleep(300);
    expect((await e.emitAck('presence:friends')).presence[0].online).toBe(true);
    await e.waitFor('friend:presence', (p) => p.userId === d.user.userId && p.online === false, 6000);
    closeAll(b, e);
  });
});

describe('Notifications (#28)', () => {
  it('Offline-Empfänger bekommt Backlog beim nächsten Login; Counts, Liste, markRead konsistent', async () => {
    const [a, b0] = [await live(hub), await live(hub)];
    b0.close();
    await a.emitAck('friend:request', { username: b0.user.username });
    const x = await live(hub);
    await x.emitAck('friend:request', { username: b0.user.username });
    await sleep(200);

    const b = await reconnect(hub, b0);
    const backlog = await b.waitFor('notification:backlog');
    expect(backlog.unreadCount).toBe(2);
    expect(backlog.latest.map((n: any) => n.type)).toEqual(['friend_request', 'friend_request']);
    const counts = await b.emitAck('notification:counts');
    expect(counts).toMatchObject({ unread: 2, total: 2, byType: { friend_request: 2 } });

    const page1 = await b.emitAck('notification:list', { limit: 1 });
    expect(page1.notifications).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await b.emitAck('notification:list', { limit: 1, cursor: page1.nextCursor });
    expect(page2.notifications).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
    expect(page2.notifications[0].id).not.toBe(page1.notifications[0].id);

    const marked = await b.emitAck('notification:markRead', { ids: [page1.notifications[0].id] });
    expect(marked).toMatchObject({ marked: 1, unread: 1 });
    expect((await b.emitAck('notification:list', { unreadOnly: true })).notifications).toHaveLength(1);
    const restCounts = await api(hub, b0.user, 'GET', '/social/notifications/counts');
    expect(restCounts.body).toMatchObject({ unread: 1, total: 2 });
    const all = await api(hub, b0.user, 'POST', '/social/notifications/read', { upTo: Date.now() });
    expect(all.body).toMatchObject({ marked: 1, unread: 0 });
    expect((await b.emitAck('notification:markRead', {})).error.code).toBe('INVALID_INPUT');
    closeAll(a, b, x);
  });

  it('Live-Notification an alle Sessions; Mute unterdrückt; Notification wird nach Antwort entfernt', async () => {
    const a = await live(hub);
    const [b, bPanel] = [await live(hub), null as TestClient | null];
    const panel = await connectClient(hub, b.user, 'panel');
    void bPanel;
    await a.emitAck('friend:request', { username: b.user.username });
    const n = await b.waitFor('notification', (x) => x.type === 'friend_request');
    expect(n.payload.fromUsername).toBe(a.user.username);
    await panel.waitFor('notification', (x) => x.id === n.id);

    await b.emitAck('social:setSettings', { mutedNotificationTypes: ['friend_request'] });
    const c = await live(hub);
    await c.emitAck('friend:request', { username: b.user.username });
    await sleep(250);
    expect(b.count('notification', (x) => x.type === 'friend_request')).toBe(1);
    expect((await b.emitAck('notification:counts')).byType.friend_request).toBe(1);
    expect((await b.emitAck('social:setSettings', { mutedNotificationTypes: ['bogus'] })).error.code).toBe('INVALID_INPUT');
    closeAll(a, b, c, panel);
  });

  it('Pro-User-Cap: älteste Notifications fallen heraus', async () => {
    const b = await live(strict);
    for (let i = 0; i < 5; i++) {
      const s = await registerUser(strict);
      await api(strict, s, 'POST', '/social/friends/requests', { username: b.user.username });
    }
    await sleep(200);
    expect((await b.emitAck('notification:counts')).total).toBe(3);
    b.close();
  });

  it('Retention: Scheduler purged abgelaufene Notifications', async () => {
    const [a, b0] = [await live(retention), await live(retention)];
    await befriend(a, b0);
    b0.close();
    await sleep(100);
    await a.emitAck('dm:send', { toUserId: b0.user.userId, text: 'offline' });
    const b = await reconnect(retention, b0);
    expect((await b.waitFor('notification:backlog')).unreadCount).toBe(1);
    await sleep(5000);
    expect((await b.emitAck('notification:counts')).total).toBe(0);
    const db = createClient({ url: `file:${path.join(retention.dataDir, 'ethernal.db')}` });
    const rows = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?', args: [b0.user.userId] });
    expect(Number(rows.rows[0].n)).toBe(0);
    db.close();
    closeAll(a, b);
  });
});

describe('Direct Messages (#29)', () => {
  it('nur Freunde, Längen- und Inhaltsprüfung', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    expect((await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'hi' })).error.code).toBe('NOT_FRIENDS');
    await befriend(a, b);
    expect((await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'x'.repeat(1001) })).error.code).toBe('MESSAGE_TOO_LONG');
    expect((await a.emitAck('dm:send', { toUserId: b.user.userId, text: '   ' })).error.code).toBe('INVALID_INPUT');
    expect((await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'x'.repeat(1000) })).ok).toBe(true);
    expect((await a.emitAck('dm:history', { withUserId: 'someone-else' })).error.code).toBe('NOT_FRIENDS');
    closeAll(a, b);
  });

  it('Live-Zustellung an Online-Empfänger (Text unverändert, kein Markup)', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    const sent = await a.emitAck('dm:send', { toUserId: b.user.userId, text: '<b>hi</b> & co' });
    expect(sent.message).toMatchObject({ from: a.user.userId, to: b.user.userId, text: '<b>hi</b> & co' });
    expect(sent.message.deliveredAt).toBeGreaterThan(0);
    const got = await b.waitFor('dm:received');
    expect(got.text).toBe('<b>hi</b> & co');
    // Online-Empfänger bekommt keine zusätzliche Notification
    expect((await b.emitAck('notification:counts')).byType.dm).toBeUndefined();
    closeAll(a, b);
  });

  it('Offline-Zustellung: Notification (kollabiert), Unread, Delivered-/Read-Events', async () => {
    const [a, b0] = [await live(hub), await live(hub)];
    await befriend(a, b0);
    b0.close();
    await sleep(100);
    for (const t of ['eins', 'zwei', 'drei']) {
      const r = await a.emitAck('dm:send', { toUserId: b0.user.userId, text: t });
      expect(r.message.deliveredAt).toBeUndefined();
    }
    const b = await reconnect(hub, b0);
    const backlog = await b.waitFor('notification:backlog');
    const dmNotifs = backlog.latest.filter((n: any) => n.type === 'dm');
    expect(dmNotifs).toHaveLength(1);
    expect(dmNotifs[0].payload).toMatchObject({ count: 3, fromUserId: a.user.userId });
    const delivered = await a.waitFor('dm:delivered');
    expect(delivered.messageIds).toHaveLength(3);

    const convs = (await b.emitAck('dm:conversations')).conversations;
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ withUserId: a.user.userId, unreadCount: 3 });
    expect(convs[0].lastMessage.text).toBe('drei');

    expect((await b.emitAck('dm:markRead', { withUserId: a.user.userId })).marked).toBe(3);
    const read = await a.waitFor('dm:read');
    expect(read.byUserId).toBe(b.user.userId);
    expect((await b.emitAck('dm:conversations')).conversations[0].unreadCount).toBe(0);
    expect((await b.emitAck('notification:counts')).unread).toBe(0);
    const hist = await a.emitAck('dm:history', { withUserId: b0.user.userId });
    expect(hist.messages.map((m: any) => m.readAt !== undefined)).toEqual([true, true, true]);
    closeAll(a, b);
  });

  it('Verlauf mit Pagination (chronologisch, Cursor nach hinten)', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    for (let i = 1; i <= 5; i++) await a.emitAck('dm:send', { toUserId: b.user.userId, text: `m${i}` });
    const p1 = await b.emitAck('dm:history', { withUserId: a.user.userId, limit: 2 });
    expect(p1.messages.map((m: any) => m.text)).toEqual(['m4', 'm5']);
    const p2 = await b.emitAck('dm:history', { withUserId: a.user.userId, limit: 2, before: p1.nextBefore });
    expect(p2.messages.map((m: any) => m.text)).toEqual(['m2', 'm3']);
    const p3 = await b.emitAck('dm:history', { withUserId: a.user.userId, limit: 2, before: p2.nextBefore });
    expect(p3.messages.map((m: any) => m.text)).toEqual(['m1']);
    expect(p3.nextBefore).toBeUndefined();
    closeAll(a, b);
  });

  it('Lesestand: dm:unread, dm:open (letzte 10 + Markierung), Teil-Lesen, peerLastReadSeq, readState-Push', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    const sent: any[] = [];
    for (let i = 1; i <= 12; i++) sent.push((await a.emitAck('dm:send', { toUserId: b.user.userId, text: `m${i}` })).message);

    const unread = await b.emitAck('dm:unread');
    expect(unread.totalUnread).toBe(12);
    expect(unread.conversations[0]).toMatchObject({
      withUserId: a.user.userId, unreadCount: 12, firstUnreadSeq: sent[0].seq, lastSeq: sent[11].seq,
    });
    expect((await b.emitAck('social:sync')).conversations[0]).toMatchObject({ unreadCount: 12, firstUnreadSeq: sent[0].seq });
    expect((await api(hub, b.user, 'GET', '/social/dm/unread')).body.totalUnread).toBe(12);

    // Partial read via cursor
    const part = await b.emitAck('dm:markRead', { withUserId: a.user.userId, upToSeq: sent[3].seq });
    expect(part).toMatchObject({ marked: 4, lastReadSeq: sent[3].seq, unreadCount: 8, totalUnread: 8 });
    expect((await b.waitFor('dm:readState')).unreadCount).toBe(8);
    expect((await a.waitFor('dm:read')).upToSeq).toBe(sent[3].seq);
    expect((await a.emitAck('dm:history', { withUserId: b.user.userId })).peerLastReadSeq).toBe(sent[3].seq);
    expect((await b.emitAck('notification:counts')).unread).toBeGreaterThanOrEqual(0);

    // Opening shows the last 10 and reports the state from before opening
    const opened = await b.emitAck('dm:open', { withUserId: a.user.userId });
    expect(opened.messages.map((m: any) => m.text)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12']);
    expect(opened).toMatchObject({ lastReadSeq: sent[3].seq, firstUnreadSeq: sent[4].seq, unreadCount: 8 });
    expect(opened.nextBefore).toBe(sent[2].seq);
    expect((await b.emitAck('dm:unread')).totalUnread).toBe(0);
    expect((await b.emitAck('dm:conversations')).conversations[0]).toMatchObject({ unreadCount: 0, lastReadSeq: sent[11].seq });
    expect((await b.emitAck('social:sync')).conversations).toEqual([]);
    expect((await b.emitAck('notification:counts')).byType.dm).toBeUndefined();

    // The sender sees how far the friend has read; reopening yields no unread state
    const hist = await a.emitAck('dm:history', { withUserId: b.user.userId });
    expect(hist.peerLastReadSeq).toBe(sent[11].seq);
    const again = await b.emitAck('dm:open', { withUserId: a.user.userId, limit: 3 });
    expect(again).toMatchObject({ unreadCount: 0, lastReadSeq: sent[11].seq });
    expect(again.firstUnreadSeq).toBeUndefined();
    expect((await b.emitAck('dm:markRead', { withUserId: a.user.userId })).marked).toBe(0);

    // Receipts disabled: no peer cursor
    await b.emitAck('social:setSettings', { dmReadReceipts: false });
    expect((await a.emitAck('dm:history', { withUserId: b.user.userId })).peerLastReadSeq).toBeUndefined();
    closeAll(a, b);
  });

  it('Unfriend löscht Verlauf sofort für beide; Neu-Befreundung beginnt leer', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'geheim' });
    await a.emitAck('friend:remove', { friendId: b.user.userId });
    expect((await b.emitAck('dm:history', { withUserId: a.user.userId })).error.code).toBe('NOT_FRIENDS');
    expect((await b.emitAck('dm:conversations')).conversations).toEqual([]);
    await befriend(a, b);
    expect((await a.emitAck('dm:history', { withUserId: b.user.userId })).messages).toEqual([]);
    closeAll(a, b);
  });

  it('Per-Konversation-Cap und Flood-Limit', async () => {
    const [a, b] = [await live(strict), await live(strict)];
    await befriend(a, b);
    for (let i = 1; i <= 4; i++) await a.emitAck('dm:send', { toUserId: b.user.userId, text: `c${i}` });
    const limited = await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'c5' });
    expect(limited.error.code).toBe('RATE_LIMITED');
    const hist = await b.emitAck('dm:history', { withUserId: a.user.userId });
    expect(hist.messages.map((m: any) => m.text)).toEqual(['c2', 'c3', 'c4']);
    closeAll(a, b);
  });

  it('Retention: Scheduler löscht Nachrichten nach DM_RETENTION_DAYS', async () => {
    const [a, b] = [await live(retention), await live(retention)];
    await befriend(a, b);
    await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'alt' });
    expect((await b.emitAck('dm:history', { withUserId: a.user.userId })).messages).toHaveLength(1);
    await sleep(5000);
    expect((await b.emitAck('dm:history', { withUserId: a.user.userId })).messages).toEqual([]);
    const db = createClient({ url: `file:${path.join(retention.dataDir, 'ethernal.db')}` });
    const rows = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM direct_messages WHERE conversation_id = ?', args: [[a.user.userId, b.user.userId].sort().join(':')] });
    expect(Number(rows.rows[0].n)).toBe(0);
    db.close();
    closeAll(a, b);
  });

  it('Typing-Indikator (ephemer) und REST-Parität', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    expect((await a.emitAck('dm:typing', { toUserId: b.user.userId })).ok).toBe(true);
    expect((await b.waitFor('dm:typing')).fromUserId).toBe(a.user.userId);

    const sent = await api(hub, a.user, 'POST', `/social/dm/${b.user.userId}`, { text: 'rest' });
    expect(sent.status).toBe(201);
    expect((await api(hub, b.user, 'GET', `/social/dm/${a.user.userId}`)).body.messages.map((m: any) => m.text)).toContain('rest');
    expect((await api(hub, b.user, 'GET', '/social/dm')).body.conversations[0].withUserId).toBe(a.user.userId);
    expect((await api(hub, b.user, 'POST', `/social/dm/${a.user.userId}/read`)).body.marked).toBeGreaterThanOrEqual(1);
    expect((await api(hub, a.user, 'POST', '/social/dm/unknown', { text: 'x' })).body.code).toBe('NOT_FRIENDS');
    closeAll(a, b);
  });
});

describe('Friend-Lobby-Aktionen (#30)', () => {
  const pair = async (h: TestHub, game = 'relay-nograce'): Promise<[TestClient, TestClient]> => {
    const [a, b] = [await live(h, game), await live(h, game)];
    await befriend(a, b);
    return [a, b];
  };

  it('Einladung an Online-Freund: Event + Notification; Annahme betritt auch private Lobby', async () => {
    const [host, guest] = await pair(hub);
    const lobby = (await host.emitAck('createLobby', { name: 'priv', isPrivate: true })).lobby;
    const { invite } = await host.emitAck('lobby:invite', { friendId: guest.user.userId });
    expect(invite).toMatchObject({ lobbyId: lobby.id, fromUserId: host.user.userId });
    expect(invite.expiresAt - Date.now()).toBeGreaterThan(4 * 60_000);
    // zweite Einladung für (Lobby, Freund) ist idempotent
    expect((await host.emitAck('lobby:invite', { friendId: guest.user.userId })).invite.inviteId).toBe(invite.inviteId);
    expect(guest.count('lobby:inviteReceived')).toBe(1);
    expect((await guest.waitFor('notification', (n) => n.type === 'lobby_invite')).payload.inviteId).toBe(invite.inviteId);

    expect((await guest.emitAck('lobby:joinFriend', { friendId: host.user.userId })).ok).toBe(true);
    closeAll(host, guest);
  });

  it('acceptInvite: private + gesperrt (Default: Invite umgeht Sperre); Notification verschwindet', async () => {
    const [host, guest] = await pair(hub);
    await host.emitAck('createLobby', { name: 'locked', isPrivate: true });
    await host.emitAck('lockLobby');
    const { invite } = await host.emitAck('lobby:invite', { friendId: guest.user.userId });
    expect((await guest.emitAck('lobby:invites')).invites).toHaveLength(1);
    const res = await guest.emitAck('lobby:acceptInvite', { inviteId: invite.inviteId });
    expect(res.ok).toBe(true);
    expect(res.lobby.players.map((p: any) => p.userId)).toContain(guest.user.userId);
    expect((await guest.emitAck('lobby:invites')).invites).toEqual([]);
    expect((await guest.emitAck('notification:counts')).byType.lobby_invite).toBeUndefined();
    expect((await guest.emitAck('lobby:acceptInvite', { inviteId: invite.inviteId })).error.code).toBe('INVITE_NOT_FOUND');
    closeAll(host, guest);
  });

  it('Ablehnen informiert den Einlader', async () => {
    const [host, guest] = await pair(hub);
    await host.emitAck('createLobby', { name: 'd' });
    const { invite } = await host.emitAck('lobby:invite', { friendId: guest.user.userId });
    expect((await host.emitAck('lobby:declineInvite', { inviteId: invite.inviteId })).error.code).toBe('INVITE_NOT_FOUND');
    expect((await guest.emitAck('lobby:declineInvite', { inviteId: invite.inviteId })).ok).toBe(true);
    expect((await host.waitFor('lobby:inviteDeclined')).userId).toBe(guest.user.userId);
    closeAll(host, guest);
  });

  it('Fehlerpfade: Nicht-Freund, offline, anderes Spiel, keine Lobby, schon drin, Host-only', async () => {
    const [host, guest] = await pair(hub);
    const stranger = await live(hub, 'relay-nograce');
    expect((await host.emitAck('lobby:invite', { friendId: guest.user.userId })).error.code).toBe('NOT_IN_LOBBY');
    await host.emitAck('createLobby', { name: 'x', settings: { inviteHostOnly: true } });
    expect((await host.emitAck('lobby:invite', { friendId: stranger.user.userId })).error.code).toBe('NOT_FRIENDS');

    const otherGame = await live(hub, 'other');
    await befriend(host, otherGame);
    expect((await host.emitAck('lobby:invite', { friendId: otherGame.user.userId })).error.code).toBe('GAME_MISMATCH');

    const offline = await live(hub, 'relay-nograce');
    await befriend(host, offline);
    offline.close();
    await sleep(150);
    expect((await host.emitAck('lobby:invite', { friendId: offline.user.userId })).error.code).toBe('FRIEND_OFFLINE');

    await guest.emitAck('joinLobby', { lobbyId: (await host.emitAck('getLobbyInfo')).lobby.id });
    expect((await host.emitAck('lobby:invite', { friendId: guest.user.userId })).error.code).toBe('ALREADY_IN_LOBBY');
    // Host-only pro Lobby: Mitglied darf nicht einladen
    await befriend(guest, otherGame);
    expect((await guest.emitAck('lobby:invite', { friendId: otherGame.user.userId })).error.code).toBe('NOT_HOST');
    closeAll(host, guest, stranger, otherGame);
  });

  it('Volle Lobby: Einladung wird abgelehnt bzw. automatisch storniert', async () => {
    const [host, f1] = await pair(hub, 'relay');
    const f2 = await live(hub, 'relay');
    await befriend(host, f2);
    await host.emitAck('createLobby', { name: 'two' });
    const i1 = (await host.emitAck('lobby:invite', { friendId: f1.user.userId })).invite;
    const i2 = (await host.emitAck('lobby:invite', { friendId: f2.user.userId })).invite;
    expect((await f1.emitAck('lobby:acceptInvite', { inviteId: i1.inviteId })).ok).toBe(true);
    const cancelled = await f2.waitFor('lobby:inviteCancelled', (e) => e.inviteId === i2.inviteId);
    expect(cancelled.reason).toBe('lobby_full');
    expect((await f2.emitAck('lobby:acceptInvite', { inviteId: i2.inviteId })).error.code).toBe('INVITE_NOT_FOUND');
    const f3 = await live(hub, 'relay');
    await befriend(host, f3);
    expect((await host.emitAck('lobby:invite', { friendId: f3.user.userId })).error.code).toBe('LOBBY_FULL');
    closeAll(host, f1, f2, f3);
  });

  it('Einladung wird beim Verlassen/Auflösen der Lobby storniert; Einlader kann zurückziehen', async () => {
    const [host, guest] = await pair(hub);
    await host.emitAck('createLobby', { name: 'gone' });
    const { invite } = await host.emitAck('lobby:invite', { friendId: guest.user.userId });
    await host.emitAck('leaveLobby');
    const ev = await guest.waitFor('lobby:inviteCancelled', (e) => e.inviteId === invite.inviteId);
    expect(['lobby_closed', 'left']).toContain(ev.reason);
    expect((await guest.emitAck('lobby:invites')).invites).toEqual([]);

    await host.emitAck('createLobby', { name: 'again' });
    const second = (await host.emitAck('lobby:invite', { friendId: guest.user.userId })).invite;
    expect((await host.emitAck('lobby:cancelInvite', { inviteId: second.inviteId })).ok).toBe(true);
    expect((await guest.waitFor('lobby:inviteCancelled', (e) => e.inviteId === second.inviteId)).reason).toBe('cancelled');
    closeAll(host, guest);
  });

  it('Einladungen laufen ab (Ablaufzeit konfigurierbar)', async () => {
    const [host, guest] = await pair(strict);
    await host.emitAck('createLobby', { name: 'exp' });
    const { invite } = await host.emitAck('lobby:invite', { friendId: guest.user.userId });
    const ev = await guest.waitFor('lobby:inviteCancelled', (e) => e.inviteId === invite.inviteId, 4000);
    expect(ev.reason).toBe('expired');
    expect((await guest.emitAck('lobby:acceptInvite', { inviteId: invite.inviteId })).error.code).toBe('INVITE_NOT_FOUND');
    closeAll(host, guest);
  });

  it('Unerreichte Einladung bleibt nach Reconnect sichtbar (Backlog + Pull)', async () => {
    const [host, guest0] = await pair(hub);
    await host.emitAck('createLobby', { name: 'persist' });
    const { invite } = await host.emitAck('lobby:invite', { friendId: guest0.user.userId });
    guest0.close();
    await sleep(150);
    const guest = await reconnect(hub, guest0, 'relay-nograce');
    const backlog = await guest.waitFor('notification:backlog');
    expect(backlog.latest.some((n: any) => n.type === 'lobby_invite' && n.payload.inviteId === invite.inviteId)).toBe(true);
    expect((await guest.emitAck('lobby:invites')).invites[0].inviteId).toBe(invite.inviteId);
    closeAll(host, guest);
  });

  it('Unfriend storniert Einladungen', async () => {
    const [host, guest] = await pair(hub);
    await host.emitAck('createLobby', { name: 'uf' });
    const { invite } = await host.emitAck('lobby:invite', { friendId: guest.user.userId });
    await host.emitAck('friend:remove', { friendId: guest.user.userId });
    const ev = await guest.waitFor('lobby:inviteCancelled', (e) => e.inviteId === invite.inviteId);
    expect(ev.reason).toBe('unfriended');
    closeAll(host, guest);
  });

  it('joinFriend: offen → direkt, gesperrt → Beitrittsanfrage, privat → nur mit Einladung', async () => {
    const [host, guest] = await pair(hub);
    const stranger = await live(hub, 'relay-nograce');
    expect((await guest.emitAck('lobby:joinFriend', { friendId: host.user.userId })).error.code).toBe('FRIEND_NOT_IN_LOBBY');
    expect((await stranger.emitAck('lobby:joinFriend', { friendId: host.user.userId })).error.code).toBe('NOT_FRIENDS');

    await host.emitAck('createLobby', { name: 'open' });
    const open = await guest.emitAck('lobby:joinFriend', { friendId: host.user.userId });
    expect(open).toMatchObject({ ok: true, pending: false });
    await guest.emitAck('leaveLobby');

    await host.emitAck('lockLobby');
    const pending = await guest.emitAck('lobby:joinFriend', { friendId: host.user.userId });
    expect(pending).toMatchObject({ ok: true, pending: true });
    const req = await host.waitFor('joinRequestReceived');
    expect(req.requesterId).toBe(guest.user.userId);
    await host.emitAck('respondJoinRequest', { requesterId: guest.user.userId, accept: true });
    await guest.waitFor('joinRequestAccepted');
    await guest.emitAck('leaveLobby');
    await host.emitAck('leaveLobby');

    await host.emitAck('createLobby', { name: 'priv', isPrivate: true });
    expect((await guest.emitAck('lobby:joinFriend', { friendId: host.user.userId })).error.code).toBe('LOBBY_PRIVATE');
    await host.emitAck('lobby:invite', { friendId: guest.user.userId });
    expect((await guest.emitAck('lobby:joinFriend', { friendId: host.user.userId })).ok).toBe(true);
    closeAll(host, guest, stranger);
  });

  it('joinFriend: anderes Spiel → GAME_MISMATCH', async () => {
    const [host, guest] = [await live(hub, 'relay-nograce'), await live(hub, 'other')];
    await befriend(host, guest);
    await host.emitAck('createLobby', { name: 'x' });
    expect((await guest.emitAck('lobby:joinFriend', { friendId: host.user.userId })).error.code).toBe('GAME_MISMATCH');
    closeAll(host, guest);
  });

  it('social:friendLobby: nur Freunde; Lobby-ID nie bei privaten Lobbys', async () => {
    const [host, guest] = await pair(hub);
    const stranger = await live(hub, 'relay-nograce');
    expect((await host.emitAck('social:friendLobby', { friendId: guest.user.userId })).lobby).toBeNull();
    const pub = (await host.emitAck('createLobby', { name: 'pub' })).lobby;
    const info = (await guest.emitAck('social:friendLobby', { friendId: host.user.userId })).lobby;
    expect(info).toEqual({ lobbyId: pub.id, name: 'pub', players: 1, slots: 4, joinable: true, locked: false, hasInvite: false });
    expect((await stranger.emitAck('social:friendLobby', { friendId: host.user.userId })).error.code).toBe('NOT_FRIENDS');
    expect((await api(hub, guest.user, 'GET', `/social/friends/${host.user.userId}/lobby`)).body.lobby.lobbyId).toBe(pub.id);

    await host.emitAck('leaveLobby');
    await host.emitAck('createLobby', { name: 'priv', isPrivate: true });
    const priv = (await guest.emitAck('social:friendLobby', { friendId: host.user.userId })).lobby;
    expect(priv).toMatchObject({ name: 'priv', joinable: false, hasInvite: false });
    expect(priv.lobbyId).toBeUndefined();
    closeAll(host, guest, stranger);
  });
});

describe('Social-Snapshot (#31)', () => {
  it('social:sync liefert konsistenten Gesamtzustand; GET /social/sync ist identisch', async () => {
    const [a, b, c] = [await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce'), await live(hub, 'relay-nograce')];
    await befriend(a, b);
    await c.emitAck('friend:request', { username: a.user.username });
    await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'hallo' });
    await a.emitAck('createLobby', { name: 'sync' });
    await a.emitAck('lobby:invite', { friendId: b.user.userId });
    await a.waitFor('friend:requestReceived');

    const snap = await b.emitAck('social:sync');
    expect(snap.ok).toBe(true);
    expect(snap.friends).toEqual([{ userId: a.user.userId, username: a.user.username }]);
    expect(snap.presence).toHaveLength(1);
    expect(snap.lobbyInvites).toHaveLength(1);
    expect(snap.status).toBe('online');
    expect(snap.settings.showLastSeen).toBe(true);
    expect(snap.conversations).toMatchObject([{ withUserId: a.user.userId, unreadCount: 1 }]);
    expect(snap.unreadNotifications).toBe((await b.emitAck('notification:counts')).unread);

    const snapA = await a.emitAck('social:sync');
    expect(snapA.requests.incoming).toHaveLength(1);
    expect(snapA.requests.incoming[0].user.userId).toBe(c.user.userId);

    const rest = await api(hub, b.user, 'GET', '/social/sync');
    expect(rest.status).toBe(200);
    const { ok: _ok, serverTime: _t1, ...socketPart } = snap;
    const { serverTime: _t2, ...restPart } = rest.body;
    expect(restPart).toEqual(socketPart);
    closeAll(a, b, c);
  });

  it('etag: unverändert → notModified (Socket + REST 304), nach Änderung neuer etag', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    await sleep(100);
    const first = await a.emitAck('social:sync');
    const same = await a.emitAck('social:sync', { etag: first.etag });
    expect(same).toEqual({ ok: true, notModified: true, etag: first.etag });

    const res = await fetch(`${hub.url}/social/sync`, { headers: { Authorization: `Bearer ${a.user.accessToken}`, 'If-None-Match': first.etag } });
    expect(res.status).toBe(304);
    const viaQuery = await api(hub, a.user, 'GET', `/social/sync?etag=${first.etag}`);
    expect(viaQuery.body).toEqual({ notModified: true, etag: first.etag });

    await a.emitAck('social:setSettings', { status: 'away' });
    const changed = await a.emitAck('social:sync', { etag: first.etag });
    expect(changed.notModified).toBeUndefined();
    expect(changed.etag).not.toBe(first.etag);
    expect(changed.status).toBe('away');
    closeAll(a, b);
  });

  it('Pull-Parität: jede REST-Pull-Route liefert dasselbe wie das Socket-Event', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    await a.emitAck('dm:send', { toUserId: b.user.userId, text: 'p' });
    const pairs: Array<[string, string, unknown?]> = [
      ['friend:list', '/social/friends'],
      ['friend:requests', '/social/friends/requests'],
      ['presence:friends', '/social/presence'],
      ['social:getSettings', '/social/settings'],
      ['notification:counts', '/social/notifications/counts'],
      ['notification:list', '/social/notifications'],
      ['dm:conversations', '/social/dm'],
      ['lobby:invites', '/social/lobby-invites'],
    ];
    for (const [event, route] of pairs) {
      const viaSocket = await b.emitAck(event);
      const viaRest = await api(hub, b.user, 'GET', route);
      const { ok: _ok, ...socketPart } = viaSocket;
      expect(viaRest.status, route).toBe(200);
      expect(viaRest.body, route).toEqual(socketPart);
    }
    closeAll(a, b);
  });

  it('Node-SDK: Freunde, DMs, Sync und Events', async () => {
    const name = () => `sdks${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
    const a = new EthernalClient({ serverUrl: hub.url });
    const b = new EthernalClient({ serverUrl: hub.url });
    const ua = await a.register(name(), 'password123');
    const ub = await b.register(name(), 'password123');
    await sleep(300);
    const gotRequest = new Promise<{ request: { id: string } }>((resolve) => b.once('friend:requestReceived', resolve));
    expect(await a.requestFriendByName(ub.user.username)).toBe('REQUEST_SENT');
    expect(await a.requestFriendByName('nobody-sdk-xyz')).toBe('NO_SUCH_PLAYER');
    await b.respondFriendRequest((await gotRequest).request.id, true);
    expect((await a.listFriends()).map((f) => f.userId)).toEqual([ub.user.id]);

    const received = new Promise<{ text: string }>((resolve) => b.once('dm:received', resolve));
    await a.sendDirectMessage(ub.user.id, 'sdk hi');
    expect((await received).text).toBe('sdk hi');
    expect((await b.listConversations())[0].lastMessage.text).toBe('sdk hi');
    const snap = await b.syncSocial();
    expect('notModified' in snap).toBe(false);
    expect(await b.syncSocial((snap as { etag: string }).etag)).toMatchObject({ notModified: true });
    await a.setSocialSettings({ status: 'busy' });
    expect((await a.getSocialSettings()).status).toBe('busy');
    await a.logout();
    await b.logout();
    void ua;
  });
});

describe('friend_online notification', () => {
  it('geht an online-Freunde beim Online-Wechsel; Offline-Freunde und Fremde bekommen nichts; invisible löst nichts aus', async () => {
    const [a, b, c, stranger] = [await live(hub), await live(hub), await live(hub), await live(hub)];
    await befriend(a, b);
    await befriend(a, c);
    c.close(); // c ist offline
    await sleep(100);
    a.close();
    await sleep(200);
    const a2 = await reconnect(hub, a);
    const n = await b.waitFor('notification', (x) => x.type === 'friend_online' && x.payload.userId === a.user.userId);
    expect(n.payload.username).toBe(a.user.username);
    expect(stranger.count('notification', (x) => x.type === 'friend_online')).toBe(0);
    // c war offline → kein Backlog-Eintrag
    const c2 = await reconnect(hub, c);
    const list = (await c2.emitAck('notification:list')).notifications ?? [];
    expect(list.filter((x: any) => x.type === 'friend_online' && x.payload.userId === a.user.userId)).toHaveLength(0);
    // invisible → offline-Wechsel unsichtbar, Rückkehr zu online erzeugt (wieder) Notification
    await a2.emitAck('social:setSettings', { status: 'invisible' });
    await b.waitFor('friend:presence', (p) => p.userId === a.user.userId && p.online === false);
    const before = b.count('notification', (x) => x.type === 'friend_online');
    await a2.emitAck('social:setSettings', { status: 'online' });
    await sleep(300);
    expect(b.count('notification', (x) => x.type === 'friend_online')).toBe(before + 1);
    closeAll(a2, b, c2, stranger);
  });

  it('Mute-Einstellung unterdrückt friend_online', async () => {
    const [a, b] = [await live(hub), await live(hub)];
    await befriend(a, b);
    await b.emitAck('social:setSettings', { mutedNotificationTypes: ['friend_online'] });
    a.close();
    await sleep(200);
    const a2 = await reconnect(hub, a);
    await sleep(400);
    expect(b.count('notification', (x) => x.type === 'friend_online')).toBe(0);
    closeAll(a2, b);
  });
});
