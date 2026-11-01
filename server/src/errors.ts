import type { ErrorCode, HubErrorPayload } from '@ethernal/shared';

/** Standardtexte (deutsch, nur zur Anzeige). Clients sollen auf `code` prüfen, nicht auf den Text. */
const MESSAGES: Record<ErrorCode, string> = {
  INVALID_INPUT: 'Ungültige Eingabe',
  RATE_LIMITED: 'Rate limit erreicht',
  INTERNAL: 'Interner Fehler',
  NOT_FOUND: 'Nicht gefunden',
  UNAUTHENTICATED: 'Nicht angemeldet',
  INVALID_TOKEN: 'Ungültiges Token',
  INVALID_CREDENTIALS: 'Benutzername oder Passwort falsch',
  USERNAME_TAKEN: 'Benutzername bereits vergeben',
  USER_NOT_FOUND: 'Benutzer existiert nicht mehr',
  INVALID_REFRESH_TOKEN: 'Ungültiges Refresh-Token',
  REFRESH_TOKEN_REVOKED: 'Refresh-Token wurde widerrufen',
  REFRESH_TOKEN_EXPIRED: 'Refresh-Token abgelaufen',
  GAME_NOT_REGISTERED: 'Bitte zuerst ein Spiel registrieren (session:registerGame)',
  UNKNOWN_GAME: 'Unbekanntes Spiel',
  CLIENT_OUTDATED: 'Client-Version ist zu alt',
  LEAVE_LOBBY_FIRST: 'Verlasse zuerst deine Lobby, bevor du das Spiel wechselst',
  GAME_MISMATCH: 'Lobby gehört zu einem anderen Spiel',
  ALREADY_IN_LOBBY: 'Du bist bereits in einer Lobby',
  NOT_IN_LOBBY: 'Du bist in keiner Lobby',
  LOBBY_NOT_FOUND: 'Lobby nicht gefunden',
  LOBBY_CLOSED: 'Lobby ist geschlossen',
  LOBBY_LOCKED: 'Lobby ist gesperrt — bitte Beitritt anfragen',
  LOBBY_FULL: 'Lobby ist voll',
  LOBBY_PRIVATE: 'Private Lobby — Beitritt nur per Einladungscode',
  INVALID_INVITE_CODE: 'Ungültiger Einladungscode',
  INVITE_CODE_NOT_FOUND: 'Einladungscode nicht gefunden',
  NOT_HOST: 'Nur der Host darf das',
  ALREADY_HOST: 'Du bist bereits der Host',
  CANNOT_KICK_SELF: 'Du kannst dich nicht selbst kicken',
  PLAYER_NOT_FOUND: 'Spieler nicht in dieser Lobby',
  LOBBY_START_FAILED: 'Lobby konnte nicht gestartet werden',
  SETTINGS_TOO_LARGE: 'Lobby-Einstellungen zu groß',
  JOIN_REQUEST_NOT_FOUND: 'Anfrage nicht gefunden oder bereits abgelaufen',
  PLAYER_NOT_IN_LOBBY: 'Spieler nicht in derselben Lobby',
  PLAYER_UNREACHABLE: 'Spieler nicht erreichbar',
  INVALID_LOBBY_CONTEXT: 'Lobby-Kontext ungültig',
  INVALID_BINARY_TYPECODE: 'Ungültiger Binary-Typcode',
  INVALID_BINARY_PAYLOAD: 'Ungültige Binary-Payload',
  BINARY_PAYLOAD_TOO_LARGE: 'Binary-Payload zu groß',
  GAME_NOT_RUNNING: 'Spiel läuft nicht',
  DATA_READ_ONLY: 'Dieser Schlüssel ist schreibgeschützt (nur serverseitig beschreibbar)',
  DATA_QUOTA_EXCEEDED: 'Speicherkontingent für dieses Spiel überschritten',
  DATA_VALUE_TOO_LARGE: 'Wert zu groß',
  DATA_KEY_NOT_FOUND: 'Key nicht gefunden',
  NOT_FRIENDS: 'Ihr seid keine Freunde',
  FRIEND_REQUEST_NOT_FOUND: 'Freundschaftsanfrage nicht gefunden oder abgelaufen',
  FRIEND_LIMIT_REACHED: 'Maximale Anzahl an Freunden erreicht',
  REQUEST_LIMIT_REACHED: 'Zu viele offene Freundschaftsanfragen',
  FRIEND_OFFLINE: 'Freund ist nicht online',
  FRIEND_NOT_IN_LOBBY: 'Freund ist in keiner Lobby',
  INVITE_NOT_FOUND: 'Einladung nicht gefunden oder abgelaufen',
  MESSAGE_TOO_LONG: 'Nachricht zu lang',
  BLOCK_LIMIT_REACHED: 'Maximale Anzahl blockierter Nutzer erreicht',
  LOBBY_IN_PROGRESS: 'Das Spiel läuft bereits',
  INSTANCE_LIMIT: 'Server ausgelastet (Instanzlimit erreicht)',
  INVALID_STATE: 'Ungültiger Statuswechsel',
  CANNOT_TARGET_SELF: 'Nachricht an sich selbst nicht möglich',
  PAYLOAD_TOO_LARGE: 'Payload zu groß',
  INVALID_MESSAGE_TYPE: 'Ungültiger Nachrichtentyp',
  AUTH_EXPIRED: 'Sitzung abgelaufen',
  INVALID_SERVER_KEY: 'Ungültiger Game-Server-Schlüssel',
  GAME_SERVER_NOT_ALLOWED: 'Dieses Spiel erlaubt keine Game-Server',
  NO_GAME_SERVER_AVAILABLE: 'Kein Game-Server verfügbar',
  NOT_LOBBY_SERVER: 'Diese Lobby gehört nicht zu diesem Game-Server',
  SERVER_UNAVAILABLE: 'Game-Server nicht erreichbar',
};

