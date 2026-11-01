import type { DataVisibility, DataWriteScope, LobbyChangeReason, LobbyServerStatus, LobbyStatus, ServerSupport } from './enums';

// ─── User ────────────────────────────────────────────────────────────────────

/** Vollständiger User-Datensatz (nur server-intern, nie an Clients senden) */
export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: number; // unix ms
}

/** Öffentliche User-Info (sicher an Clients sendbar) */
export interface PublicUser {
  id: string;
  username: string;
}

/** JWT-Payload */
export interface AuthPayload {
  userId: string;
  username: string;
  /** Token-Version (ungültig, sobald das Passwort geändert wurde); fehlt = 0 */
  tv?: number;
}

/** Antwort auf register/login/refresh */
export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

// ─── Lobby ───────────────────────────────────────────────────────────────────


/** Grund einer Lobby-Änderung (zweites Argument von `lobbyUpdated`) */

export interface LobbyPlayer {
  userId: string;
  username: string;
  isHost: boolean;
  /** false = Verbindung verloren, Spieler befindet sich in der Reconnect-Gnadenfrist (Default: true) */
  connected?: boolean;
  /** unix ms — nur gesetzt, solange connected=false */
  disconnectedAt?: number;
}

export interface Lobby {
  id: string;
  /** Spiel-ID, z.B. "tcg" */
  gameId: string;
  name: string;
  hostId: string;
  players: LobbyPlayer[];
  maxPlayers: number;
  status: LobbyStatus;
  /** Private Lobby — taucht nicht in listLobbies auf */
  isPrivate: boolean;
  /** 6-stelliger Einladungscode, nur gesetzt wenn isPrivate=true */
  inviteCode?: string;
  /** Spiel-spezifische Einstellungen, die der Host beim Erstellen setzt */
  settings: Record<string, unknown>;
  /** Nur in Listings: kann man derzeit beitreten? */
  joinable?: boolean;
  /** Game-Server dieser Lobby (nur für Mitglieder; in Listings ersetzt durch serverBound/region) */
  server?: LobbyServerBinding;
  /** Zustand des Game-Servers: ok (Default), lost (Verbindung weg, Resume-Frist läuft), draining (nimmt keine neuen Lobbys an) */
  serverStatus?: LobbyServerStatus;
  /** Nur in Listings: läuft die Lobby auf einem Game-Server? */
  serverBound?: boolean;
  /** Nur in Listings: Region des Game-Servers */
  region?: string;
  /** true = serverseitig verwaltetes Spiel; false = externe App */
  hosted: boolean;
  /** true = Beitritt (auch per Invite-Code) erfordert eine vom Host angenommene Beitrittsanfrage */
  locked: boolean;
  createdAt: number; // unix ms
}


// ─── Game Registry ───────────────────────────────────────────────────────────

