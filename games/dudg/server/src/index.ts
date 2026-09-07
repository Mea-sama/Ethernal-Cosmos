import type { IpcGameToHub, IpcHubToGame } from '@ethernal/shared';
import { DudgEngine, CONTESTANT_GRACE_MS, HOST_GRACE_MS } from './game-engine';

// ─── Env ─────────────────────────────────────────────────────────────────────

const LOBBY_ID = process.env.LOBBY_ID || '';
interface InitialPlayer {
  userId: string;
  username: string;
}
const initialPlayers: InitialPlayer[] = JSON.parse(process.env.PLAYERS || '[]');

if (initialPlayers.length === 0) {
  // eslint-disable-next-line no-console
  console.error('[dudg] No initial players provided — exiting.');
  process.exit(1);
}

const host = initialPlayers[0];
const engine = new DudgEngine(host.userId, host.username);
for (const p of initialPlayers.slice(1)) engine.join(p.userId, p.username);

// ─── IPC helpers ─────────────────────────────────────────────────────────────

function send(msg: IpcGameToHub): void {
  process.send?.(msg);
}

function sendStateToUser(userId: string): void {
  const m = engine.state.members[userId];
  let state: unknown;
  if (userId === engine.state.hostId) state = engine.hostSnapshot();
  else if (m?.role === 'contestant') state = engine.contestantSnapshot(userId);
  else state = engine.spectatorSnapshot();
  send({ type: 'GAME_STATE_FOR_USER', payload: { userId, state } });
}

function broadcastAll(): void {
  sendStateToUser(engine.state.hostId);
  for (const [userId, m] of Object.entries(engine.state.members)) {
    if (m.left) continue; // permanently departed — never receives another state push
    sendStateToUser(userId);
  }
}

function log(message: string): void {
  send({ type: 'LOG', payload: message });
}

// ─── Reconnect-grace timers (self-contained — no Hub involvement) ───────────

const timers = new Map<string, NodeJS.Timeout>();

function clearTimer(userId: string): void {
  const t = timers.get(userId);
  if (t) {
    clearTimeout(t);
    timers.delete(userId);
  }
}

function startHostTimer(): void {
  clearTimer(engine.state.hostId);
  timers.set(
    engine.state.hostId,
    setTimeout(() => {
      log('Host did not reconnect within the grace period — ending game.');
      send({ type: 'GAME_OVER', payload: { reason: 'host_disconnected' } });
      process.exit(0);
    }, HOST_GRACE_MS)
  );
}

function startContestantTimer(userId: string): void {
  clearTimer(userId);
  timers.set(
    userId,
    setTimeout(() => {
      engine.playerFold(userId);
      const m = engine.state.members[userId];
      if (m) m.eliminated = m.chips <= 0 ? true : m.eliminated;
      log(`Contestant ${userId} removed after reconnect grace expired.`);
      checkTurnTimers();
      broadcastAll();
    }, CONTESTANT_GRACE_MS)
  );
}

/** Called after any action that might change whose turn it is. */
function checkTurnTimers(): void {
  const s = engine.state;
  if (s.phase.startsWith('bid')) {
    const currentId = s.seatOrder[s.bettingOrderIndex];
    const m = currentId ? s.members[currentId] : undefined;
    if (m && !m.connected && !timers.has(currentId)) startContestantTimer(currentId);
  }
}

// ─── Action dispatch ─────────────────────────────────────────────────────────

const HOST_ONLY_ACTIONS = new Set([
  'addQuestion',
  'addQuestionsByLabel',
  'removeQuestion',
  'removeQuestionsByLabel',
  'refreshQuestions',
  'startGame',
  'lockAnswers',
  'advancePhase',
  'setPhase',
  'skipTurn',
  'payout',
  'setSBBB',
  'advanceDealer',
  'setPlayerChips',
  'resetGame',
  'nextRound',
  'jokerAnswer',
  'zoomImage',
  'playAudio',
]);

