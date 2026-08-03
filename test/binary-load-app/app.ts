import fs from 'fs';
import path from 'path';
import { EthernalClient } from '../../sdk/src/EthernalClient';

const SERVER = process.argv[2] ?? 'https://mea-sama.duckdns.org:12346';
const USER_A = 'rararara';
const USER_B = 'tatatata';
const TARGET_HZ = Number(process.argv[3] ?? 120);
const DURATION_SECONDS = Number(process.argv[4] ?? 10);
const SIZES = [64, 128, 256, 500];

const TYPE_CODE = 4100;
const HEADER_BYTES = 12; // seq:u32 + sentAtMs:f64

interface RunMetrics {
  size: number;
  hz: number;
  durationSec: number;
  sent: number;
  received: number;
  dropped: number;
  dropRatePct: number;
  outOfOrder: number;
  duplicate: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  avgMs: number;
  jitterStdDevMs: number;
  payloadBytesPerSec: number;
}

interface Summary {
  server: string;
  timestamp: string;
  hz: number;
  durationSec: number;
  runs: RunMetrics[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.floor((p / 100) * sortedValues.length)));
  return sortedValues[idx];
}

function stddev(values: number[]): number {
  if (values.length <= 1) return 0;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - avg) * (v - avg), 0) / values.length;
  return Math.sqrt(variance);
}

function makePayload(size: number, seq: number, sentAtMs: number): Uint8Array {
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  view.setUint32(0, seq, true);
  view.setFloat64(4, sentAtMs, true);

  const bytes = new Uint8Array(buf);
  for (let i = HEADER_BYTES; i < bytes.length; i += 1) {
    bytes[i] = (seq + i) & 0xff;
  }
  return bytes;
}

async function resolveGameId(server: string): Promise<string> {
  const res = await fetch(`${server}/api/games`);
  if (!res.ok) {
    throw new Error(`Could not fetch /api/games: HTTP ${res.status}`);
  }
  const games = (await res.json()) as Array<{ id: string }>;
  if (!Array.isArray(games) || games.length === 0) {
    throw new Error('No games registered on server');
  }
  return games[0].id;
}

function parseUserId(auth: { user: { userId?: string; id?: string } }): string {
  const id = auth.user.userId ?? auth.user.id;
  if (!id) throw new Error('Missing user id in auth response');
  return id;
}

