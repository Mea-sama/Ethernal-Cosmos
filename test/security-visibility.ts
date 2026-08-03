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

async function createAndLogin(client: EthernalClient, username: string, password: string): Promise<void> {
  await client.register(username, password).catch(() => {
    // If user already exists from a previous run, login path still works.
  });
  await client.login(username, password);
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

    const lobby = await alice.createLobby({ gameId: 'tictactoe', name: `sec-${suffix}` });
    await bob.joinLobby(lobby.id);
    await sleep(250);

    await alice.setKey('tictactoe', 'privateSecret', 'only-alice', 'private');
    await alice.setKey('tictactoe', 'lobbySecret', 'alice-lobby', 'lobby');
    await alice.setKey('tictactoe', 'publicScore', 99, 'public');

    await sleep(250);

    const bobView = await bob.getPlayerData((await alice.getLobbyInfo()).players.find((p) => p.username.startsWith('sec_alice_'))?.userId ?? '', 'tictactoe');
    const bobKeys = new Set(bobView.map((e) => e.key));

    assert(bobKeys.has('publicScore'), 'Same lobby should see public data');
    assert(bobKeys.has('lobbySecret'), 'Same lobby should see lobby data');
    assert(!bobKeys.has('privateSecret'), 'Same lobby must not see private data');

    const aliceUserId = (await alice.getLobbyInfo()).players.find((p) => p.username.startsWith('sec_alice_'))!.userId;
    const carolView = await carol.getPlayerData(aliceUserId, 'tictactoe');
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