/** Eintrag in der Spiel-Registry des Haupt-Servers */
export interface GameInfo {
  id: string;
  name: string;
  description: string;
  /** Maximale Spieleranzahl – vom Spiel definiert, nicht vom Spieler */
  maxPlayers: number;
  /** true  = serverseitig verwaltetes Spiel (Subprocess oder Hub-Relay).
   *  false = externe App, die den Hub nur als Kommunikationskanal nutzt. */
  hosted: boolean;
  /** Relativer Pfad zum Subprocess-Entry-Script (von server/ aus).
   *  Optional — fehlt er, läuft das Spiel als reines Relay (kein Subprocess). */
  entryScript?: string;
  /** Externer Link (nur für hosted=false).
   *  Wird auf der Hub-Startseite als "Zum Spiel"-Button angezeigt und in einem neuen Tab geöffnet. */
  link?: string;
  /** Reconnect-Gnadenfrist in ms, in der ein getrennter Spieler seinen Lobby-Platz behält.
   *  0 = sofort entfernen. Default: 60000. */
  reconnectGraceMs?: number;
  /** Minimale Client-Version (numerisch vergleichbar, z.B. "1.2.0"); ältere Clients werden bei registerGame abgelehnt. */
  minClientVersion?: string;
  /** Maximale Größe der Lobby-Settings als JSON in Bytes (Default 8192). */
  maxSettingsBytes?: number;
  /** Wenn gesetzt: nur diese Settings-Keys sind in Lobby-Listen für Nicht-Mitglieder sichtbar. */
  publicSettingKeys?: string[];
  /** Keys (Regex-Strings, auf den ganzen Key angewendet), die nur der Game-Subprocess schreiben darf. */
  serverKeys?: string[];
  /** Darf man einer Lobby im Status in_progress beitreten? Default false. */
  joinInProgress?: boolean;
  /** Was passiert, wenn der Host geht: 'transfer' (Default, bevorzugt verbundene Spieler), 'next_connected' (nur verbundene, sonst auflösen), 'dissolve'. */
  hostMigration?: 'transfer' | 'next_connected' | 'dissolve';
  /** Max. Größe binärer Relay-Nachrichten in Bytes (überschreibt den Hub-Default). */
  maxBinaryBytes?: number;
  /** Zusätzliche Umgebungsvariablen, die an den Subprocess durchgereicht werden dürfen. */
  envPassthrough?: string[];
  /** Unterstützt das Spiel Game-Server-Anwendungen? 'none' (Default): nie; 'optional': Lobby darf mit oder ohne Server laufen; 'required': Lobbys brauchen immer einen Server. */
  serverSupport?: ServerSupport;
  /** Bekannte Regionen für Game-Server (nur sinnvoll bei serverSupport != 'none'). */
  regions?: string[];
}


/** Bindung einer Lobby an einen Game-Server (0..1 pro Lobby). Mitglieder sehen die serverId, Listings nicht. */
export interface LobbyServerBinding {
  serverId: string;
  region?: string;
}

// ─── IPC: Hub ↔ Game-Subprocess ─────────────────────────────────────────────

/** Nachrichten vom Hub an den Game-Subprocess (via IPC) */
export type IpcHubToGame =
  /** Erste Nachricht nach dem Spawn: Lobby-Kontext (ersetzt die Env-Variablen als Quelle der Wahrheit) */
  | { type: 'INIT'; payload: { lobbyId: string; gameId: string; settings: Record<string, unknown>; players: Array<{ userId: string; username: string }> } }
  | { type: 'PLAYER_ACTION'; payload: { userId: string; action: string; data: unknown } }
  /** Neuer Spieler hat die Lobby betreten (nach dem initialen Spawn) */
  | { type: 'PLAYER_JOIN'; payload: { userId: string; username: string } }
  /** Verbindung des Spielers ist weggebrochen; er bleibt für die Reconnect-Gnadenfrist Lobby-Mitglied.
   *  Folgt entweder PLAYER_RECONNECT oder (nach Ablauf) PLAYER_LEAVE. */
  | { type: 'PLAYER_DISCONNECT'; payload: { userId: string } }
  /** Spieler hat sich innerhalb der Gnadenfrist wieder verbunden. */
  | { type: 'PLAYER_RECONNECT'; payload: { userId: string; username: string } }
  /** Spieler hat die Lobby endgültig verlassen (explizites leaveLobby, kickPlayer oder Ablauf
   *  der Reconnect-Gnadenfrist) — im Gegensatz zu PLAYER_DISCONNECT gibt es keine Rückkehr mehr. */
  | { type: 'PLAYER_LEAVE'; payload: { userId: string } }
  /** Antwort auf GET_USER_DATA */
  | { type: 'USER_DATA_RESPONSE'; payload: { requestId: string; userId: string; gameId: string; data: Record<string, unknown> } };

