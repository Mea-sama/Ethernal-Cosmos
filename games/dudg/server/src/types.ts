// ─── Phases ──────────────────────────────────────────────────────────────────

export const PHASES = [
  'setup', // host adding questions / not started yet
  'collecting',
  'bid1',
  'hint1',
  'bid2',
  'hint2',
  'bid3',
  'answer',
  'bid4',
  'reveal',
  'payout',
] as const;

/** Party mode's own, simpler, fully-automatic phase track (no host control). */
export const PARTY_PHASES = [
  'partyCollecting',
  'partyHint1',
  'partyHint2',
  'partyReveal',
  'partyPayout',
] as const;

export type Phase = (typeof PHASES)[number] | (typeof PARTY_PHASES)[number] | 'gameover';

export type Mode = 'classic' | 'party';

export type Role = 'contestant' | 'spectator';

// ─── Question ────────────────────────────────────────────────────────────────

export interface QuestionOption {
  letter: string;
  text: string;
  html: string;
  value: string | null;
  valueHtml: string | null;
}

export interface Question {
  filename: string;
  questionHtml: string;
  questionText: string;
  moderatorHtml: string | null;
  mediaHtml: string | null;
  audioSrc: string | null;
  hint1: string | null;
  hint2: string | null;
  hint1Html: string | null;
  hint2Html: string | null;
  answer: string | null;
  answerHtml: string | null;
  options: QuestionOption[] | null;
  optionRank: string[] | null;
  questionType: 'standard' | 'options';
  labels: string[];
}

/** Metadata-only view of a question (no answer/hints/media) — safe to expose pre-reveal. */
export interface QuestionMeta {
  filename: string;
  title: string;
  labels: string[];
  source: 'basic' | 'custom';
}

// ─── Members (host / contestants / spectators) ──────────────────────────────

export interface Member {
  userId: string;
  username: string;
  role: Role;
  connected: boolean;
  /** -1 = never became a contestant (pure spectator) */
  seatIndex: number;
  chips: number;
  answer: string;
  answerLocked: boolean;
  folded: boolean;
  allIn: boolean;
  eliminated: boolean;
  currentBet: number;
  jokerUsed: boolean;
  /** Permanently left the lobby (explicit leave/kick) — excluded from all future state pushes. */
  left: boolean;
  // ─── Party mode only ──────────────────────────────────────────────────────────
  /** Timestamp of this round's first answer submission — used as the speed tiebreak. */
  answeredAt: number | null;
  /** This round's current bet (separate from chips — settled at partyReveal). */
  partyBet: number;
  /** True once this member has acted (raised or checked) in the current hint phase. */
  partyActed: boolean;
  /** True once this member has clicked "Ready" after a partyReveal/partyPayout. */
  ready: boolean;
  /** Overall standings rank (by chips) after the previous round — null before the first leaderboard. */
  prevLeaderboardRank: number | null;
}

/** One player's result row for the most recently revealed party round. */
export interface PartyResultRow {
  userId: string;
  username: string;
  rank: number;
  distance: number;
  exact: boolean;
  betBefore: number;
  percent: number;
  prize: number;
  chipsAfter: number;
}

/** One row of the overall (all-rounds) chip standings, with this round's movement. */
export interface PartyLeaderboardRow {
  userId: string;
  username: string;
  chips: number;
  rank: number;
  /** Positive = climbed, negative = fell, 0 = unchanged (or first round). */
  rankDelta: number;
  /** Chip change this round (prize − bet). */
  net: number;
}

// ─── Session config ──────────────────────────────────────────────────────────

export interface SessionConfig {
  startingChips: number;
  sbAmount: number;
  bbAmount: number;
  jokerEnabled: boolean;
}

// ─── Full engine state ───────────────────────────────────────────────────────

export interface EngineState {
  phase: Phase;
  hostId: string;
  hostUsername: string;
  members: Record<string, Member>;
  /** userIds of contestants in seat order — fixed once the game starts */
  seatOrder: string[];
  /** filenames added to this lobby's active pool (host-curated, locks at game start) */
  questionPool: string[];
  poolLocked: boolean;
  usedQuestions: string[];
  currentQuestion: Question | null;
  pot: number;
  currentHighBet: number;
  dealerIndex: number;
  bettingOrderIndex: number;
  lastRaiserIndex: number | null;
  revealedHints: string[];
  answerRevealed: boolean;
  winnerId: string | null;
  sessionConfig: SessionConfig;
  jokerActiveUserId: string | null;
  jokerAnswer: string | null;
  jokerNote: string | null;
  // ─── Party mode only ──────────────────────────────────────────────────────────
  /** 'classic' vs 'party' — chosen at setup, locked once the game starts. */
  mode: Mode;
  /** Epoch ms when the current timer-capped party phase auto-advances — for client countdowns. */
  partyPhaseEndsAt: number | null;
  /** Most recently computed ranking/payout — shown during partyReveal/partyPayout. */
  partyResults: PartyResultRow[] | null;
  /** Overall chip standings with this round's rank movement — shown alongside partyResults. */
  partyLeaderboard: PartyLeaderboardRow[] | null;
}
