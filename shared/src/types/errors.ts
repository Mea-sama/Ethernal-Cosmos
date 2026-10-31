// ─── Fehlercodes & Ack-Protokoll ─────────────────────────────────────────────

/**
 * Stabile, maschinenlesbare Fehlercodes. Clients/SDKs dürfen sich auf diese Codes verlassen;
 * der `message`-Text (deutsch) ist nur zur Anzeige gedacht und kann sich ändern.
 */
export type ErrorCode =
  // Allgemein
  | 'INVALID_INPUT'
  | 'RATE_LIMITED'
  | 'INTERNAL'
  | 'NOT_FOUND'
  // Auth
  | 'UNAUTHENTICATED'
  | 'INVALID_TOKEN'
  | 'INVALID_CREDENTIALS'
  | 'USERNAME_TAKEN'
  | 'USER_NOT_FOUND'
  | 'INVALID_REFRESH_TOKEN'
  | 'REFRESH_TOKEN_REVOKED'
  | 'REFRESH_TOKEN_EXPIRED'
  // Session / Spielregistrierung
  | 'GAME_NOT_REGISTERED'
  | 'UNKNOWN_GAME'
  | 'CLIENT_OUTDATED'
  | 'LEAVE_LOBBY_FIRST'
  | 'GAME_MISMATCH'
  // Lobby
  | 'ALREADY_IN_LOBBY'
  | 'NOT_IN_LOBBY'
  | 'LOBBY_NOT_FOUND'
  | 'LOBBY_CLOSED'
  | 'LOBBY_LOCKED'
  | 'LOBBY_FULL'
  | 'LOBBY_PRIVATE'
  | 'INVALID_INVITE_CODE'
  | 'INVITE_CODE_NOT_FOUND'
  | 'NOT_HOST'
  | 'ALREADY_HOST'
  | 'CANNOT_KICK_SELF'
  | 'PLAYER_NOT_FOUND'
  | 'LOBBY_START_FAILED'
  | 'LOBBY_IN_PROGRESS'
  | 'INSTANCE_LIMIT'
  | 'INVALID_STATE'
  | 'CANNOT_TARGET_SELF'
  | 'PAYLOAD_TOO_LARGE'
  | 'INVALID_MESSAGE_TYPE'
  | 'AUTH_EXPIRED'
  | 'SETTINGS_TOO_LARGE'
  | 'JOIN_REQUEST_NOT_FOUND'
  // Relay
  | 'PLAYER_NOT_IN_LOBBY'
  | 'PLAYER_UNREACHABLE'
  | 'INVALID_LOBBY_CONTEXT'
  | 'INVALID_BINARY_TYPECODE'
  | 'INVALID_BINARY_PAYLOAD'
  | 'BINARY_PAYLOAD_TOO_LARGE'
  | 'GAME_NOT_RUNNING'
  // User-Daten
  | 'DATA_READ_ONLY'
  | 'DATA_QUOTA_EXCEEDED'
  | 'DATA_VALUE_TOO_LARGE'
  | 'DATA_KEY_NOT_FOUND'
  // Social
  | 'NOT_FRIENDS'
  | 'FRIEND_REQUEST_NOT_FOUND'
  | 'FRIEND_LIMIT_REACHED'
  | 'REQUEST_LIMIT_REACHED'
  | 'FRIEND_OFFLINE'
  | 'FRIEND_NOT_IN_LOBBY'
  | 'INVITE_NOT_FOUND'
  | 'MESSAGE_TOO_LONG';

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
}

/** Antwort auf jedes Client→Server-Event, wenn der Client einen Ack-Callback übergibt */
export type AckResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: HubErrorPayload };

export type Ack<T = Record<string, never>> = (result: AckResult<T>) => void;