/** Nachrichten vom Game-Subprocess an den Hub (via IPC) */
export type IpcGameToHub =
  | { type: 'READY' }
  | { type: 'GAME_STATE'; payload: unknown }
  /** Wie GAME_STATE, aber nur an den Socket dieses einen Users gesendet (nicht an den ganzen Raum) */
  | { type: 'GAME_STATE_FOR_USER'; payload: { userId: string; state: unknown } }
  | { type: 'GAME_EVENT'; payload: { type: string; data: unknown } }
  /** Das Spiel hat begonnen: Lobby wechselt in den Status in_progress */
  | { type: 'GAME_STARTED' }
  | { type: 'GAME_OVER'; payload: unknown }
  /**
   * Subprocess schreibt Zusammenfassungsdaten für einen Spieler in die Hub-DB.
   * Wird z.B. nach Spielende aufgerufen um Ergebnisse dauerhaft zu speichern.
   * `data` wird mit den vorhandenen Metadaten zusammengeführt (merge).
   */
  | { type: 'SAVE_META'; payload: { userId: string; gameId: string; entries: Array<{ key: string; value: unknown; visibility?: DataVisibility; writeScope?: DataWriteScope }> } }
  | { type: 'LOG'; payload: string }
  /** Subprocess möchte User-Daten aus dem Hub lesen */
  | { type: 'GET_USER_DATA'; payload: { requestId: string; userId: string; gameId: string } };

// ─── User Data ──────────────────────────────────────────────────────────────

/** Sichtbarkeit eines User-Data-Keys */

/** Ein einzelner Key-Value-Eintrag in den User-Daten */
export interface UserDataEntry {
  key: string;
  value: unknown;
  visibility: DataVisibility;
  updatedAt: number; // unix ms
  /** 'client' = Besitzer darf schreiben; 'server' = nur der Game-Subprocess (read-only für den Client) */
  writeScope: DataWriteScope;
  /** Wird bei jedem Schreiben erhöht (Basis für spätere optimistische Concurrency) */
  version: number;
}


// ─── Presence ────────────────────────────────────────────────────────────────

/** Ein aktuell verbundener Nutzer (Online-Präsenz) */
export interface PresenceUser {
  userId: string;
  username: string;
  /** Lobby-ID, falls der User gerade in einer Lobby ist */
  lobbyId?: string;
  /** Spiel-ID, falls der User gerade in einem Spiel ist */
  gameId?: string;
  /** Lobby-Status zum Zeitpunkt des letzten Presence-Updates.
   *  Nur gesetzt wenn lobbyId vorhanden. 'open' = beitrittbar, 'full'/'closed' = nicht mehr. */
  lobbyStatus?: LobbyStatus;
}

export interface RelayMessage<TPayload = unknown> {
  from: string;
  /** Fortlaufende Nummer pro Lobby (Reihenfolge-Erkennung); fehlt bei Replays nicht */
  seq?: number;
  type: string;
  payload: TPayload;
}

export interface RelayBinaryMessage<TPayload = Uint8Array> {
  from: string;
  seq?: number;
  typeCode: number;
  payload: TPayload;
}

// ─── Panel ───────────────────────────────────────────────────────────────────

/**
 * Spielspezifische Aktion, die im Social Panel als Button erscheint.
 * Wird vom Spiel via `window.EthernalPanel.registerAction(action)` registriert.
 * `onClick` ist browser-only und wird nicht über das Netzwerk übertragen.
 */
export interface PanelAction {
  /** Eindeutige ID – für removeAction() und Deduplizierung */
  id: string;
  /** Angezeigter Text im Button */
  label: string;
  /** Optionales Emoji/Icon vor dem Label */
  icon?: string;
  /** 'default' | 'danger' — steuert Farbe des Buttons */
  style?: 'default' | 'danger';
  /** Callback der im Spiel ausgeführt wird, wenn der User klickt */
  onClick: () => void;
}

export * from './enums';
export * from './events';
export * from './errors';
export * from './social';
export * from './gameserver';
