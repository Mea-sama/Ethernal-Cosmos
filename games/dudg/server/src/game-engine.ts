import type { EngineState, Member, Mode, PartyResultRow, Phase, Question, Role, SessionConfig } from './types';
import { PHASES, PARTY_PHASES } from './types';
import { loadQuestionByFilename, listQuestionMeta } from './questions';

const MAX_CONTESTANTS_CLASSIC = 7;
const MAX_CONTESTANTS_PARTY = 40;
/** Contestant reconnect grace — only while it's their turn. */
export const CONTESTANT_GRACE_MS = 2 * 60 * 1000;
/** Host reconnect grace — unconditional. */
export const HOST_GRACE_MS = 2 * 60 * 1000;

// ─── Party mode constants ───────────────────────────────────────────────────────
/** Max duration of the answer+ante collecting phase — ends early once everyone has answered. */
export const PARTY_COLLECTING_MS = 60_000;
/** Max duration of each hint phase — ends early once everyone has raised or checked. */
export const PARTY_HINT_MS = 30_000;
const PARTY_ANTE_PCT = 0.05;
const PARTY_RAISE_PCT = 0.5;
const PARTY_RAISE_MIN = 25;
/** Payout curve endpoints: [rank-1 %, last-upper-half-rank %] and, for the exact curve, the lower half too. */
const PARTY_NEAR_UPPER = [200, 125] as const;
const PARTY_EXACT_UPPER = [250, 150] as const;
const PARTY_EXACT_LOWER = [100, 50] as const;

