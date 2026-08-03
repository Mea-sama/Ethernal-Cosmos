/// <reference types="node" />

/**
 * Security visibility check:
 * - same lobby can read lobby+public data
 * - different/non-lobby users can only read public data
 *
 * Run:
 *   npx ts-node --project test/tsconfig.json test/security-visibility.ts [serverUrl]
 */

import { EthernalClient } from '../sdk/src/EthernalClient';

const SERVER = process.argv[2] ?? 'https://mea-sama.duckdns.org:12346';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('bad gateway') ||
    msg.includes('gateway timeout') ||
    msg.includes('service unavailable') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('socket hang up') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout')
  );
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 4,
  baseDelayMs = 300,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isTransientError(err)) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`${label} failed: ${message}`);
      }
      const backoff = baseDelayMs * attempt;
      console.warn(`${label}: transient error on attempt ${attempt}/${maxAttempts}, retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label}: unknown error`);
}

async function resolveGameId(server: string): Promise<string> {
  const res = await withRetry('resolveGameId', async () => fetch(`${server}/api/games`));
  if (!res.ok) {
    throw new Error(`Could not fetch /api/games: HTTP ${res.status}`);
  }
  const games = (await res.json()) as Array<{ id: string }>;
  if (!Array.isArray(games) || games.length === 0) {
    throw new Error('No games registered on server');
  }
  return games[0].id;
}

async function createAndLogin(client: EthernalClient, username: string, password: string): Promise<void> {
  await withRetry(`register ${username}`, async () => {
    await client.register(username, password).catch(() => {
      // If user already exists from a previous run, login path still works.
    });
  });
  await withRetry(`login ${username}`, async () => client.login(username, password));
}

async function run(): Promise<void> {
  const suffix = Date.now();
  const password = 'password123';

  const alice = new EthernalClient({ serverUrl: SERVER });
  const bob = new EthernalClient({ serverUrl: SERVER });
  const carol = new EthernalClient({ serverUrl: SERVER });

  try {
    await createAndLogin(alice, `sec_alice_${suffix}`, password);
    await createAndLogin(bob, `sec_bob_${suffix}`, password);
    await createAndLogin(carol, `sec_carol_${suffix}`, password);

    const gameId = await resolveGameId(SERVER);

    const lobby = await withRetry('createLobby', async () => alice.createLobby({ gameId, name: `sec-${suffix}` }));
    await withRetry('joinLobby', async () => bob.joinLobby(lobby.id));
    await sleep(250);

    await withRetry('set private key', async () => alice.setKey(gameId, 'privateSecret', 'only-alice', 'private'));
    await withRetry('set lobby key', async () => alice.setKey(gameId, 'lobbySecret', 'alice-lobby', 'lobby'));
    await withRetry('set public key', async () => alice.setKey(gameId, 'publicScore', 99, 'public'));

    await sleep(250);

    const lobbyInfo = await withRetry('getLobbyInfo', async () => alice.getLobbyInfo());
    const aliceUserId = lobbyInfo.players.find((p) => p.username.startsWith('sec_alice_'))?.userId;
    assert(!!aliceUserId, 'Could not resolve Alice userId from lobby info');

    const bobView = await withRetry('bob getPlayerData', async () => bob.getPlayerData(aliceUserId!, gameId));
    const bobKeys = new Set(bobView.map((e) => e.key));

    assert(bobKeys.has('publicScore'), 'Same lobby should see public data');
    assert(bobKeys.has('lobbySecret'), 'Same lobby should see lobby data');
    assert(!bobKeys.has('privateSecret'), 'Same lobby must not see private data');

    const carolView = await withRetry('carol getPlayerData', async () => carol.getPlayerData(aliceUserId!, gameId));
    const carolKeys = new Set(carolView.map((e) => e.key));

    assert(carolKeys.has('publicScore'), 'Different lobby should see public data');
    assert(!carolKeys.has('lobbySecret'), 'Different lobby must not see lobby data');
    assert(!carolKeys.has('privateSecret'), 'Different lobby must not see private data');

    console.log('Security visibility check passed');
  } finally {
    await alice.logout().catch(() => undefined);
    await bob.logout().catch(() => undefined);
    await carol.logout().catch(() => undefined);
  }
}

run().catch((err) => {
  console.error('Security visibility check failed:', err.message ?? err);
  process.exit(1);
});
