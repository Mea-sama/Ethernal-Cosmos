import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { io as connect, type Socket } from 'socket.io-client';

const REPO_ROOT = path.resolve(__dirname, '../../..');

export interface TestHub {
  url: string;
  dataDir: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Spiele für Tests (zusätzlich zu den eingebauten) */
const TEST_GAMES = [
  { id: 'fake', name: 'Fake', maxPlayers: 3, entryScript: path.join(__dirname, '../fixtures/fake-game.js'), reconnectGraceMs: 1500, serverKeys: ['rank\\..*'], publicSettingKeys: ['mode'] },
  { id: 'evil', name: 'Evil', maxPlayers: 3, entryScript: path.join(__dirname, '../fixtures/evil-game.js'), reconnectGraceMs: 1500 },
  { id: 'relay', name: 'Relay', maxPlayers: 2, reconnectGraceMs: 1500 },
  { id: 'relay-nograce', name: 'Relay no grace', maxPlayers: 4, reconnectGraceMs: 0 },
  { id: 'broken', name: 'Broken', maxPlayers: 2, entryScript: '/nonexistent/game.js' },
  { id: 'other', name: 'Other', maxPlayers: 4, reconnectGraceMs: 1500 },
  { id: 'gs-opt', name: 'GS optional', maxPlayers: 4, reconnectGraceMs: 1500, serverSupport: 'optional', regions: ['eu', 'us'] },
  { id: 'gs-req', name: 'GS required', maxPlayers: 4, reconnectGraceMs: 1500, serverSupport: 'required', regions: ['eu', 'us'] },
];

/** Großzügige Limits, damit Tests nicht in Rate-Limits laufen; einzelne Tests überschreiben via `limits`. */
export async function startHub(opts: { limits?: Record<string, unknown>; env?: Record<string, string> } = {}): Promise<TestHub> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ethernal-test-'));
  const gamesPath = path.join(dataDir, 'games.json');
  const limitsPath = path.join(dataDir, 'limits.json');
  fs.writeFileSync(gamesPath, JSON.stringify(TEST_GAMES));
  const big = { refillPerSecond: 1000, burst: 100000 };
  fs.writeFileSync(
    limitsPath,
    JSON.stringify({
      authRateLimits: {
        login: { windowMs: 60000, max: 10000, message: 'x' },
        register: { windowMs: 60000, max: 10000, message: 'x' },
        refresh: { windowMs: 60000, max: 10000, message: 'x' },
      },
      socketLimits: Object.fromEntries(
        ['createLobby', 'joinLobby', 'joinLobbyByCode', 'kickPlayer', 'transferHost', 'lockLobby', 'unlockLobby', 'requestJoinLobby',
         'requestJoinLobbyByCode', 'cancelJoinRequest', 'respondJoinRequest', 'listLobbies', 'getLobbyInfo', 'presenceList', 'getUserData',
         'getPlayerData', 'gameAction', 'registerGame', 'sessionState', 'setUserData', 'bulkSetUserData', 'deleteUserData', 'leaveLobby',
         'friendRequestByName', 'friendRequest', 'friendAction', 'socialRead', 'socialSettings', 'notificationWrite', 'dmSend', 'dmTyping',
         'lobbyInvite', 'lobbyInviteAction', 'authRefresh', 'setLobbyState']
          .map((k) => [k, big])
      ),
      ...opts.limits,
    })
  );

  const port = await freePort();
  const proc: ChildProcess = spawn('node', [path.join(REPO_ROOT, 'server/dist/index.js')], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      GAMES_CONFIG_PATH: gamesPath,
      LIMITS_CONFIG_PATH: limitsPath,
      BCRYPT_ROUNDS: '4',
      JWT_SECRET: 'test-secret',
      ADMIN_TOKEN: 'admin-test',
      SERVER_RESUME_GRACE_MS: '1500',
      SERVER_ASSIGN_TIMEOUT_MS: '800',
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  proc.stdout?.on('data', (d) => (log += d));
  proc.stderr?.on('data', (d) => (log += d));

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch {
      /* noch nicht bereit */
    }
    if (proc.exitCode !== null) throw new Error(`Hub beendet: ${log}`);
    if (Date.now() > deadline) throw new Error(`Hub-Start Timeout: ${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    url,
    dataDir,
    async stop() {
      proc.kill('SIGTERM');
      await new Promise((r) => proc.once('exit', r));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

let counter = 0;
export interface TestUser {
  username: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
}

export async function registerUser(hub: TestHub, name = 'user'): Promise<TestUser> {
  const username = `${name}${Date.now().toString(36)}${counter++}`;
  const res = await fetch(`${hub.url}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'password123' }),
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { username, userId: body.user.id, accessToken: body.accessToken, refreshToken: body.refreshToken };
}

