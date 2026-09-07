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
}

/** Antwort auf register/login/refresh */
export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

// ─── Lobby ───────────────────────────────────────────────────────────────────

export type LobbyStatus = 'open' | 'full' | 'closed';

export interface LobbyPlayer {
  userId: string;
  username: string;
  isHost: boolean;
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
  /** true = serverseitig verwaltetes Spiel; false = externe App */
  hosted: boolean;
  /** true = Beitritt (auch per Invite-Code) erfordert eine vom Host angenommene Beitrittsanfrage */
  locked: boolean;
  createdAt: number; // unix ms
}

/** Grund, warum eine Beitrittsanfrage abgelehnt/beendet wurde */
export type JoinRequestRejectReason = 'declined' | 'timeout' | 'host_changed' | 'lobby_closed';

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
}

// ─── IPC: Hub ↔ Game-Subprocess ─────────────────────────────────────────────

/** Nachrichten vom Hub an den Game-Subprocess (via IPC) */
export type IpcHubToGame =
  | { type: 'PLAYER_ACTION'; payload: { userId: string; action: string; data: unknown } }
  /** Neuer Spieler hat die Lobby betreten (nach dem initialen Spawn) */
  | { type: 'PLAYER_JOIN'; payload: { userId: string; username: string } }
  | { type: 'PLAYER_DISCONNECT'; payload: { userId: string } }
  /** Spieler hat die Lobby endgültig verlassen (explizites leaveLobby oder kickPlayer) —
   *  im Gegensatz zu PLAYER_DISCONNECT gibt es keine Reconnect-Gnadenfrist. */
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
  | { type: 'GAME_OVER'; payload: unknown }
  /**
   * Subprocess schreibt Zusammenfassungsdaten für einen Spieler in die Hub-DB.
   * Wird z.B. nach Spielende aufgerufen um Ergebnisse dauerhaft zu speichern.
   * `data` wird mit den vorhandenen Metadaten zusammengeführt (merge).
   */
  | { type: 'SAVE_META'; payload: { userId: string; gameId: string; entries: Array<{ key: string; value: unknown; visibility?: DataVisibility }> } }
  | { type: 'LOG'; payload: string }
  /** Subprocess möchte User-Daten aus dem Hub lesen */
  | { type: 'GET_USER_DATA'; payload: { requestId: string; userId: string; gameId: string } };

// ─── User Data ──────────────────────────────────────────────────────────────

/** Sichtbarkeit eines User-Data-Keys */
export type DataVisibility = 'private' | 'lobby' | 'public';

/** Ein einzelner Key-Value-Eintrag in den User-Daten */
export interface UserDataEntry {
  key: string;
  value: unknown;
  visibility: DataVisibility;
  updatedAt: number; // unix ms
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
  type: string;
  payload: TPayload;
}

export interface RelayBinaryMessage<TPayload = Uint8Array> {
  from: string;
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

// ─── Socket.io Events ────────────────────────────────────────────────────────

/** Events vom Client zum Haupt-Server */
export interface ClientToServerEvents {
  /** Neue Lobby erstellen – maxPlayers kommt aus der Game-Registry, nicht vom Client */
  createLobby: (data: {
    gameId: string;
    name: string;
    isPrivate?: boolean;
    settings?: Record<string, unknown>;
  }) => void;

  /** Einer bestehenden Lobby beitreten */
  joinLobby: (data: { lobbyId: string }) => void;

  /** Einer privaten Lobby per Einladungscode beitreten */
  joinLobbyByCode: (data: { code: string }) => void;

  /** Aktuelle Lobby verlassen */
  leaveLobby: () => void;

  /** Liste aller offenen Lobbys für ein bestimmtes Spiel abrufen */
  listLobbies: (gameId: string) => void;

  /** Spielaktion an den laufenden Game-Subprocess weiterleiten */
  gameAction: (data: { type: string; payload: unknown }) => void;

  /** Snapshot des aktuellen Lobby-Zustands abrufen */
  getLobbyInfo: () => void;

  /** Host: Spieler aus der Lobby entfernen */
  kickPlayer: (data: { playerId: string }) => void;

  /** Host: Host-Rolle an anderen Spieler übertragen */
  transferHost: (data: { playerId: string }) => void;

  /** Host: Lobby sperren — Beitritt (auch per Invite-Code) erfordert danach eine Anfrage */
  lockLobby: () => void;

  /** Host: Lobby wieder entsperren — normaler Beitritt funktioniert wieder direkt */
  unlockLobby: () => void;

  /** Beitritt zu einer gesperrten Lobby anfragen (per Lobby-ID) */
  requestJoinLobby: (data: { lobbyId: string }) => void;

  /** Beitritt zu einer gesperrten Lobby anfragen (per Invite-Code) */
  requestJoinLobbyByCode: (data: { code: string }) => void;

  /** Eigene, noch offene Beitrittsanfrage zurückziehen */
  cancelJoinRequest: (data: { lobbyId: string }) => void;

