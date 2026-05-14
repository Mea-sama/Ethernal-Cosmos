/**
 * Ethernal Cosmos — Integrationstest
 *
 * Testet den kompletten Flow:
 *   Register → Login → Create Lobby → Join (2. Client) → Relay → UserData → Logout
 *
 * Ausführen:
 *   cd "e:\Ethernal Cosmos"
 *   npx ts-node --project test/tsconfig.json test/integration.ts [serverUrl]
 *
 * Standard-URL: https://mea-sama.duckdns.org:12346
 * Lokal testen:  npx ts-node ... http://localhost:12348
 */

import { EthernalClient } from '../sdk/src/EthernalClient';

const SERVER = process.argv[2] ?? 'https://mea-sama.duckdns.org:12346';

let passed = 0;
let failed = 0;

function ok(label: string, value: unknown) {
  if (value) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}  (got: ${JSON.stringify(value)})`);
    failed++;
  }
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  console.log(`\nEthernal Cosmos Integration Test`);
  console.log(`Server: ${SERVER}\n`);

  const alice = new EthernalClient(SERVER);
  const bob   = new EthernalClient(SERVER);

  // ── 1. Register ───────────────────────────────────────────────────────────
  console.log('1. Register');
  const suffix = Date.now();
  const aliceReg = await alice.register(`alice_${suffix}`, `alice_${suffix}@test.com`, 'password123');
  ok('alice registered', aliceReg.userId);

  const bobReg = await bob.register(`bob_${suffix}`, `bob_${suffix}@test.com`, 'password123');
  ok('bob registered', bobReg.userId);

  // ── 2. Login ──────────────────────────────────────────────────────────────
  console.log('\n2. Login');
  const aliceLogin = await alice.login(`alice_${suffix}`, 'password123');
  ok('alice logged in', aliceLogin.accessToken);

  const bobLogin = await bob.login(`bob_${suffix}`, 'password123');
  ok('bob logged in', bobLogin.accessToken);

  // ── 3. Create Lobby ───────────────────────────────────────────────────────
  console.log('\n3. Create Lobby');
  const lobby = await alice.createLobby({
    gameId: 'test-game',
    name:   `Test Lobby ${suffix}`,
    isPrivate: false,
    settings: { maxRounds: 5, timeLimit: 60 },
  });
  ok('lobby created', lobby.id);
  ok('lobby has settings', (lobby.settings as Record<string, unknown>)?.maxRounds === 5);
  console.log(`   Lobby ID: ${lobby.id}`);

  // ── 4. List Lobbies ───────────────────────────────────────────────────────
  console.log('\n4. List Lobbies');
  const list = await bob.listLobbies('test-game');
  ok('lobby visible in list', list.some(l => l.id === lobby.id));

  // ── 5. Join Lobby ─────────────────────────────────────────────────────────
  console.log('\n5. Join Lobby');
  await bob.joinLobby(lobby.id);

  // Give server time to process
  await sleep(300);

  const info = await alice.getLobbyInfo();
  ok('bob joined lobby', info.players.length === 2);

  // ── 6. Private Lobby + Invite Code ───────────────────────────────────────
  console.log('\n6. Private Lobby + Invite Code');
  const carol = new EthernalClient(SERVER);
  await carol.register(`carol_${suffix}`, `carol_${suffix}@test.com`, 'password123');
  await carol.login(`carol_${suffix}`, 'password123');

  const privateLobby = await carol.createLobby({
    gameId: 'test-game',
    name:   `Private ${suffix}`,
    isPrivate: true,
  });
  ok('private lobby created', privateLobby.id);
  ok('has invite code', !!privateLobby.inviteCode);
  console.log(`   Invite code: ${privateLobby.inviteCode}`);

  const dave = new EthernalClient(SERVER);
  await dave.register(`dave_${suffix}`, `dave_${suffix}@test.com`, 'password123');
  await dave.login(`dave_${suffix}`, 'password123');
  await dave.joinLobbyByCode(privateLobby.inviteCode!);
  await sleep(300);
  const privInfo = await carol.getLobbyInfo();
  ok('dave joined via code', privInfo.players.length === 2);

  // ── 7. Relay ──────────────────────────────────────────────────────────────
  console.log('\n7. Relay (sendToLobby)');
  const received = await new Promise<boolean>(resolve => {
    const timeout = setTimeout(() => resolve(false), 3000);
    bob.once('message', (msg: unknown) => {
      clearTimeout(timeout);
      resolve((msg as { payload?: unknown })?.payload === 'hello from alice');
    });
    alice.sendToLobby({ payload: 'hello from alice' });
  });
  ok('relay message received by bob', received);

  // ── 8. UserData ───────────────────────────────────────────────────────────
  console.log('\n8. UserData');
  await alice.setKey('test-game', 'score', 42);
  const score = await alice.getAllData('test-game');
  ok('score stored', score.some(e => e.key === 'score' && e.value === 42));

  await alice.bulkSet('test-game', { level: 7, wins: 3 });
  const all = await alice.getAllData('test-game');
  ok('bulk set stored', all.some(e => e.key === 'level' && e.value === 7));

  // ── 9. Leaderboard ────────────────────────────────────────────────────────
  console.log('\n9. Leaderboard');
  await alice.setKey('test-game', 'highscore', 100, 'public');
  await bob.setKey('test-game', 'highscore', 200, 'public');
  await sleep(200);
  const board = await alice.getLeaderboard('test-game', 'highscore', 'desc', 10);
  ok('leaderboard has entries', board.length >= 2);
  ok('leaderboard ordered desc', board[0].value >= board[1].value);

  // ── 10. Logout ────────────────────────────────────────────────────────────
  console.log('\n10. Logout');
  await alice.logout();
  await bob.logout();
  await carol.logout();
  await dave.logout();
  ok('alice disconnected', !alice['socket']?.connected);
  ok('bob disconnected', !bob['socket']?.connected);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Passed: ${passed}  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('\nFatal:', err.message ?? err);
  process.exit(1);
});