function handleAction(userId: string, action: string, data: unknown): void {
  const d = (data ?? {}) as Record<string, unknown>;

  if (HOST_ONLY_ACTIONS.has(action) && userId !== engine.state.hostId) {
    log(`Rejected host-only action "${action}" from non-host ${userId}`);
    return;
  }

  switch (action) {
    case 'setRole':
      engine.setRole(userId, d.role as 'contestant' | 'spectator');
      break;
    case 'addQuestion':
      engine.addQuestion(String(d.filename));
      break;
    case 'addQuestionsByLabel':
      engine.addQuestionsByLabel(String(d.label));
      break;
    case 'removeQuestionsByLabel':
      engine.removeQuestionsByLabel(String(d.label));
      break;
    case 'removeQuestion':
      engine.removeQuestion(String(d.filename));
      break;
    case 'refreshQuestions':
      // Pool is derived live from disk on every read — nothing to do but re-broadcast.
      break;
    case 'startGame':
      engine.startGame({
        questionFile: String(d.questionFile),
        startingChips: Number(d.startingChips) || 1000,
        sbAmount: Number(d.sbAmount) || 25,
        bbAmount: Number(d.bbAmount) || 50,
        jokerEnabled: Boolean(d.jokerEnabled),
      });
      break;
    case 'lockAnswers':
      engine.lockAnswers();
      break;
    case 'advancePhase':
      engine.advancePhase();
      break;
    case 'setPhase':
      engine.setPhase(String(d.phase) as never);
      break;
    case 'skipTurn':
      engine.skipTurn();
      break;
    case 'payout':
      engine.payout((d.winnerIds as string[]) || []);
      break;
    case 'setSBBB':
      engine.setSBBB(Number(d.sb), Number(d.bb));
      break;
    case 'advanceDealer':
      engine.advanceDealer();
      break;
    case 'setPlayerChips':
      engine.setPlayerChips(String(d.userId), Number(d.chips));
      break;
    case 'resetGame':
      engine.resetGame();
      break;
    case 'nextRound':
      engine.nextRound(String(d.questionFile));
      break;
    case 'jokerAnswer':
      engine.jokerAnswer(String(d.answer), (d.note as string) || null);
      break;
    case 'submitAnswer':
      engine.submitAnswer(userId, String(d.answer));
      break;
    case 'useJoker':
      engine.useJoker(userId);
      break;
    case 'fold':
      clearTimer(userId);
      engine.playerFold(userId);
      break;
    case 'call':
      clearTimer(userId);
      engine.playerCall(userId);
      break;
    case 'raise':
      clearTimer(userId);
      engine.playerRaise(userId, Number(d.totalBet));
      break;
    case 'allIn':
      clearTimer(userId);
      engine.playerAllIn(userId);
      break;
    default:
      log(`Unknown action "${action}" from ${userId}`);
      return;
  }

  if (engine.state.phase === 'gameover') {
    send({ type: 'GAME_OVER', payload: { winnerId: engine.state.winnerId } });
  }
  checkTurnTimers();
  broadcastAll();
}

// ─── IPC message handling ────────────────────────────────────────────────────

process.on('message', (raw: unknown) => {
  const msg = raw as IpcHubToGame;
  switch (msg.type) {
    case 'PLAYER_ACTION':
      handleAction(msg.payload.userId, msg.payload.action, msg.payload.data);
      break;
    case 'PLAYER_JOIN':
      clearTimer(msg.payload.userId);
      engine.join(msg.payload.userId, msg.payload.username);
      broadcastAll();
      break;
    case 'PLAYER_DISCONNECT': {
      const { userId } = msg.payload;
      engine.disconnect(userId);
      if (userId === engine.state.hostId) {
        startHostTimer();
      } else {
        checkTurnTimers();
      }
      break;
    }
    case 'PLAYER_LEAVE': {
      const { userId } = msg.payload;
      clearTimer(userId);
      if (userId === engine.state.hostId) {
        // Host leaving is immediate and final — no grace period, no transfer (see reconnect-grace design).
        log('Host left the lobby — ending game.');
        send({ type: 'GAME_OVER', payload: { reason: 'host_left' } });
        process.exit(0);
        break;
      }
      engine.leave(userId);
      checkTurnTimers();
      broadcastAll();
      break;
    }
    case 'USER_DATA_RESPONSE':
      // Not used by DUDG (chips are ephemeral per lobby).
      break;
  }
});

process.on('SIGTERM', () => process.exit(0));

log(`DUDG instance started for lobby ${LOBBY_ID}`);
send({ type: 'READY' });
broadcastAll();