export function parseNumericAnswer(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().replace(',', '.');
  if (normalized === '') return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function freshMember(userId: string, username: string, role: Role): Member {
  return {
    userId,
    username,
    role,
    connected: true,
    seatIndex: -1,
    chips: 0,
    answer: '',
    answerLocked: false,
    folded: false,
    allIn: false,
    eliminated: false,
    currentBet: 0,
    jokerUsed: false,
    left: false,
    answeredAt: null,
    partyBet: 0,
    partyActed: false,
    ready: false,
    prevLeaderboardRank: null,
  };
}

function defaultState(hostId: string, hostUsername: string): EngineState {
  return {
    phase: 'setup',
    hostId,
    hostUsername,
    members: {},
    seatOrder: [],
    questionPool: [],
    poolLocked: false,
    usedQuestions: [],
    currentQuestion: null,
    pot: 0,
    currentHighBet: 0,
    dealerIndex: 0,
    bettingOrderIndex: 0,
    lastRaiserIndex: null,
    revealedHints: [],
    answerRevealed: false,
    winnerId: null,
    sessionConfig: { startingChips: 1000, sbAmount: 25, bbAmount: 50, jokerEnabled: false },
    jokerActiveUserId: null,
    jokerAnswer: null,
    jokerNote: null,
    mode: 'classic',
    partyPhaseEndsAt: null,
    partyResults: null,
    partyLeaderboard: null,
  };
}

export class DudgEngine {
  state: EngineState;

  constructor(hostId: string, hostUsername: string) {
    this.state = defaultState(hostId, hostUsername);
    this.state.members[hostId] = freshMember(hostId, hostUsername, 'contestant');
    // Host is tracked separately (hostId) — its Member entry only holds connected/username bookkeeping.
  }

  // ─── Membership / roles ────────────────────────────────────────────────────

  private maxContestants(): number {
    return this.state.mode === 'party' ? MAX_CONTESTANTS_PARTY : MAX_CONTESTANTS_CLASSIC;
  }

  private contestantCount(): number {
    const excludeHost = this.state.mode !== 'party';
    return Object.values(this.state.members).filter(
      (m) => m.role === 'contestant' && !m.left && !(excludeHost && m.userId === this.state.hostId)
    ).length;
  }

  /** Host-only, setup phase only: switches between Classic (poker) and Party (simultaneous) mode. */
  setMode(userId: string, mode: Mode): { ok: boolean; error?: string } {
    if (userId !== this.state.hostId) return { ok: false, error: 'NOT_HOST' };
    if (this.state.phase !== 'setup') return { ok: false, error: 'ALREADY_STARTED' };
    this.state.mode = mode;
    return { ok: true };
  }

  /** Called on PLAYER_JOIN (initial spawn roster + reconnects + brand-new joiners). */
  join(userId: string, username: string): void {
    if (userId === this.state.hostId) {
      this.state.hostUsername = username;
      return;
    }
    const existing = this.state.members[userId];
    if (existing && !existing.left) {
      existing.connected = true;
      existing.username = username;
      return;
    }
    // Brand-new userId never seen in this lobby before.
    if (this.state.mode === 'party') {
      // Party mode: everyone who joins plays, up to the cap; overflow falls back to spectating.
      this.state.members[userId] = freshMember(userId, username, this.contestantCount() < this.maxContestants() ? 'contestant' : 'spectator');
    } else if (this.state.phase === 'setup' && this.contestantCount() < this.maxContestants()) {
      this.state.members[userId] = freshMember(userId, username, 'contestant');
    } else {
      // Active game (or setup already full) — unknown joiners always become spectators.
      this.state.members[userId] = freshMember(userId, username, 'spectator');
    }
  }

  disconnect(userId: string): void {
    const m = this.state.members[userId];
    if (m) m.connected = false;
  }

  /**
   * Permanent departure (explicit leave/kick) — unlike disconnect(), no reconnect grace applies
   * and they never receive another state push. Before the game starts (no seatOrder yet), fully
   * forgetting them is safe; once seatOrder/dealer/betting indices exist, deleting would shift
   * every subsequent seat index, so they're instead permanently folded/eliminated in place.
   */
  leave(userId: string): void {
    const m = this.state.members[userId];
    if (!m) return;
    m.connected = false;
    m.left = true;
    if (this.state.seatOrder.length === 0) {
      delete this.state.members[userId];
      return;
    }
    if (m.role === 'contestant' && !m.folded && !m.eliminated) {
      this.playerFold(userId);
    }
    m.eliminated = true;
  }

  isHost(userId: string): boolean {
    return userId === this.state.hostId;
  }

  setRole(userId: string, role: Role): { ok: boolean; error?: string } {
    if (this.state.mode === 'party') return { ok: false, error: 'NOT_AVAILABLE_IN_PARTY_MODE' };
    if (userId === this.state.hostId) return { ok: false, error: 'HOST_HAS_NO_ROLE' };
    const m = this.state.members[userId];
    if (!m) return { ok: false, error: 'NOT_FOUND' };
    if (role === m.role) return { ok: true };
    if (role === 'contestant') {
      if (this.contestantCount() >= this.maxContestants()) return { ok: false, error: 'CONTESTANTS_FULL' };
      if (this.state.phase !== 'setup') return { ok: false, error: 'GAME_ALREADY_STARTED' };
      m.role = 'contestant';
      return { ok: true };
    }
    // → spectator: allowed anytime; mid-hand this forfeits like a fold.
    if (m.role === 'contestant' && this.state.phase !== 'setup' && this.state.phase !== 'gameover') {
      if (!m.folded && !m.eliminated) this.playerFold(userId);
    }
    m.role = 'spectator';
    return { ok: true };
  }

  // ─── Question pool (setup phase only) ──────────────────────────────────────

  addQuestion(filename: string): { ok: boolean; error?: string } {
    if (this.state.poolLocked) return { ok: false, error: 'POOL_LOCKED' };
    try {
      loadQuestionByFilename(filename); // validates it exists / is parseable
    } catch {
      return { ok: false, error: 'QUESTION_NOT_FOUND' };
    }
    if (!this.state.questionPool.includes(filename)) this.state.questionPool.push(filename);
    return { ok: true };
  }

  addQuestionsByLabel(label: string): { ok: boolean; added: number } {
    if (this.state.poolLocked) return { ok: false, added: 0 };
    const matches = listQuestionMeta().filter((q) => q.labels.includes(label));
    let added = 0;
    for (const q of matches) {
      if (!this.state.questionPool.includes(q.filename)) {
        this.state.questionPool.push(q.filename);
        added++;
      }
    }
    return { ok: true, added };
  }

  removeQuestionsByLabel(label: string): { ok: boolean; removed: number } {
    if (this.state.poolLocked) return { ok: false, removed: 0 };
    const matchFilenames = new Set(listQuestionMeta().filter((q) => q.labels.includes(label)).map((q) => q.filename));
    const before = this.state.questionPool.length;
    this.state.questionPool = this.state.questionPool.filter((f) => !matchFilenames.has(f));
    return { ok: true, removed: before - this.state.questionPool.length };
  }

  removeQuestion(filename: string): { ok: boolean } {
    if (this.state.poolLocked) return { ok: false };
    this.state.questionPool = this.state.questionPool.filter((f) => f !== filename);
    return { ok: true };
  }

  availableLabels(): string[] {
    const labels = new Set<string>();
    for (const q of listQuestionMeta()) for (const l of q.labels) labels.add(l);
    return [...labels].sort();
  }

  // ─── Game start / rounds ────────────────────────────────────────────────────

  startGame(opts: { questionFile: string; startingChips: number; sbAmount: number; bbAmount: number; jokerEnabled: boolean }): { ok: boolean; error?: string } {
    if (this.state.phase !== 'setup') return { ok: false, error: 'ALREADY_STARTED' };
    if (!this.state.questionPool.includes(opts.questionFile)) return { ok: false, error: 'QUESTION_NOT_IN_POOL' };
    if (this.contestantCount() < 2) return { ok: false, error: 'NOT_ENOUGH_CONTESTANTS' };

    const question = loadQuestionByFilename(opts.questionFile);
    this.state.sessionConfig = {
      startingChips: opts.startingChips,
      sbAmount: opts.sbAmount,
      bbAmount: opts.bbAmount,
      jokerEnabled: opts.jokerEnabled,
    };

    const contestants = Object.values(this.state.members).filter((m) => m.role === 'contestant' && m.userId !== this.state.hostId);
    contestants.forEach((m, i) => {
      m.seatIndex = i;
      m.chips = opts.startingChips;
      m.answer = '';
      m.answerLocked = false;
      m.folded = false;
      m.allIn = false;
      m.eliminated = false;
      m.currentBet = 0;
      m.jokerUsed = false;
    });
    this.state.seatOrder = contestants.map((m) => m.userId);

    this.state.currentQuestion = question;
    this.state.pot = 0;
    this.state.currentHighBet = 0;
    this.state.dealerIndex = 0;
    this.state.bettingOrderIndex = 0;
    this.state.lastRaiserIndex = null;
    this.state.revealedHints = [];
    this.state.answerRevealed = false;
    this.state.winnerId = null;
    this.state.usedQuestions = [opts.questionFile];
    this.state.jokerActiveUserId = null;
    this.state.jokerAnswer = null;
    this.state.jokerNote = null;
    this.state.poolLocked = true;
    this.state.phase = 'collecting';
    return { ok: true };
  }

  nextRound(questionFile: string): { ok: boolean; error?: string } {
    if (!this.state.questionPool.includes(questionFile)) return { ok: false, error: 'QUESTION_NOT_IN_POOL' };
    const question = loadQuestionByFilename(questionFile);

    const seat = this.seatMembers();
    seat.forEach((m) => {
      if (m.chips <= 0) m.eliminated = true;
    });
    seat.forEach((m) => {
      m.answer = '';
      m.answerLocked = false;
      m.folded = false;
      m.allIn = false;
      m.currentBet = 0;
    });

    this.advanceDealerSkipEliminated();

    this.state.currentQuestion = question;
    if (!this.state.usedQuestions.includes(questionFile)) this.state.usedQuestions.push(questionFile);
    this.state.pot = 0;
    this.state.currentHighBet = 0;
    this.state.bettingOrderIndex = 0;
    this.state.lastRaiserIndex = null;
    this.state.revealedHints = [];
    this.state.answerRevealed = false;
    this.state.winnerId = null;
    this.state.jokerActiveUserId = null;
    this.state.jokerAnswer = null;
    this.state.jokerNote = null;

    const active = seat.filter((m) => !m.eliminated && m.chips > 0);
    if (active.length === 1) {
      this.state.winnerId = active[0].userId;
      this.state.phase = 'gameover';
    } else {
      this.state.phase = 'collecting';
    }
    return { ok: true };
  }

  resetGame(): void {
    const hostId = this.state.hostId;
    const hostUsername = this.state.hostUsername;
    const members = this.state.members;
    this.state = defaultState(hostId, hostUsername);
    // Preserve who's in the lobby (roles reset to spectator except host — matches a fresh setup phase).
    for (const m of Object.values(members)) {
      if (m.userId === hostId) continue;
      this.state.members[m.userId] = freshMember(m.userId, m.username, 'spectator');
      this.state.members[m.userId].connected = m.connected;
    }
  }

  // ─── Party mode ─────────────────────────────────────────────────────────

  startPartyGame(opts: { questionFile: string; startingChips: number }): { ok: boolean; error?: string } {
    if (this.state.phase !== 'setup') return { ok: false, error: 'ALREADY_STARTED' };
    if (this.state.mode !== 'party') return { ok: false, error: 'NOT_PARTY_MODE' };
    if (!this.state.questionPool.includes(opts.questionFile)) return { ok: false, error: 'QUESTION_NOT_IN_POOL' };
    if (this.contestantCount() < 2) return { ok: false, error: 'NOT_ENOUGH_CONTESTANTS' };

    this.state.sessionConfig = { startingChips: opts.startingChips, sbAmount: 0, bbAmount: 0, jokerEnabled: false };

    const players = Object.values(this.state.members).filter((m) => m.role === 'contestant' && !m.left);
    players.forEach((m, i) => {
      m.seatIndex = i;
      m.chips = opts.startingChips;
      m.eliminated = false;
    });
    this.state.seatOrder = players.map((m) => m.userId);
    this.state.poolLocked = true;
    this.beginPartyCollecting(opts.questionFile);
    return { ok: true };
  }

  /** Picks the given (first round) or a random unused question from the pool and starts collecting. */
  private beginPartyCollecting(forceFilename?: string): void {
    const seat = this.seatMembers();
    seat.forEach((m) => {
      if (m.chips <= 0) m.eliminated = true;
    });
    const active = seat.filter((m) => !m.eliminated);
    if (active.length <= 1) {
      this.state.winnerId = active[0]?.userId ?? null;
      this.state.phase = 'gameover';
      return;
    }

    let filename = forceFilename;
    if (!filename) {
      const unused = this.state.questionPool.filter((f) => !this.state.usedQuestions.includes(f));
      if (unused.length === 0) {
        this.state.winnerId = null; // no clear single winner — pool exhausted
        this.state.phase = 'gameover';
        return;
      }
      filename = unused[Math.floor(Math.random() * unused.length)];
    }

    this.state.currentQuestion = loadQuestionByFilename(filename);
    if (!this.state.usedQuestions.includes(filename)) this.state.usedQuestions.push(filename);
    this.state.revealedHints = [];
    this.state.answerRevealed = false;
    this.state.partyResults = null;

    active.forEach((m) => {
      m.answer = '';
      m.answeredAt = null;
      m.partyActed = false;
      m.ready = false;
      m.partyBet = Math.max(1, Math.round(m.chips * PARTY_ANTE_PCT));
    });

    this.state.phase = 'partyCollecting';
    this.state.partyPhaseEndsAt = Date.now() + PARTY_COLLECTING_MS;
  }

  private activePartyMembers(): Member[] {
    return this.seatMembers().filter((m) => !m.eliminated);
  }

  submitPartyAnswer(userId: string, answer: string): { ok: boolean; error?: string } {
    if (this.state.phase !== 'partyCollecting') return { ok: false, error: 'WRONG_PHASE' };
    const m = this.state.members[userId];
    if (!m || m.eliminated) return { ok: false, error: 'NOT_ACTIVE' };
    m.answer = answer;
    if (m.answeredAt === null) m.answeredAt = Date.now();
    return { ok: true };
  }

  /** Collecting phase: freely set your own bet to any value between the mandatory ante and your chips. */
  setPartyBet(userId: string, amount: number): { ok: boolean; error?: string } {
    if (this.state.phase !== 'partyCollecting') return { ok: false, error: 'WRONG_PHASE' };
    const m = this.state.members[userId];
    if (!m || m.eliminated) return { ok: false, error: 'NOT_ACTIVE' };
    const minAnte = Math.max(1, Math.round(m.chips * PARTY_ANTE_PCT));
    if (!Number.isFinite(amount) || amount < minAnte || amount > m.chips) return { ok: false, error: 'INVALID_AMOUNT' };
    m.partyBet = Math.round(amount);
    return { ok: true };
  }

  /** Hint phases: raise your own bet by +50% (minimum +25), capped at your chips (effectively all-in). */
  raisePartyBet(userId: string): { ok: boolean; error?: string } {
    if (this.state.phase !== 'partyHint1' && this.state.phase !== 'partyHint2') return { ok: false, error: 'WRONG_PHASE' };
    const m = this.state.members[userId];
    if (!m || m.eliminated) return { ok: false, error: 'NOT_ACTIVE' };
    const increase = Math.max(Math.round(m.partyBet * PARTY_RAISE_PCT), PARTY_RAISE_MIN);
    m.partyBet = Math.min(m.chips, m.partyBet + increase);
    m.partyActed = true;
    return { ok: true };
  }

  checkPartyBet(userId: string): { ok: boolean; error?: string } {
    if (this.state.phase !== 'partyHint1' && this.state.phase !== 'partyHint2') return { ok: false, error: 'WRONG_PHASE' };
    const m = this.state.members[userId];
    if (!m || m.eliminated) return { ok: false, error: 'NOT_ACTIVE' };
    m.partyActed = true;
    return { ok: true };
  }

  /** True once every active player has done their part for the current timer-capped phase — allows early advance. */
  isPartyPhaseComplete(): boolean {
    const active = this.activePartyMembers();
    if (active.length === 0) return true;
    if (this.state.phase === 'partyCollecting') return active.every((m) => m.answer !== '');
    if (this.state.phase === 'partyHint1' || this.state.phase === 'partyHint2') return active.every((m) => m.partyActed);
    return false;
  }

  /** Advances collecting→hint1→hint2→reveal — called by the subprocess's timer/early-advance check. */
  advancePartyPhase(): void {
    if (this.state.phase === 'partyCollecting') {
      this.state.revealedHints = ['hint1'];
      this.activePartyMembers().forEach((m) => (m.partyActed = false));
      this.state.phase = 'partyHint1';
      this.state.partyPhaseEndsAt = Date.now() + PARTY_HINT_MS;
    } else if (this.state.phase === 'partyHint1') {
      this.state.revealedHints = ['hint1', 'hint2'];
      this.activePartyMembers().forEach((m) => (m.partyActed = false));
      this.state.phase = 'partyHint2';
      this.state.partyPhaseEndsAt = Date.now() + PARTY_HINT_MS;
    } else if (this.state.phase === 'partyHint2') {
      this.computePartyReveal();
    }
  }

  private static roundTo25(amount: number): number {
    return Math.round(amount / 25) * 25;
  }

  /** Numeric distance to the correct answer (0 = exact); options questions use their rank position. */
  private partyDistance(m: Member): { distance: number; exact: boolean } {
    const q = this.state.currentQuestion;
    if (!q || m.answer === '') return { distance: Infinity, exact: false };
    if (q.questionType === 'options') {
      const idx = q.optionRank ? q.optionRank.indexOf(m.answer.trim().toUpperCase()) : -1;
      if (idx === -1) return { distance: Infinity, exact: false };
      return { distance: idx, exact: idx === 0 };
    }
    const parsed = parseNumericAnswer(m.answer);
    const correct = q.answer !== null ? parseNumericAnswer(q.answer) : null;
    if (parsed === null || correct === null) return { distance: Infinity, exact: false };
    const distance = Math.abs(parsed - correct);
    return { distance, exact: Math.round(distance * 10_000) === 0 };
  }

  /** Linear interpolation between a curve's [first, last] % across `halfSize` upper/lower-half slots. */
  private static curvePercent(positionInHalf: number, halfSize: number, curve: readonly [number, number]): number {
    if (halfSize <= 1) return curve[0];
    return curve[0] - ((curve[0] - curve[1]) * positionInHalf) / (halfSize - 1);
  }

  private partyPercent(rank: number, n: number, exact: boolean): number {
    const upperCount = Math.ceil(n / 2);
    const lowerCount = n - upperCount;
    if (rank <= upperCount) {
      const curve = exact ? PARTY_EXACT_UPPER : PARTY_NEAR_UPPER;
      return DudgEngine.curvePercent(rank - 1, upperCount, curve);
    }
    if (!exact) return 0;
    return DudgEngine.curvePercent(rank - upperCount - 1, lowerCount, PARTY_EXACT_LOWER);
  }

  private computePartyReveal(): void {
    this.state.answerRevealed = true;
    const active = this.activePartyMembers();
    const scored = active.map((m) => ({ m, ...this.partyDistance(m) }));
    scored.sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      return (a.m.answeredAt ?? Infinity) - (b.m.answeredAt ?? Infinity);
    });

    const results: PartyResultRow[] = scored.map((entry, i) => {
      const rank = i + 1;
      const percent = this.partyPercent(rank, scored.length, entry.exact);
      const prize = DudgEngine.roundTo25(entry.m.partyBet * (percent / 100));
      entry.m.chips = entry.m.chips - entry.m.partyBet + prize;
      if (entry.m.chips <= 0) entry.m.eliminated = true;
      return {
        userId: entry.m.userId,
        username: entry.m.username,
        rank,
        distance: entry.distance,
        exact: entry.exact,
        betBefore: entry.m.partyBet,
        percent,
        prize,
        chipsAfter: entry.m.chips,
      };
    });

    this.state.partyResults = results;
    active.forEach((m) => (m.ready = false));
    this.state.phase = 'partyReveal';
    this.state.partyPhaseEndsAt = null;

    // Overall standings (by chips) with this round's rank movement — the main payout-phase view.
    const standings = [...active].sort((a, b) => b.chips - a.chips);
    this.state.partyLeaderboard = standings.map((m, i) => {
      const rank = i + 1;
      const resultRow = results.find((r) => r.userId === m.userId);
      const rankDelta = m.prevLeaderboardRank === null ? 0 : m.prevLeaderboardRank - rank;
      m.prevLeaderboardRank = rank;
      return {
        userId: m.userId,
        username: m.username,
        chips: m.chips,
        rank,
        rankDelta,
        net: resultRow ? resultRow.prize - resultRow.betBefore : 0,
      };
    });
  }

  /** Reveal/payout has no timer — every active player must click Ready before the next round starts. */
  markPartyReady(userId: string): { ok: boolean } {
    if (this.state.phase !== 'partyReveal' && this.state.phase !== 'partyPayout') return { ok: false };
    const m = this.state.members[userId];
    if (!m || m.eliminated) return { ok: false };
    m.ready = true;
    if (this.activePartyMembers().every((p) => p.ready)) {
      this.beginPartyCollecting();
    }
    return { ok: true };
  }

  // ─── Seat helpers ───────────────────────────────────────────────────────────

  private seatMembers(): Member[] {
    return this.state.seatOrder.map((id) => this.state.members[id]).filter(Boolean);
  }

  private nextActiveIndex(fromIdx: number): number {
    const seat = this.seatMembers();
    const count = seat.length;
    let idx = (fromIdx + 1) % count;
    for (let i = 0; i < count; i++) {
      if (!seat[idx].eliminated && !seat[idx].folded && !seat[idx].allIn) return idx;
      idx = (idx + 1) % count;
    }
    return fromIdx;
  }

  private advanceDealerSkipEliminated(): void {
    const seat = this.seatMembers();
    const count = seat.length;
    let next = (this.state.dealerIndex + 1) % count;
    for (let i = 0; i < count; i++) {
      if (!seat[next].eliminated) {
        this.state.dealerIndex = next;
        return;
      }
      next = (next + 1) % count;
    }
  }

  private getSBIndex(): number {
    return this.nextActiveIndex(this.state.dealerIndex);
  }
  private getBBIndex(): number {
    return this.nextActiveIndex(this.getSBIndex());
  }

  private initBid1(): void {
    const seat = this.seatMembers();
    const sbIdx = this.getSBIndex();
    const bbIdx = this.getBBIndex();

    seat.forEach((m) => {
      m.currentBet = 0;
      m.allIn = false;
    });

    const sb = seat[sbIdx];
    const bb = seat[bbIdx];
    const sbAmt = Math.min(sb.chips, this.state.sessionConfig.sbAmount);
    const bbAmt = Math.min(bb.chips, this.state.sessionConfig.bbAmount);

    sb.chips -= sbAmt;
    sb.currentBet = sbAmt;
    if (sb.chips === 0) sb.allIn = true;
    bb.chips -= bbAmt;
    bb.currentBet = bbAmt;
    if (bb.chips === 0) bb.allIn = true;
    this.state.pot += sbAmt + bbAmt;
    this.state.currentHighBet = bbAmt;

    this.state.bettingOrderIndex = this.nextActiveIndex(bbIdx);
    this.state.lastRaiserIndex = bbIdx;
  }

  private resetBettingRound(): void {
    this.seatMembers().forEach((m) => {
      m.currentBet = 0;
    });
    this.state.currentHighBet = 0;
    this.state.lastRaiserIndex = null;
  }

  // ─── Phase transitions ──────────────────────────────────────────────────────

  lockAnswers(): void {
    for (const m of this.seatMembers()) m.answerLocked = true;
  }

  advancePhase(): boolean {
    const idx = PHASES.indexOf(this.state.phase as (typeof PHASES)[number]);
    if (idx === -1 || idx === PHASES.length - 1) return false;
    this.state.phase = PHASES[idx + 1];

    if (this.state.phase === 'hint1') {
      this.state.revealedHints = ['hint1'];
      this.resetBettingRound();
    } else if (this.state.phase === 'hint2') {
      this.state.revealedHints = ['hint1', 'hint2'];
      this.resetBettingRound();
    } else if (this.state.phase === 'answer') {
      this.state.answerRevealed = true;
      this.resetBettingRound();
    } else if (this.state.phase === 'bid1') {
      this.initBid1();
    }
    return true;
  }

  setPhase(phase: Phase): boolean {
    if (!(PHASES as readonly string[]).includes(phase) && phase !== 'gameover') return false;
    this.state.phase = phase;
    return true;
  }

  // ─── Answers ─────────────────────────────────────────────────────────────

  submitAnswer(userId: string, answer: string): { ok: boolean; error?: string } {
    const m = this.state.members[userId];
    if (!m || m.role !== 'contestant') return { ok: false, error: 'NOT_A_CONTESTANT' };
    if (m.eliminated) return { ok: false, error: 'ELIMINATED' };
    if (m.answerLocked) return { ok: false, error: 'LOCKED' };
    if (this.state.phase !== 'collecting') return { ok: false, error: 'WRONG_PHASE' };
    m.answer = answer;
    return { ok: true };
  }

  // ─── Joker ───────────────────────────────────────────────────────────────

  useJoker(userId: string): { ok: boolean; reason?: string } {
    if (!this.state.sessionConfig.jokerEnabled) return { ok: false, reason: 'disabled' };
    if (this.state.phase !== 'collecting') return { ok: false, reason: 'wrong_phase' };
    if (this.state.jokerActiveUserId) return { ok: false, reason: 'taken' };
    const m = this.state.members[userId];
    if (!m || m.role !== 'contestant') return { ok: false, reason: 'not_found' };
    if (m.jokerUsed) return { ok: false, reason: 'already_used' };
    m.jokerUsed = true;
    this.state.jokerActiveUserId = userId;
    return { ok: true };
  }

  /** Host answers on behalf of the currently-pending joker request. */
  jokerAnswer(answer: string, note: string | null): { ok: boolean; error?: string } {
    if (!this.state.jokerActiveUserId) return { ok: false, error: 'NO_ACTIVE_REQUEST' };
    const m = this.state.members[this.state.jokerActiveUserId];
    if (!m) return { ok: false, error: 'NOT_FOUND' };
    m.answer = answer;
    this.state.jokerAnswer = answer;
    this.state.jokerNote = note || null;
    return { ok: true };
  }

  // ─── Betting ─────────────────────────────────────────────────────────────

  private currentBettorId(): string | null {
    const seat = this.seatMembers();
    return seat[this.state.bettingOrderIndex]?.userId ?? null;
  }

  private advanceBettingOrder(): void {
    const seat = this.seatMembers();
    const count = seat.length;
    let next = (this.state.bettingOrderIndex + 1) % count;
    for (let i = 0; i < count; i++) {
      if (!seat[next].folded && !seat[next].eliminated && !seat[next].allIn) {
        this.state.bettingOrderIndex = next;
        return;
      }
      next = (next + 1) % count;
    }
  }

  playerFold(userId: string): { ok: boolean } {
    const m = this.state.members[userId];
    if (!m || m.folded || m.eliminated) return { ok: false };
    m.folded = true;
    if (this.currentBettorId() === userId) this.advanceBettingOrder();
    return { ok: true };
  }

  playerCall(userId: string): { ok: boolean; amount?: number; error?: string } {
    if (this.currentBettorId() !== userId) return { ok: false, error: 'NOT_YOUR_TURN' };
    const m = this.state.members[userId];
    if (!m || m.folded || m.eliminated) return { ok: false };
    const toCall = this.state.currentHighBet - m.currentBet;
    const actual = Math.min(toCall, m.chips);
    m.chips -= actual;
    m.currentBet += actual;
    this.state.pot += actual;
    this.advanceBettingOrder();
    return { ok: true, amount: actual };
  }

  playerRaise(userId: string, totalBet: number): { ok: boolean; error?: string } {
    if (this.currentBettorId() !== userId) return { ok: false, error: 'NOT_YOUR_TURN' };
    const m = this.state.members[userId];
    if (!m || m.folded || m.eliminated) return { ok: false };
    const additional = totalBet - m.currentBet;
    if (additional <= 0 || additional > m.chips) return { ok: false, error: 'INVALID_AMOUNT' };
    m.chips -= additional;
    m.currentBet = totalBet;
    this.state.pot += additional;
    this.state.currentHighBet = totalBet;
    this.state.lastRaiserIndex = m.seatIndex;
    this.advanceBettingOrder();
    return { ok: true };
  }

  playerAllIn(userId: string): { ok: boolean; totalBet?: number; error?: string } {
    if (this.currentBettorId() !== userId) return { ok: false, error: 'NOT_YOUR_TURN' };
    const m = this.state.members[userId];
    if (!m || m.folded || m.eliminated || m.allIn || m.chips === 0) return { ok: false };
    const additional = m.chips;
    const totalBet = m.currentBet + additional;
    m.chips = 0;
    m.currentBet = totalBet;
    m.allIn = true;
    this.state.pot += additional;
    if (totalBet > this.state.currentHighBet) {
      this.state.currentHighBet = totalBet;
      this.state.lastRaiserIndex = m.seatIndex;
    }
    this.advanceBettingOrder();
    return { ok: true, totalBet };
  }

  skipTurn(): void {
    this.advanceBettingOrder();
  }

  // ─── Chips / dealer / blinds (host-only actions) ────────────────────────────

  payout(winnerIds: string[]): void {
    if (winnerIds.length === 0) return;
    const share = Math.floor(this.state.pot / winnerIds.length);
    const remainder = this.state.pot - share * winnerIds.length;
    winnerIds.forEach((id, i) => {
      const m = this.state.members[id];
      if (m) m.chips += share + (i === 0 ? remainder : 0);
    });
    this.state.pot = 0;
  }

  setSBBB(sb: number, bb: number): void {
    this.state.sessionConfig.sbAmount = sb;
    this.state.sessionConfig.bbAmount = bb;
  }

  advanceDealer(): void {
    this.advanceDealerSkipEliminated();
  }

  setPlayerChips(userId: string, chips: number): void {
    const m = this.state.members[userId];
    if (!m) return;
    m.chips = chips;
    if (chips > 0) m.eliminated = false;
  }

  // ─── Snapshots ───────────────────────────────────────────────────────────

  private questionForNonHost(): Partial<Question> | null {
    const q = this.state.currentQuestion;
    if (!q || this.state.phase === 'payout') return null;
    return {
      filename: q.filename,
      questionHtml: q.questionHtml,
      questionText: q.questionText,
      mediaHtml: q.mediaHtml,
      audioSrc: q.audioSrc,
      questionType: q.questionType,
      options: q.options,
      optionRank: this.state.answerRevealed ? q.optionRank : null,
      hint1Html: this.state.revealedHints.includes('hint1') ? q.hint1Html : null,
      hint2Html: this.state.revealedHints.includes('hint2') ? q.hint2Html : null,
      answer: this.state.answerRevealed ? q.answer : null,
      answerHtml: this.state.answerRevealed ? q.answerHtml : null,
    };
  }

  private seatSummary(revealAnswers: boolean) {
    return this.seatMembers().map((m) => ({
      userId: m.userId,
      username: m.username,
      chips: m.chips,
      folded: m.folded,
      allIn: m.allIn,
      eliminated: m.eliminated,
      currentBet: m.currentBet,
      seatIndex: m.seatIndex,
      connected: m.connected,
      answer: revealAnswers ? m.answer : null,
    }));
  }

  hostSnapshot() {
    const s = this.state;
    return {
      role: 'host' as const,
      phase: s.phase,
      hostId: s.hostId,
      hostUsername: s.hostUsername,
      pot: s.pot,
      currentHighBet: s.currentHighBet,
      dealerIndex: s.dealerIndex,
      sbAmount: s.sessionConfig.sbAmount,
      bbAmount: s.sessionConfig.bbAmount,
      startingChips: s.sessionConfig.startingChips,
      jokerEnabled: s.sessionConfig.jokerEnabled,
      bettingOrderIndex: s.bettingOrderIndex,
      currentBettorId: this.currentBettorId(),
      revealedHints: s.revealedHints,
      answerRevealed: s.answerRevealed,
      winnerId: s.winnerId,
      winnerUsername: s.winnerId ? s.members[s.winnerId]?.username : null,
      questionPool: s.questionPool,
      poolLocked: s.poolLocked,
      usedQuestions: s.usedQuestions,
      currentQuestion: s.currentQuestion,
      mode: s.mode,
      players: this.seatSummary(s.phase === 'reveal' || s.phase === 'payout' || s.phase === 'gameover'),
      spectators: Object.values(s.members).filter((m) => m.role === 'spectator').map((m) => ({ userId: m.userId, username: m.username, connected: m.connected })),
      jokerActiveUserId: s.jokerActiveUserId,
      jokerActiveUsername: s.jokerActiveUserId ? s.members[s.jokerActiveUserId]?.username : null,
      jokerAnswer: s.jokerAnswer,
      jokerNote: s.jokerNote,
    };
  }

  contestantSnapshot(userId: string) {
    const s = this.state;
    const m = s.members[userId];
    if (!m) return null;
    return {
      role: 'contestant' as const,
      phase: s.phase,
      mode: s.mode,
      userId: m.userId,
      username: m.username,
      chips: m.chips,
      answer: m.answer,
      answerLocked: m.answerLocked,
      folded: m.folded,
      allIn: m.allIn,
      eliminated: m.eliminated,
      currentBet: m.currentBet,
      pot: s.pot,
      currentHighBet: s.currentHighBet,
      toCall: Math.max(0, s.currentHighBet - m.currentBet),
      sbAmount: s.sessionConfig.sbAmount,
      bbAmount: s.sessionConfig.bbAmount,
      question: this.questionForNonHost(),
      isCurrentBettor: !m.eliminated && !m.folded && this.currentBettorId() === userId,
      winnerId: s.winnerId,
      winnerUsername: s.winnerId ? s.members[s.winnerId]?.username : null,
      jokerEnabled: s.sessionConfig.jokerEnabled,
      jokerUsed: m.jokerUsed,
      jokerPendingForMe: s.jokerActiveUserId === userId && !s.jokerAnswer,
      jokerAnsweredForMe: s.jokerActiveUserId === userId && !!s.jokerAnswer,
      jokerNote: s.jokerActiveUserId === userId ? s.jokerNote : null,
    };
  }

  /** Display/spectator view — same shape for every spectator, no per-user secrets. */
  spectatorSnapshot() {
    const s = this.state;
    return {
      role: 'spectator' as const,
      phase: s.phase,
      pot: s.pot,
      currentHighBet: s.currentHighBet,
      dealerIndex: s.dealerIndex,
      sbAmount: s.sessionConfig.sbAmount,
      bbAmount: s.sessionConfig.bbAmount,
      bettingOrderIndex: s.bettingOrderIndex,
      revealedHints: s.revealedHints,
      answerRevealed: s.answerRevealed,
      winnerId: s.winnerId,
      winnerUsername: s.winnerId ? s.members[s.winnerId]?.username : null,
      question: this.questionForNonHost(),
      players: this.seatSummary(s.phase === 'reveal' || s.phase === 'payout' || s.phase === 'gameover'),
    };
  }

  /** Party mode's single per-player view — used for every seat member, including the host. */
  partySnapshot(userId: string) {
    const s = this.state;
    const m = s.members[userId];
    if (!m) return null;
    const others = this.activePartyMembers()
      .filter((p) => p.userId !== userId)
      .map((p) => ({ userId: p.userId, username: p.username, chips: p.chips, answered: p.answer !== '', acted: p.partyActed }));
    return {
      role: 'party' as const,
      phase: s.phase,
      userId: m.userId,
      username: m.username,
      chips: m.chips,
      eliminated: m.eliminated,
      answer: m.answer,
      partyBet: m.partyBet,
      minAnte: Math.max(1, Math.round(m.chips * 0.05)),
      partyActed: m.partyActed,
      ready: m.ready,
      question: this.questionForNonHost(),
      revealedHints: s.revealedHints,
      partyPhaseEndsAt: s.partyPhaseEndsAt,
      partyResults: s.phase === 'partyReveal' || s.phase === 'partyPayout' ? s.partyResults : null,
      partyLeaderboard: s.phase === 'partyReveal' || s.phase === 'partyPayout' ? s.partyLeaderboard : null,
      myLeaderboardRank: m.prevLeaderboardRank,
      winnerId: s.winnerId,
      winnerUsername: s.winnerId ? s.members[s.winnerId]?.username : null,
      others,
    };
  }
}
