import { EthernalClient } from '../../sdk/src/EthernalClient';

const SERVER = process.argv[2] ?? 'https://mea-sama.duckdns.org:12346';
const USER_A = 'rararara';
const USER_B = 'tatatata';

const TYPE_LOBBY = 1001;
const TYPE_DIRECT = 1002;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type GameInfo = { id: string; name: string };
type AuthUser = { userId?: string; id?: string; username: string };

async function resolveGameId(server: string): Promise<string> {
  const res = await fetch(`${server}/api/games`);
  if (!res.ok) {
    throw new Error(`Could not fetch games list: HTTP ${res.status}`);
  }
  const games = (await res.json()) as GameInfo[];
  if (!Array.isArray(games) || games.length === 0) {
    throw new Error('No games registered on server');
  }
  return games[0].id;
}

async function main(): Promise<void> {
  console.log(`Binary Node↔Node test against ${SERVER}`);

  const alice = new EthernalClient({ serverUrl: SERVER });
  const bob = new EthernalClient({ serverUrl: SERVER });

  alice.on('serverError', (msg) => console.error(`[alice][serverError] ${msg}`));
  bob.on('serverError', (msg) => console.error(`[bob][serverError] ${msg}`));

  try {
    const [aliceAuth, bobAuth, gameId] = await Promise.all([
      alice.login(USER_A, USER_A),
      bob.login(USER_B, USER_B),
      resolveGameId(SERVER),
    ]);

    console.log(`Logged in as ${aliceAuth.user.username} and ${bobAuth.user.username}`);
    console.log(`Using gameId: ${gameId}`);

    const aliceUserId = ((aliceAuth.user as AuthUser).userId ?? (aliceAuth.user as AuthUser).id ?? '').trim();
    const bobUserId = ((bobAuth.user as AuthUser).userId ?? (bobAuth.user as AuthUser).id ?? '').trim();
    if (!aliceUserId || !bobUserId) {
      throw new Error('Could not resolve user ids from auth response');
    }

    // Login resolves before the SDK socket is always fully marked as connected.
    await sleep(400);

    const lobby = await alice.createLobby({
      gameId,
      name: `binary-node-${Date.now()}`,
      isPrivate: true,
      settings: { mode: 'binary-test' },
    });
    await bob.joinLobby(lobby.id);
    await sleep(200);

    const payloadLobby = Uint8Array.from([1, 2, 3, 4, 5, 250, 251]);
    const payloadDirect = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2]);

    const recvByBob = withTimeout(
      new Promise<boolean>((resolve) => {
        bob.onceBinaryMessage((msg) => {
          const ok =
            msg.from === aliceUserId &&
            msg.typeCode === TYPE_LOBBY &&
            equalBytes(msg.payload, payloadLobby);
          resolve(ok);
        });
      }),
      4000,
      'bob lobby binary receive',
    );

    alice.sendToLobbyBinary(TYPE_LOBBY, payloadLobby);
    const lobbyPass = await recvByBob;
    if (!lobbyPass) {
      throw new Error('Lobby binary relay validation failed');
    }
    console.log('PASS: Lobby binary relay');

    const recvByAlice = withTimeout(
      new Promise<boolean>((resolve) => {
        alice.onceBinaryMessage((msg) => {
          const ok =
            msg.from === bobUserId &&
            msg.typeCode === TYPE_DIRECT &&
            equalBytes(msg.payload, payloadDirect);
          resolve(ok);
        });
      }),
      4000,
      'alice direct binary receive',
    );

    bob.sendToPlayerBinary(aliceUserId, TYPE_DIRECT, payloadDirect);
    const directPass = await recvByAlice;
    if (!directPass) {
      throw new Error('Direct binary relay validation failed');
    }
    console.log('PASS: Direct binary relay');

    console.log('SUCCESS: Node binary relay test completed');
  } finally {
    await Promise.allSettled([alice.logout(), bob.logout()]);
  }
}

main().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
