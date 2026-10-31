import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectClient, registerUser, sleep, startHub, type TestHub } from './helpers/hub';

let hub: TestHub;
beforeAll(async () => {
  hub = await startHub({ env: { ACCESS_TOKEN_TTL_SECONDS: '2', AUTH_EXPIRY_GRACE_MS: '300' } });
});
afterAll(async () => { await hub.stop(); });

const post = (route: string, body: unknown, token?: string) =>
  fetch(`${hub.url}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

describe('Auth-Lebenszyklus (#20)', () => {
  it('Socket ohne Refresh bekommt AUTH_EXPIRED und wird getrennt', async () => {
    const c = await connectClient(hub, await registerUser(hub));
    const detail = await c.waitFor('errorDetail', (d: any) => d.code === 'AUTH_EXPIRED', 4000);
    expect(detail.code).toBe('AUTH_EXPIRED');
    await new Promise<void>((r) => (c.socket.connected ? c.socket.once('disconnect', () => r()) : r()));
    expect(c.socket.connected).toBe(false);
  });

  it('auth:refresh hält den Socket am Leben', async () => {
    const user = await registerUser(hub);
    const c = await connectClient(hub, user);
    await sleep(1000);
    const res = await (await post('/auth/refresh', { refreshToken: user.refreshToken })).json();
    const ack = await c.emitAck('auth:refresh', { token: res.accessToken });
    expect(ack.ok).toBe(true);
    await sleep(1600); // ursprünglicher Token wäre inkl. Gnadenfrist bereits tot
    expect(c.socket.connected).toBe(true);
    expect(c.count('errorDetail', (d: any) => d.code === 'AUTH_EXPIRED')).toBe(0);
    c.close();
  });

  it('auth:refresh mit Token eines anderen Users wird abgelehnt', async () => {
    const c = await connectClient(hub, await registerUser(hub));
    const other = await registerUser(hub);
    const ack = await c.emitAck('auth:refresh', { token: other.accessToken });
    expect(ack).toMatchObject({ ok: false, error: { code: 'INVALID_TOKEN' } });
    c.close();
  });

  it('Logout trennt alle Sockets des Users', async () => {
    const user = await registerUser(hub);
    const c = await connectClient(hub, user);
    expect((await post('/auth/logout', { refreshToken: user.refreshToken })).status).toBe(204);
    await new Promise<void>((r) => (c.socket.connected ? c.socket.once('disconnect', () => r()) : r()));
    expect(c.socket.connected).toBe(false);
  });

  it('logout-all widerruft Refresh-Tokens und trennt Sockets', async () => {
    const user = await registerUser(hub);
    const c = await connectClient(hub, user);
    expect((await post('/auth/logout-all', {}, user.accessToken)).status).toBe(204);
    await new Promise<void>((r) => (c.socket.connected ? c.socket.once('disconnect', () => r()) : r()));
    expect(c.socket.connected).toBe(false);
    expect((await post('/auth/refresh', { refreshToken: user.refreshToken })).status).toBe(401);
  });

  it('Benutzernamen sind case-insensitiv eindeutig; Login case-insensitiv', async () => {
    const name = `CaseUser${Date.now().toString(36)}`;
    const reg = (n: string) => post('/auth/register', { username: n, password: 'password123' });
    expect((await reg(name)).status).toBe(201);
    const dup = await reg(name.toLowerCase());
    expect(dup.status).toBe(409);
    const login = await post('/auth/login', { username: name.toUpperCase(), password: 'password123' });
    expect(login.status).toBe(200);
    expect((await login.json()).user.username).toBe(name);
  });
});