  /** Host: eine eingegangene Beitrittsanfrage annehmen oder ablehnen */
  respondJoinRequest: (data: { requesterId: string; accept: boolean }) => void;

  /** Nachricht an alle anderen Spieler in der Lobby senden (Relay) */
  sendToLobby: (data: { type: string; payload: unknown }) => void;

  /** Binäre Nachricht an alle anderen Spieler in der Lobby senden (Relay) */
  sendToLobbyBinary: (data: { typeCode: number; payload: Uint8Array }) => void;

  /** Nachricht direkt an einen einzelnen Spieler senden (Relay) */
  sendToPlayer: (data: { playerId: string; type: string; payload: unknown }) => void;

  /** Binäre Nachricht direkt an einen einzelnen Spieler senden (Relay) */
  sendToPlayerBinary: (data: { playerId: string; typeCode: number; payload: Uint8Array }) => void;

  /** User-Daten für ein Spiel abrufen (Alternative zu REST GET /userdata/:gameId) */
  getUserData: (gameId: string) => void;

  /** Sichtbare Daten eines anderen Spielers abrufen (Alternative zu REST GET /players/:id/data/:gameId) */
  getPlayerData: (data: { playerId: string; gameId: string }) => void;

  /** Aktuelle Online-Präsenz-Liste anfordern */
  'presence:list': () => void;
}

/** Events vom Haupt-Server zum Client */
export interface ServerToClientEvents {
  /** Lobby wurde erstellt (Bestätigung für den Host) */
  lobbyCreated: (lobby: Lobby) => void;

  /** Lobby-Zustand hat sich geändert (Spieler beigetreten/verlassen) */
  lobbyUpdated: (lobby: Lobby) => void;

  /** Aktuelle Lobby-Liste als Antwort auf listLobbies */
  lobbyList: (lobbies: Lobby[]) => void;

  /**
   * Spiel startet – Client wechselt in die Game-Szene.
   * Spielkommunikation läuft weiterhin über denselben Hub-Socket.
   */
  gameStarting: (data: { lobbyId: string; gameId: string }) => void;

  /** Vollständiger Spielzustand vom Subprocess (nach jeder Aktion gebroadcastet) */
  gameState: (state: unknown) => void;

  /** Einzelnes Spielereignis (z.B. Karteneffekt-Animation) */
  gameEvent: (event: { type: string; data: unknown }) => void;

  /** Spiel ist beendet */
  gameOver: (result: unknown) => void;

  /** Fehlermeldung vom Server */
  error: (message: string) => void;

  /** Snapshot der aktuellen Lobby (Antwort auf getLobbyInfo) */
  lobbyInfo: (lobby: Lobby) => void;

  /** Du wurdest von einem Host aus der Lobby entfernt */
  playerKicked: (data: { lobbyId: string }) => void;

  /** Eingehende Relay-Nachricht von einem anderen Spieler */
  message: (data: RelayMessage) => void;

  /** Eingehende binäre Relay-Nachricht von einem anderen Spieler */
  messageBinary: (data: RelayBinaryMessage) => void;

  /** Antwort auf getUserData — eigene Daten als Key-Value-Liste */
  userData: (data: { gameId: string; entries: UserDataEntry[] }) => void;

  /** Antwort auf getPlayerData — sichtbare Daten eines anderen Spielers */
  playerData: (data: { playerId: string; gameId: string; entries: UserDataEntry[] }) => void;

  /** Ein neuer User hat sich verbunden (Presence) */
  'presence:joined': (user: PresenceUser) => void;

  /** Ein User hat die Verbindung getrennt (Presence) */
  'presence:left': (data: { userId: string }) => void;

  /** Antwort auf presence:list — alle aktuell verbundenen User */
  'presence:list': (users: PresenceUser[]) => void;

  /** Host: eine neue Beitrittsanfrage ist eingegangen */
  joinRequestReceived: (data: { lobbyId: string; requesterId: string; username: string }) => void;

  /** Bestätigung an den Anfragenden: die Anfrage wurde gesendet und wartet auf den Host */
  joinRequestPending: (data: { lobbyId: string }) => void;

  /** Der Host hat die Anfrage angenommen — Beitritt wurde bereits serverseitig vollzogen */
  joinRequestAccepted: (data: { lobby: Lobby }) => void;

  /** Die Anfrage wurde beendet, ohne dass beigetreten wurde */
  joinRequestRejected: (data: { lobbyId: string; reason: JoinRequestRejectReason }) => void;

  /** Host: eine Anfrage wurde zurückgezogen oder ist ausgelaufen, bevor der Host reagiert hat */
  joinRequestWithdrawn: (data: { requesterId: string; reason: 'cancelled' | 'timeout' }) => void;
}

/** Interne Socket-Daten pro verbundenem Client */
export interface SocketData {
  userId: string;
  username: string;
  currentLobbyId?: string;
  /** 'game' = Spielclient; 'panel' = Social-Panel (selber User, selbes Gerät) */
  clientType: 'game' | 'panel';
}


