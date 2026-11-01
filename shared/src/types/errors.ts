// ─── Fehlercodes & Ack-Protokoll ─────────────────────────────────────────────

import type { ErrorCode } from './enums';

/** Fehlerobjekt, wie es in Acks, `errorDetail`-Events und REST-Antworten (`code`) vorkommt */
export interface HubErrorPayload {
  code: ErrorCode;
  message: string;
  /** Name des Events, das den Fehler ausgelöst hat (nur Socket) */
  event?: string;
  /** Optional vom Client mitgegebene Korrelations-ID (`requestId` im Event-Payload) */
  requestId?: string;
  /** Bei RATE_LIMITED: frühestens nach dieser Zeit erneut versuchen */
  retryAfterMs?: number;
  /** Zusatzdaten, z.B. bei VERSION_CONFLICT `{ current: { value, version } | null }` */
  data?: Record<string, unknown>;
}

/** Antwort auf jedes Client→Server-Event, wenn der Client einen Ack-Callback übergibt */
export type AckResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: HubErrorPayload };

export type Ack<T = Record<string, never>> = (result: AckResult<T>) => void;
