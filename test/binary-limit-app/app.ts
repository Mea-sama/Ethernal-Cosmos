import fs from 'fs';
import path from 'path';
import { EthernalClient } from '../../sdk/src/EthernalClient';

const SERVER = process.argv[2] ?? 'https://mea-sama.duckdns.org:12346';
const USER_A = 'rararara';
const USER_B = 'tatatata';

const TYPE_OK = 4200;
const TYPE_RATE = 4201;

interface LimitResult {
  name: string;
  passed: boolean;
  details: Record<string, unknown>;
}

interface SweepStep {
  hz: number;
  durationMs: number;
  sent: number;
  received: number;
  rateLimitHits: number;
  deliveryRatePct: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveGameId(server: string): Promise<string> {
  const res = await fetch(`${server}/api/games`);
  if (!res.ok) throw new Error(`Could not fetch /api/games: HTTP ${res.status}`);
  const games = (await res.json()) as Array<{ id: string }>;
  if (!Array.isArray(games) || games.length === 0) throw new Error('No games registered on server');
  return games[0].id;
}

function parseUserId(auth: { user: { userId?: string; id?: string } }): string {
  const id = auth.user.userId ?? auth.user.id;
  if (!id) throw new Error('Missing user id in auth response');
  return id;
}

async function run(): Promise<void> {
  console.log(`Binary limit test against ${SERVER}`);

  const sender = new EthernalClient({ serverUrl: SERVER });
  const receiver = new EthernalClient({ serverUrl: SERVER });

  const serverErrors: string[] = [];
  sender.on('serverError', (msg) => {
    serverErrors.push(msg);
    console.log(`[sender][serverError] ${msg}`);
  });

  const results: LimitResult[] = [];

  try {
    const [a, b, gameId] = await Promise.all([
      sender.login(USER_A, USER_A),
      receiver.login(USER_B, USER_B),
      resolveGameId(SERVER),
    ]);
    const senderId = parseUserId(a as unknown as { user: { userId?: string; id?: string } });
    const receiverId = parseUserId(b as unknown as { user: { userId?: string; id?: string } });
    await sleep(350);

    const lobby = await sender.createLobby({
      gameId,
      name: `limit-${Date.now()}`,
      isPrivate: true,
      settings: { limit: true },
    });
    await receiver.joinLobby(lobby.id);
    await sleep(300);

    // Test 1: Oversize payload (> 1000 bytes default) should be rejected by server.
    serverErrors.length = 0;
    const oversize = new Uint8Array(1100);
    for (let i = 0; i < oversize.length; i += 1) oversize[i] = i & 0xff;
    sender.sendToPlayerBinary(receiverId, TYPE_OK, oversize);
    await sleep(500);

    const oversizeErr = serverErrors.find((e) => e.toLowerCase().includes('zu groß') || e.toLowerCase().includes('max'));
    results.push({
      name: 'oversize-payload-rejected',
      passed: !!oversizeErr,
      details: { receivedError: oversizeErr ?? null, allErrors: [...serverErrors] },
    });

    // Test 2: Invalid typeCode should be rejected.
    serverErrors.length = 0;
    sender.sendToPlayerBinary(receiverId, -1, new Uint8Array([1, 2, 3, 4]));
    await sleep(500);

    const typeErr = serverErrors.find((e) => e.toLowerCase().includes('typcode'));
    results.push({
      name: 'invalid-typecode-rejected',
      passed: !!typeErr,
      details: { receivedError: typeErr ?? null, allErrors: [...serverErrors] },
    });

    // Test 3: Rate sweep around the socket limit (200 events/s for sendToPlayerBinary).
    serverErrors.length = 0;
    const payload = new Uint8Array(64);
    const stepsHz = [120, 180, 220, 260, 320, 380];
    const sweep: SweepStep[] = [];

    for (const hz of stepsHz) {
      let received = 0;
      const onBinary = (msg: { from: string; typeCode: number; payload: Uint8Array }) => {
        if (msg.from === senderId && msg.typeCode === TYPE_RATE) received += 1;
      };
      receiver.onBinaryMessage(onBinary);

      const durationMs = 5000;
      const intervalMs = 1000 / hz;
      const stopAt = Date.now() + durationMs;
      let sent = 0;
      const beforeErrors = serverErrors.length;
      let nextSendAt = performance.now();

      while (Date.now() < stopAt) {
        const nowPerf = performance.now();
        if (nowPerf >= nextSendAt) {
          let catchUp = 0;
          while (performance.now() >= nextSendAt && Date.now() < stopAt && catchUp < hz) {
            sender.sendToPlayerBinary(receiverId, TYPE_RATE, payload);
            sent += 1;
            nextSendAt += intervalMs;
            catchUp += 1;
          }
          continue;
        }
        await sleep(Math.max(0, Math.min(2, nextSendAt - nowPerf)));
      }

      await sleep(1200);
      receiver.off('messageBinary', onBinary as unknown as (...args: unknown[]) => void);

      const rateLimitHits = serverErrors
        .slice(beforeErrors)
        .filter((e) => e.toLowerCase().includes('rate limit')).length;

      sweep.push({
        hz,
        durationMs,
        sent,
        received,
        rateLimitHits,
        deliveryRatePct: sent > 0 ? (received / sent) * 100 : 0,
      });
    }

    const anyRateLimit = sweep.some((s) => s.hz > 200 && s.rateLimitHits > 0);
    results.push({
      name: 'rate-limit-sweep-around-200hz',
      passed: anyRateLimit,
      details: {
        sweep,
      },
    });

    const summary = {
      server: SERVER,
      timestamp: new Date().toISOString(),
      results,
    };

    const outPath = path.resolve(__dirname, '../results', `binary-limit-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');

    console.log('\n=== LIMIT TEST SUMMARY ===');
    for (const r of results) {
      console.log(`${r.passed ? 'PASS' : 'FAIL'} | ${r.name} | ${JSON.stringify(r.details)}`);
    }
    console.log(`Result file: ${outPath}`);

    if (results.some((r) => !r.passed)) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.allSettled([sender.logout(), receiver.logout()]);
  }
}

run().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
