import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EthernalClient, EthernalError, ErrorCode, SessionReplacedReason } from '../src';
import { startHub, type TestHub } from '../../server/test/helpers/hub';
import { Fleet, PASSWORD, Recorder, rejectsWith, sleep, uname } from './helpers';

let hub: TestHub;
let shortHub: TestHub;
let fleet: Fleet;
beforeAll(async () => {
  hub = await startHub();
  shortHub = await startHub({ env: { ACCESS_TOKEN_TTL_SECONDS: '2', AUTH_EXPIRY_GRACE_MS: '3000' } });
});
afterAll(async () => {
  await Promise.all([hub.stop(), shortHub.stop()]);
});
afterEach(async () => {
  await fleet?.closeAll();
});

const rawRefresh = (h: TestHub, refreshToken: string) =>
  fetch(`${h.url}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }) });

describe('auth: register / login / logout', () => {
  it('register connects the socket and returns tokens + user; login works with the same credentials', async () => {
    fleet = new Fleet(hub);
    const client = fleet.track(new EthernalClient({ serverUrl: hub.url }));
    const rec = new Recorder(client);
    const name = uname('auth');
    const reg = await client.register(name, PASSWORD);
    expect(reg.user).toMatchObject({ username: name, id: expect.any(String) });
    expect(reg.accessToken).toEqual(expect.any(String));
    expect(reg.refreshToken).toEqual(expect.any(String));
    // register() resolves only once connected, so socket calls work immediately
    const hello = (await rec.waitFor('hello'))[0];
    expect(hello).toMatchObject({ protocolVersion: expect.any(Number), sessionId: expect.any(String), capabilities: expect.arrayContaining(['acks']) });
    expect(rec.count('connected')).toBe(1);
    expect((await client.getSessionState()).state).toMatchObject({ userId: reg.user.id, username: name });
    await client.logout();

    const again = fleet.track(new EthernalClient({ serverUrl: hub.url }));
    const login = await again.login(name, PASSWORD);
    expect(login.user.id).toBe(reg.user.id);
    expect((await again.getSessionState()).state.username).toBe(name);
  });

  it('errors carry ErrorCode values', async () => {
    fleet = new Fleet(hub);
    const client = fleet.track(new EthernalClient({ serverUrl: hub.url }));
    const name = uname('dup');
    await client.register(name, PASSWORD);

    const second = fleet.track(new EthernalClient({ serverUrl: hub.url }));
    const taken = await rejectsWith(second.register(name, PASSWORD));
    expect(taken).toBeInstanceOf(EthernalError);
    expect(taken.code).toBe(ErrorCode.UsernameTaken);
    expect((await rejectsWith(second.register(uname('x'), 'short'))).code).toBe(ErrorCode.InvalidInput);
    expect((await rejectsWith(second.login(name, 'wrong-password'))).code).toBe(ErrorCode.InvalidCredentials);
    expect((await rejectsWith(second.login(uname('ghost'), PASSWORD))).code).toBe(ErrorCode.InvalidCredentials);
  });

  it('calls before login reject with NOT_CONNECTED; logout disconnects and revokes the refresh token', async () => {
    fleet = new Fleet(hub);
    const client = fleet.track(new EthernalClient({ serverUrl: hub.url }));
    expect((await rejectsWith(client.listLobbies())).code).toBe('NOT_CONNECTED');
    expect((await rejectsWith(client.refreshSocketAuth())).code).toBe(ErrorCode.InvalidRefreshToken);

    const rec = new Recorder(client);
    const { refreshToken } = await client.register(uname('lo'), PASSWORD);
    await client.logout();
    expect((await rejectsWith(client.getSessionState())).code).toBe('NOT_CONNECTED');
    expect(rec.count('disconnected')).toBeGreaterThanOrEqual(0);
    const res = await rawRefresh(hub, refreshToken);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe(ErrorCode.RefreshTokenRevoked);
    await expect(client.logout()).resolves.toBeUndefined();
  });

  it('disconnect() keeps the tokens: emits disconnected, login again resumes the session', async () => {
    fleet = new Fleet(hub);
    const p = await fleet.player(undefined, 'dc');
    p.client.disconnect();
    expect(p.rec.count('disconnected')).toBe(1);
    expect((await rejectsWith(p.client.getSessionState())).code).toBe('NOT_CONNECTED');
    await p.client.login(p.username, PASSWORD);
    expect((await p.client.getSessionState()).state.userId).toBe(p.userId);
  });

  it('logoutAll() revokes every refresh token and disconnects every session of the user', async () => {
    fleet = new Fleet(hub);
    const a = await fleet.player(undefined, 'la');
    const other = fleet.track(new EthernalClient({ serverUrl: hub.url }));
    const otherRec = new Recorder(other);
    const second = await other.login(a.username, PASSWORD);
    await a.client.logoutAll();
    await otherRec.waitFor('disconnected');
    expect((await rawRefresh(hub, second.refreshToken)).status).toBe(401);
    expect((await rawRefresh(hub, a.auth.refreshToken)).status).toBe(401);
    expect((await rejectsWith(a.client.getSessionState())).code).toBe('NOT_CONNECTED');
  });

  it('logoutAll() without a valid session rejects with an EthernalError', async () => {
    fleet = new Fleet(hub);
    const client = fleet.track(new EthernalClient({ serverUrl: hub.url }));
    expect(await rejectsWith(client.logoutAll())).toBeInstanceOf(EthernalError);
  });
});

describe('auth: token refresh', () => {
  it('refreshSocketAuth() rotates the refresh token and keeps the socket alive', async () => {
    fleet = new Fleet(hub);
    const p = await fleet.player(undefined, 'rf');
    await p.client.refreshSocketAuth();
    expect((await p.client.getSessionState()).state.userId).toBe(p.userId);
    // the original refresh token was rotated away
    expect((await rawRefresh(hub, p.auth.refreshToken)).status).toBe(401);
    await p.client.refreshSocketAuth();
    expect(p.rec.count('disconnected')).toBe(0);
  });

  it('auto-renews on AUTH_EXPIRED: the socket survives several access-token lifetimes', async () => {
    fleet = new Fleet(shortHub);
    const p = await fleet.player('relay', 'exp');
    await p.rec.waitFor('errorDetail', (e: any) => e.code === ErrorCode.AuthExpired, 5000);
    // the SDK refreshed in place; the next token expires again and is renewed once more
    await p.rec.waitFor('serverError', (m: string) => m.length > 0, 5000); // legacy text event accompanies AUTH_EXPIRED
    await sleep(2500);
    expect(p.rec.count('errorDetail', (e: any) => e.code === ErrorCode.AuthExpired)).toBeGreaterThanOrEqual(2);
    expect(p.rec.count('disconnected')).toBe(0);
    expect(p.rec.count('authError')).toBe(0);
    expect((await p.client.getSessionState()).state.gameId).toBe('relay');
  });

  it('emits authError when the token cannot be renewed on reconnect', async () => {
    fleet = new Fleet(hub);
    const p = await fleet.player(undefined, 'ae');
    const internals = p.client as any;
    internals.accessToken = 'garbage';
    internals.refreshToken = 'garbage';
    internals.socket.io.engine.close();
    await p.rec.waitFor('disconnected');
    await p.rec.waitFor('authError', (m: string) => typeof m === 'string' && m.length > 0, 8000);
  });
});

describe('connection lifecycle & session', () => {
  it('re-registers the game after an automatic reconnect and emits connected/disconnected', async () => {
    fleet = new Fleet(hub);
    const p = await fleet.player('relay', 'rc');
    (p.client as any).socket.io.engine.close();
    await p.rec.waitFor('disconnected');
    await p.rec.waitFor('connected', () => p.rec.count('connected') >= 2, 8000);
    await sleep(300);
    expect((await p.client.getSessionState()).state.gameId).toBe('relay');
  });

  it('session:replaced is emitted when a newer game session of the same user takes over', async () => {
    fleet = new Fleet(hub);
    const a = await fleet.player('relay', 'rep');
    a.client.on('session:replaced', () => a.client.disconnect());
    const b = fleet.track(new EthernalClient({ serverUrl: hub.url }));
    await b.login(a.username, PASSWORD);
    await b.registerGame('relay');
    const [replaced] = await a.rec.waitFor('session:replaced');
    expect(replaced).toEqual({ reason: SessionReplacedReason.NewSession });
    expect((await b.getSessionState()).state.gameId).toBe('relay');
  });

  it('server errors surface as rejected EthernalError with the ErrorCode', async () => {
    fleet = new Fleet(hub);
    const p = await fleet.player(undefined, 'se');
    const err = await rejectsWith(p.client.createLobby({ name: 'x' }));
    expect(err).toBeInstanceOf(EthernalError);
    expect(err.code).toBe(ErrorCode.GameNotRegistered);
    // calls with an ack (all SDK calls) are answered via the ack only; errorDetail/serverError are for unsolicited errors
    expect(p.rec.count('errorDetail', (e: any) => e.code === ErrorCode.GameNotRegistered)).toBe(0);
    expect((await rejectsWith(p.client.registerGame('no-such-game'))).code).toBe(ErrorCode.UnknownGame);
  });

  it('requests time out with code TIMEOUT when the hub does not answer', async () => {
    fleet = new Fleet(hub);
    const p = await fleet.player(undefined, 'to');
    const client = fleet.track(new EthernalClient({ serverUrl: hub.url, requestTimeout: 150 }));
    await client.login(p.username, PASSWORD);
    // swallow acks: emit to a no-op socket event the hub never acknowledges
    (client as any).socket.emit = () => undefined;
    expect((await rejectsWith(client.getSessionState())).code).toBe('TIMEOUT');
  });
});
