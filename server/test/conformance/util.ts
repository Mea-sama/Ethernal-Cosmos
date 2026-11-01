import { connectGameServer, connectRegistered, issueServerKey, registerUser, type GsClient, type TestClient, type TestHub } from '../helpers/hub';

export * from '../helpers/hub';

/** Fast social timings shared by all conformance hubs */
export const FAST_SOCIAL = { FRIEND_NAME_LOOKUP_MIN_MS: '20', SOCIAL_PURGE_INTERVAL_MS: '300' };

export const live = async (h: TestHub, game = 'relay'): Promise<TestClient> => connectRegistered(h, await registerUser(h, 'cf'), game);

export const closeAll = (...cs: Array<TestClient | { close(): void }>): void => cs.forEach((c) => c.close());

/** Full friend handshake by username; resolves once both sides see the friendship */
export async function befriend(a: TestClient, b: TestClient): Promise<void> {
  const res = await a.emitAck('friend:request', { username: b.user.username });
  if (res.result !== 'REQUEST_SENT') throw new Error(`friend:request failed: ${JSON.stringify(res)}`);
  await b.waitFor('friend:requestReceived', (e) => e.request.user.userId === a.user.userId);
  const request = (await b.emitAck('friend:requests')).incoming.find((r: any) => r.user.userId === a.user.userId);
  const ok = await b.emitAck('friend:respond', { requestId: request.id, accept: true });
  if (!ok.ok) throw new Error(`friend:respond failed: ${JSON.stringify(ok)}`);
  await a.waitFor('friend:requestAccepted', (e) => e.friend.userId === b.user.userId);
}

/** Returns the `lobbyUpdated` payload carrying the given reason (second event argument) */
export async function updatedWith(
  c: { events: Array<{ event: string; args: any[] }> },
  reason: string,
  pred: (l: any) => boolean = () => true,
  timeoutMs = 5000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const e = c.events.find((x) => x.event === 'lobbyUpdated' && x.args[1] === reason && pred(x.args[0]));
    if (e) return e.args[0];
    if (Date.now() > deadline) throw new Error(`timeout waiting for lobbyUpdated/${reason}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const ipcEvent = (type: string) => (e: any): boolean => e.type === 'ipc' && e.data.type === type;

let serverCounter = 0;
export const serverId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${serverCounter++}`;

/** Issues a key and connects a fake game server for `gameId` */
export async function gameServer(
  hub: TestHub,
  gameId: string,
  opts: { region?: string; capacity?: number; serverId?: string } = {},
): Promise<GsClient> {
  const { key } = await issueServerKey(hub, gameId);
  return connectGameServer(hub, { serverKey: key, gameId, serverId: opts.serverId ?? serverId('srv'), region: opts.region, capacity: opts.capacity });
}