/** Fehler mit stabilem Code; wird von Socket-Handlern (Ack/errorDetail) und REST (`code`) ausgewertet. */
export class HubError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message ?? MESSAGES[code]);
    this.name = 'HubError';
  }

  toPayload(extra: { event?: string; requestId?: string } = {}): HubErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(extra.event ? { event: extra.event } : {}),
      ...(extra.requestId ? { requestId: extra.requestId } : {}),
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
    };
  }
}

export function isHubError(err: unknown): err is HubError {
  return err instanceof HubError;
}

const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  INVALID_INPUT: 400,
  UNKNOWN_GAME: 400,
  UNAUTHENTICATED: 401,
  INVALID_TOKEN: 401,
  INVALID_CREDENTIALS: 401,
  USER_NOT_FOUND: 401,
  INVALID_REFRESH_TOKEN: 401,
  REFRESH_TOKEN_REVOKED: 401,
  REFRESH_TOKEN_EXPIRED: 401,
  DATA_READ_ONLY: 403,
  NOT_FOUND: 404,
  DATA_KEY_NOT_FOUND: 404,
  NOT_FRIENDS: 403,
  FRIEND_REQUEST_NOT_FOUND: 404,
  INVITE_NOT_FOUND: 404,
  FRIEND_NOT_IN_LOBBY: 404,
  FRIEND_OFFLINE: 409,
  FRIEND_LIMIT_REACHED: 409,
  REQUEST_LIMIT_REACHED: 409,
  BLOCK_LIMIT_REACHED: 409,
  MESSAGE_TOO_LONG: 413,
  LOBBY_IN_PROGRESS: 409,
  INSTANCE_LIMIT: 503,
  INVALID_STATE: 409,
  CANNOT_TARGET_SELF: 400,
  PAYLOAD_TOO_LARGE: 413,
  INVALID_MESSAGE_TYPE: 400,
  AUTH_EXPIRED: 401,
  INVALID_SERVER_KEY: 401,
  GAME_SERVER_NOT_ALLOWED: 403,
  NO_GAME_SERVER_AVAILABLE: 503,
  NOT_LOBBY_SERVER: 403,
  SERVER_UNAVAILABLE: 503,
  USERNAME_TAKEN: 409,
  DATA_VALUE_TOO_LARGE: 413,
  DATA_QUOTA_EXCEEDED: 413,
  RATE_LIMITED: 429,
};

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS[code] ?? 500;
}

/** Sendet einen HubError als REST-Antwort: `{ error: message, code }` (abwärtskompatibel zu `error`). */
export function sendHubError(res: import('express').Response, err: HubError): void {
  res.status(httpStatusFor(err.code)).json({ error: err.message, code: err.code });
}
