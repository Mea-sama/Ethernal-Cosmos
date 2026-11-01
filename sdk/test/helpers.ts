import { EthernalClient } from '../src';
import type { AuthResult } from '../src';
import type { TestHub } from '../../server/test/helpers/hub';

let counter = 0;
export const uname = (prefix = 'u'): string => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const PASSWORD = 'password123';

/** Every event name an EthernalClient can emit (lifecycle + forwarded hub events). */
export const EVENTS = [
  'connected', 'disconnected', 'authError', 'serverError',
  'hello', 'session:resumed', 'session:replaced', 'errorDetail',
  'lobbyCreated', 'lobbyUpdated', 'lobbyList', 'lobbyInfo', 'gameStarting', 'gameState', 'gameEvent', 'gameOver', 'gameCrashed',
  'playerKicked', 'message', 'messageBinary', 'userData', 'playerData',
  'friend:presence', 'friend:requestReceived', 'friend:requestAccepted', 'friend:requestDeclined', 'friend:requestCancelled', 'friend:removed',
  'notification', 'notification:backlog', 'dm:received', 'dm:delivered', 'dm:read', 'dm:readState', 'dm:typing',
  'lobby:inviteReceived', 'lobby:inviteCancelled', 'lobby:inviteDeclined',
  'joinRequestReceived', 'joinRequestPending', 'joinRequestAccepted', 'joinRequestRejected', 'joinRequestWithdrawn',
] as const;

/** Buffers every emitted event so tests can wait for events that may already have fired. */
export class Recorder {
  readonly events: Array<{ event: string; args: any[] }> = [];
  constructor(client: EthernalClient) {
    for (const event of EVENTS) client.on(event as any, (...args: any[]) => this.events.push({ event, args }));
  }

  /** Resolves with the args of the first matching event (also from the past). */
  async waitFor<T extends any[] = any[]>(event: string, pred: (...args: T) => boolean = () => true, timeoutMs = 6000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find((e) => e.event === event && pred(...(e.args as T)));
      if (hit) return hit.args as T;
      if (Date.now() > deadline) throw new Error(`Timeout waiting for "${event}"; got: ${this.events.map((e) => e.event).join(',')}`);
      await sleep(20);
    }
  }

  count(event: string, pred: (...args: any[]) => boolean = () => true): number {
    return this.events.filter((e) => e.event === event && pred(...e.args)).length;
  }

  /** lobbyUpdated with the given `reason` (second argument). */
  updated(reason: string, pred: (lobby: any) => boolean = () => true, timeoutMs?: number): Promise<any[]> {
    return this.waitFor('lobbyUpdated', (l: any, r: any) => r === reason && pred(l), timeoutMs);
  }
}

export interface Player {
  client: EthernalClient;
  rec: Recorder;
  username: string;
  userId: string;
  auth: AuthResult;
}

/** Creates and tracks clients so a test can close them all in `afterEach`/`finally`. */
export class Fleet {
  private readonly players: Player[] = [];
  constructor(private readonly hub: TestHub) {}

  /** Registers a new user (unique name) and optionally registers a game. */
  async player(gameId?: string, prefix = 'p'): Promise<Player> {
    const client = new EthernalClient({ serverUrl: this.hub.url });
    const rec = new Recorder(client);
    const username = uname(prefix);
    const auth = await client.register(username, PASSWORD);
    const p: Player = { client, rec, username, userId: auth.user.id, auth };
    this.players.push(p);
    if (gameId) await client.registerGame(gameId);
    return p;
  }

  /** Wraps a client the test created itself. */
  track(client: EthernalClient): EthernalClient {
    this.players.push({ client } as Player);
    return client;
  }

  /** Leaves every player's lobby (best effort) so lobbies close and do not leak into later tests. */
  async leaveAll(): Promise<void> {
    await Promise.all(this.players.map((p) => p.client.leaveLobby().catch(() => undefined)));
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.players.splice(0).map((p) => p.client.logout().catch(() => undefined)));
  }
}

/** Makes two players friends via the SDK (request by name + accept). */
export async function befriend(a: Player, b: Player): Promise<void> {
  await a.client.requestFriendByName(b.username);
  let id: string | undefined;
  for (let i = 0; i < 100 && !id; i++) {
    id = (await b.client.listFriendRequests()).incoming.find((r) => r.user.userId === a.userId)?.id;
    if (!id) await sleep(30);
  }
  await b.client.respondFriendRequest(id!, true);
  await a.rec.waitFor('friend:requestAccepted', (d: any) => d.friend.userId === b.userId);
}

export async function rejectsWith(p: Promise<unknown>): Promise<{ code: string; name: string; message: string }> {
  try {
    await p;
  } catch (e: any) {
    return e;
  }
  throw new Error('expected promise to reject');
}
