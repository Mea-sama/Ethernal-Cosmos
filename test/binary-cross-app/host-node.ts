import { EthernalClient } from '../../sdk/src/EthernalClient';

const SERVER = process.argv[2] ?? 'https://mea-sama.duckdns.org:12346';
const RUN_ID = process.argv[3] ?? `${Date.now()}`;
const HOST_USER = 'rararara';
const GUEST_USER = 'tatatata';

const TYPE_HOST_TO_GUEST = 3001;
const TYPE_GUEST_TO_HOST = 3002;

const HOST_PAYLOAD = Uint8Array.from([1, 2, 3, 4, 250, 251]);
const GUEST_PAYLOAD = Uint8Array.from([9, 8, 7, 6, 42, 24]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        t = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

type GameInfo = { id: string };

async function resolveGameId(server: string): Promise<string> {
  const res = await fetch(`${server}/api/games`);
  if (!res.ok) throw new Error(`Could not fetch /api/games: HTTP ${res.status}`);
  const games = (await res.json()) as GameInfo[];
  if (!Array.isArray(games) || games.length === 0) {
    throw new Error('No games registered on server');
  }
  return games[0].id;
}

async function waitForGuest(client: EthernalClient, timeoutMs: number): Promise<{ hostId: string; guestId: string }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const info = await client.getLobbyInfo();
      if (info.players.length >= 2) {
        const host = info.players.find((p) => p.username === HOST_USER);
        const guest = info.players.find((p) => p.username === GUEST_USER);
        if (host?.userId && guest?.userId) {
          return { hostId: host.userId, guestId: guest.userId };
        }
      }
    } catch {
      // Transient socket errors (e.g. rate-limit) are expected in polling loops.
    }
    await sleep(350);
  }
  throw new Error('Guest did not join host lobby in time');
}

async function main(): Promise<void> {
  console.log(`Cross interop host (Node) against ${SERVER}, run=${RUN_ID}`);

  const host = new EthernalClient({ serverUrl: SERVER });
  host.on('serverError', (msg) => console.error(`[host][serverError] ${msg}`));

  try {
    await host.login(HOST_USER, HOST_USER);
    await sleep(300);
    const gameId = await resolveGameId(SERVER);

    const lobbyName = `cross-${RUN_ID}`;
    const lobby = await host.createLobby({
      gameId,
      name: lobbyName,
      isPrivate: false,
      settings: { crossInterop: true, runId: RUN_ID },
    });

    console.log(`HOST_READY lobby=${lobby.id} name=${lobbyName} gameId=${gameId}`);

    console.log('HOST_WAITING_FOR_GUEST');
    const ids = await waitForGuest(host, 20000);
    console.log(`HOST_GUEST_JOINED hostId=${ids.hostId} guestId=${ids.guestId}`);

    const inbound = withTimeout(
      new Promise<boolean>((resolve) => {
        host.onceBinaryMessage((msg) => {
          const ok =
            msg.from === ids.guestId &&
            msg.typeCode === TYPE_GUEST_TO_HOST &&
            bytesEqual(msg.payload, GUEST_PAYLOAD);
          resolve(ok);
        });
      }),
      6000,
      'host receive guest direct binary',
    );

    host.sendToLobbyBinary(TYPE_HOST_TO_GUEST, HOST_PAYLOAD);
    console.log('HOST_SENT_LOBBY_BINARY');

    const received = await inbound;
    if (!received) {
      throw new Error('Host received invalid guest direct binary packet');
    }

    console.log('PASS: Node host received expected C# direct binary payload');
    console.log('SUCCESS: Cross interop host flow complete');
  } finally {
    await host.logout().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