async function run(): Promise<void> {
  console.log(`Binary load test against ${SERVER}`);
  console.log(`Target: ${TARGET_HZ} Hz, Duration: ${DURATION_SECONDS}s, Sizes: ${SIZES.join(', ')}`);

  const sender = new EthernalClient({ serverUrl: SERVER });
  const receiver = new EthernalClient({ serverUrl: SERVER });

  sender.on('serverError', (m) => console.error(`[sender][serverError] ${m}`));
  receiver.on('serverError', (m) => console.error(`[receiver][serverError] ${m}`));

  const runs: RunMetrics[] = [];

  try {
    const [senderAuth, receiverAuth, gameId] = await Promise.all([
      sender.login(USER_A, USER_A),
      receiver.login(USER_B, USER_B),
      resolveGameId(SERVER),
    ]);

    const senderId = parseUserId(senderAuth as unknown as { user: { userId?: string; id?: string } });
    const receiverId = parseUserId(receiverAuth as unknown as { user: { userId?: string; id?: string } });

    await sleep(350);

    const lobby = await sender.createLobby({
      gameId,
      name: `load-${Date.now()}`,
      isPrivate: true,
      settings: { load: true },
    });
    await receiver.joinLobby(lobby.id);
    await sleep(300);

    console.log(`Lobby ready: ${lobby.id}`);
    console.log(`Sender: ${senderId}`);
    console.log(`Receiver: ${receiverId}`);

    for (const size of SIZES) {
      if (size < HEADER_BYTES) {
        throw new Error(`Payload size too small: ${size}`);
      }

      console.log(`\nRunning size=${size} bytes ...`);

      let sent = 0;
      let received = 0;
      let duplicate = 0;
      let outOfOrder = 0;
      let lastSeq = -1;
      const seen = new Set<number>();
      const latencies: number[] = [];

      const onMessage = (msg: { from: string; typeCode: number; payload: Uint8Array }) => {
        if (msg.typeCode !== TYPE_CODE || msg.from !== senderId) return;
        const payload = msg.payload;
        if (payload.byteLength < HEADER_BYTES) return;

        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const seq = view.getUint32(0, true);
        const sentAt = view.getFloat64(4, true);
        const latency = Math.max(0, Date.now() - sentAt);

        if (seen.has(seq)) {
          duplicate += 1;
        } else {
          seen.add(seq);
          received += 1;
        }

        if (seq < lastSeq) {
          outOfOrder += 1;
        }
        if (seq > lastSeq) lastSeq = seq;

        latencies.push(latency);
      };

      receiver.onBinaryMessage(onMessage);

      const intervalMs = 1000 / TARGET_HZ;
      const stopAt = Date.now() + DURATION_SECONDS * 1000;
      let seq = 0;

      let nextSendAt = performance.now();
      while (Date.now() < stopAt) {
        const nowPerf = performance.now();
        if (nowPerf >= nextSendAt) {
          // Catch up if timer granularity temporarily falls behind.
          let catchUp = 0;
          while (performance.now() >= nextSendAt && Date.now() < stopAt && catchUp < TARGET_HZ) {
            const now = Date.now();
            const payload = makePayload(size, seq, now);
            sender.sendToPlayerBinary(receiverId, TYPE_CODE, payload);
            sent += 1;
            seq += 1;
            nextSendAt += intervalMs;
            catchUp += 1;
          }
          continue;
        }

        const wait = Math.max(0, Math.min(2, nextSendAt - nowPerf));
        await sleep(wait);
      }

      await sleep(1500);
      receiver.off('messageBinary', onMessage as unknown as (...args: unknown[]) => void);

      const dropped = Math.max(0, sent - received);
      const sorted = [...latencies].sort((a, b) => a - b);
      const avg = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
      const durationSec = DURATION_SECONDS;
      const payloadBytesPerSec = durationSec > 0 ? (received * size) / durationSec : 0;

      const result: RunMetrics = {
        size,
        hz: TARGET_HZ,
        durationSec,
        sent,
        received,
        dropped,
        dropRatePct: sent > 0 ? (dropped / sent) * 100 : 0,
        outOfOrder,
        duplicate,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        p99Ms: percentile(sorted, 99),
        maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
        avgMs: avg,
        jitterStdDevMs: stddev(latencies),
        payloadBytesPerSec,
      };

      runs.push(result);

      console.log(
        [
          `size=${result.size}`,
          `sent=${result.sent}`,
          `recv=${result.received}`,
          `drop=${result.dropped} (${result.dropRatePct.toFixed(2)}%)`,
          `lat p50/p95/p99=${result.p50Ms.toFixed(1)}/${result.p95Ms.toFixed(1)}/${result.p99Ms.toFixed(1)} ms`,
          `jitter=${result.jitterStdDevMs.toFixed(2)} ms`,
          `throughput=${result.payloadBytesPerSec.toFixed(1)} B/s`,
        ].join(' | '),
      );
    }

    const summary: Summary = {
      server: SERVER,
      timestamp: new Date().toISOString(),
      hz: TARGET_HZ,
      durationSec: DURATION_SECONDS,
      runs,
    };

    const outPath = path.resolve(__dirname, '../results', `binary-load-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');

    console.log('\n=== LOAD TEST SUMMARY ===');
    for (const r of runs) {
      console.log(
        `size=${r.size} | sent=${r.sent} recv=${r.received} drop=${r.dropped} (${r.dropRatePct.toFixed(2)}%) | p95=${r.p95Ms.toFixed(1)}ms | throughput=${r.payloadBytesPerSec.toFixed(1)} B/s`,
      );
    }
    console.log(`Result file: ${outPath}`);
  } finally {
    await Promise.allSettled([sender.logout(), receiver.logout()]);
  }
}

run().catch((err) => {
  console.error('FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