export async function api(hub: TestHub, user: TestUser, method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${hub.url}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.accessToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/** Socket mit Event-Puffer, damit Tests deterministisch auf Events warten können */
export class TestClient {
  readonly events: Array<{ event: string; args: any[] }> = [];
  constructor(readonly socket: Socket, readonly user: TestUser) {
    socket.onAny((event, ...args) => {
      this.events.push({ event, args });
    });
  }

  emitAck<T = any>(event: string, data?: unknown): Promise<T> {
    return new Promise((resolve) => {
      if (data === undefined) this.socket.emit(event, resolve);
      else this.socket.emit(event, data, resolve);
    });
  }

  async waitFor<T = any>(event: string, pred: (arg: T) => boolean = () => true, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let idx = 0;
    for (;;) {
      for (; idx < this.events.length; idx++) {
        const e = this.events[idx];
        if (e.event === event && pred(e.args[0])) return e.args[0];
      }
      if (Date.now() > deadline) throw new Error(`Timeout waiting for "${event}"; got: ${this.events.map((e) => e.event).join(',')}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  count(event: string, pred: (arg: any) => boolean = () => true): number {
    return this.events.filter((e) => e.event === event && pred(e.args[0])).length;
  }

  close(): void {
    this.socket.close();
  }
}

export async function connectClient(hub: TestHub, user: TestUser, clientType: 'game' | 'panel' = 'game'): Promise<TestClient> {
  const socket = connect(hub.url, {
    auth: { token: `Bearer ${user.accessToken}`, clientType },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  const client = new TestClient(socket, user);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (e) => reject(e));
  });
  await client.waitFor('hello');
  return client;
}

export async function connectRegistered(hub: TestHub, user: TestUser, gameId: string): Promise<TestClient> {
  const c = await connectClient(hub, user);
  const res = await c.emitAck('session:registerGame', { gameId });
  if (!res.ok) throw new Error(`registerGame failed: ${JSON.stringify(res)}`);
  return c;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── Game-Server-Client (Namespace /gameserver) ──────────────────────────────

export async function issueServerKey(hub: TestHub, gameId: string): Promise<{ id: string; key: string }> {
  const res = await fetch(`${hub.url}/admin/game-servers/${gameId}/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-test' },
    body: JSON.stringify({ label: 'test' }),
  });
  if (res.status !== 201) throw new Error(`issue key failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export class GsClient {
  readonly events: Array<{ event: string; args: any[] }> = [];
  /** Verhalten bei lobby:assigned: true = annehmen, false = ablehnen, 'ignore' = nie antworten */
  assignBehaviour: boolean | 'ignore' = true;
  constructor(readonly socket: Socket) {
    socket.onAny((event, ...args) => this.events.push({ event, args }));
    socket.on('lobby:assigned', (_data: unknown, ack: (r: { accept: boolean }) => void) => {
      if (this.assignBehaviour !== 'ignore') ack({ accept: this.assignBehaviour });
    });
  }
  emitAck<T = any>(event: string, data?: unknown): Promise<T> {
    return new Promise((resolve) => this.socket.emit(event, data, resolve));
  }
  async waitFor<T = any>(event: string, pred: (arg: T) => boolean = () => true, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let idx = 0;
    for (;;) {
      for (; idx < this.events.length; idx++) {
        const e = this.events[idx];
        if (e.event === event && pred(e.args[0])) return e.args[0];
      }
      if (Date.now() > deadline) throw new Error(`GS timeout waiting for "${event}"; got: ${this.events.map((e) => e.event).join(',')}`);
      await sleep(20);
    }
  }
  count(event: string, pred: (arg: any) => boolean = () => true): number {
    return this.events.filter((e) => e.event === event && pred(e.args[0])).length;
  }
  close(): void {
    this.socket.close();
  }
}

export async function connectGameServer(
  hub: TestHub,
  auth: { serverKey: string; gameId: string; serverId: string; region?: string; capacity?: number },
): Promise<GsClient> {
  const socket = connect(`${hub.url}/gameserver`, {
    auth: { ...auth, capacity: auth.capacity ?? 2 },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  const client = new GsClient(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (e) => reject(e));
  });
  await client.waitFor('hello');
  return client;
}
