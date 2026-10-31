import type {
  Lobby,
  GameInfo,
  JoinRequestRejectReason,
  PresenceUser,
  RelayMessage,
  RelayBinaryMessage,
  UserDataEntry,
  DataVisibility,
} from './index';
import type { Ack, HubErrorPayload } from './errors';

/** Aktuelle Protokollversion; wird im `hello`-Event mitgeschickt. Bei Breaking Changes erhöhen. */
export const PROTOCOL_VERSION = 2;

/** Features, die der Server im `hello`-Event ankündigt (Feature-Detection für SDKs). */
export type ServerCapability =
  | 'acks'
  | 'gameRegistration'
  | 'reconnect'
  | 'userDataWriteScope'
  | 'userDataSocketWrite';

export interface HelloPayload {
  protocolVersion: number;
  serverTime: number;
  sessionId: string;
  capabilities: ServerCapability[];
  /** Spiel, an das der User aktuell gebunden ist (z.B. nach Resume aus einer Lobby) */
  gameId?: string;
  /** Lobby, in der der User bereits Mitglied ist (Resume / zweites Gerät) */
  lobbyId?: string;
}

/** Zustand der Session des Users (Antwort auf `session:getState` und Teil von Acks) */
export interface SessionState {
  sessionId: string;
  userId: string;
  username: string;
  gameId?: string;
  lobbyId?: string;
}

export interface BulkDataEntry {
  key: string;
  value: unknown;
  visibility?: DataVisibility;
}

// ─── Socket.io Events ────────────────────────────────────────────────────────
// Jedes Client→Server-Event akzeptiert als letztes Argument einen optionalen Ack-Callback
// (siehe errors.ts). Fehler kommen zusätzlich weiterhin als `error`-String-Event (Legacy)
// und als `errorDetail`-Event.

/** Events vom Client zum Haupt-Server */
export interface ClientToServerEvents {
  /** Spiel registrieren — Voraussetzung für Lobbys, Relay und gameAction */
  'session:registerGame': (
    data: { gameId: string; clientVersion?: string; platform?: string },
    ack?: Ack<{ game: GameInfo; state: SessionState }>
  ) => void;

  /** Aktuellen Session-Zustand abrufen (Pull-Variante zu `hello`/`session:resumed`) */
  'session:getState': (ack?: Ack<{ state: SessionState; lobby?: Lobby }>) => void;

  /** Neue Lobby für das registrierte Spiel erstellen – maxPlayers kommt aus der Game-Registry */
  createLobby: (
    data: { name: string; isPrivate?: boolean; settings?: Record<string, unknown>; requestId?: string },
    ack?: Ack<{ lobby: Lobby }>
  ) => void;

  /** Einer bestehenden (öffentlichen) Lobby des eigenen Spiels beitreten */
  joinLobby: (data: { lobbyId: string; requestId?: string }, ack?: Ack<{ lobby: Lobby }>) => void;

  /** Einer Lobby per Einladungscode beitreten */
  joinLobbyByCode: (data: { code: string; requestId?: string }, ack?: Ack<{ lobby: Lobby }>) => void;

  /** Aktuelle Lobby verlassen */
  leaveLobby: (ack?: Ack) => void;

  /** Offene, öffentliche Lobbys des registrierten Spiels abrufen (Legacy-Argument gameId wird ignoriert) */
  listLobbies: (gameIdOrAck?: string | Ack<{ lobbies: Lobby[] }>, ack?: Ack<{ lobbies: Lobby[] }>) => void;

  /** Spielaktion an den laufenden Game-Subprocess weiterleiten */
  gameAction: (data: { type: string; payload: unknown; requestId?: string }, ack?: Ack) => void;

  /** Snapshot des aktuellen Lobby-Zustands abrufen */
  getLobbyInfo: (ack?: Ack<{ lobby: Lobby }>) => void;

  /** Host: Spieler aus der Lobby entfernen */
  kickPlayer: (data: { playerId: string; requestId?: string }, ack?: Ack) => void;

  /** Host: Host-Rolle an anderen Spieler übertragen */
  transferHost: (data: { playerId: string; requestId?: string }, ack?: Ack) => void;

  /** Host: Lobby sperren — Beitritt (auch per Invite-Code) erfordert danach eine Anfrage */
  lockLobby: (ack?: Ack) => void;

  /** Host: Lobby wieder entsperren */
  unlockLobby: (ack?: Ack) => void;

  /** Beitritt zu einer gesperrten Lobby anfragen (per Lobby-ID) */
  requestJoinLobby: (data: { lobbyId: string; requestId?: string }, ack?: Ack<{ pending: boolean; lobby?: Lobby }>) => void;

  /** Beitritt zu einer gesperrten Lobby anfragen (per Invite-Code) */
  requestJoinLobbyByCode: (data: { code: string; requestId?: string }, ack?: Ack<{ pending: boolean; lobby?: Lobby }>) => void;

  /** Eigene, noch offene Beitrittsanfrage zurückziehen */
  cancelJoinRequest: (data: { lobbyId: string; requestId?: string }, ack?: Ack) => void;

  /** Host: eine eingegangene Beitrittsanfrage annehmen oder ablehnen */
  respondJoinRequest: (data: { requesterId: string; accept: boolean; requestId?: string }, ack?: Ack) => void;

  /** Nachricht an alle anderen Spieler in der Lobby senden (Relay) */
  sendToLobby: (data: { type: string; payload: unknown; requestId?: string }, ack?: Ack) => void;

  /** Binäre Nachricht an alle anderen Spieler in der Lobby senden (Relay) */
  sendToLobbyBinary: (data: { typeCode: number; payload: Uint8Array; requestId?: string }, ack?: Ack) => void;

  /** Nachricht direkt an einen einzelnen Spieler derselben Lobby senden (Relay) */
  sendToPlayer: (data: { playerId: string; type: string; payload: unknown; requestId?: string }, ack?: Ack) => void;

  /** Binäre Nachricht direkt an einen einzelnen Spieler derselben Lobby senden (Relay) */
  sendToPlayerBinary: (data: { playerId: string; typeCode: number; payload: Uint8Array; requestId?: string }, ack?: Ack) => void;

  /** Eigene User-Daten für ein Spiel abrufen (Alternative zu REST GET /userdata/:gameId) */
  getUserData: (gameId: string, ack?: Ack<{ gameId: string; entries: UserDataEntry[] }>) => void;

  /** Einen eigenen Key schreiben (Alternative zu REST PUT). Keys mit writeScope 'server' sind gesperrt. */
  setUserData: (
    data: { gameId: string; key: string; value: unknown; visibility?: DataVisibility; requestId?: string },
    ack?: Ack
  ) => void;

  /** Mehrere eigene Keys atomar schreiben (Alternative zu REST PATCH) */
  bulkSetUserData: (data: { gameId: string; entries: BulkDataEntry[]; requestId?: string }, ack?: Ack) => void;

  /** Einen eigenen Key löschen (Alternative zu REST DELETE) */
  deleteUserData: (data: { gameId: string; key: string; requestId?: string }, ack?: Ack) => void;

  /** Sichtbare Daten eines anderen Spielers abrufen */
  getPlayerData: (
    data: { playerId: string; gameId: string; requestId?: string },
    ack?: Ack<{ playerId: string; gameId: string; entries: UserDataEntry[] }>
  ) => void;

  /** Aktuelle Online-Präsenz-Liste anfordern */
  'presence:list': (ack?: Ack<{ users: PresenceUser[] }>) => void;
}

/** Events vom Haupt-Server zum Client */
export interface ServerToClientEvents {
  /** Wird direkt nach erfolgreichem Verbindungsaufbau gesendet */
  hello: (data: HelloPayload) => void;

  /** Die Verbindung wurde innerhalb der Reconnect-Gnadenfrist wieder aufgenommen oder
   *  eine bestehende Lobby-Mitgliedschaft wurde an diese Session gebunden */
  'session:resumed': (data: { state: SessionState; lobby: Lobby }) => void;

  /** Diese Session wurde durch eine neuere Game-Session desselben Users ersetzt (danach Disconnect) */
  'session:replaced': (data: { reason: 'new_session' }) => void;

  /** Lobby wurde erstellt (Bestätigung für den Host) */
  lobbyCreated: (lobby: Lobby) => void;

  /** Lobby-Zustand hat sich geändert (Spieler beigetreten/verlassen/getrennt, Host, Lock …) */
  lobbyUpdated: (lobby: Lobby) => void;

  /** Aktuelle Lobby-Liste als Antwort auf listLobbies */
  lobbyList: (lobbies: Lobby[]) => void;

  /** Spiel startet – Client wechselt in die Game-Szene. */
  gameStarting: (data: { lobbyId: string; gameId: string }) => void;

  /** Spielzustand vom Subprocess */
  gameState: (state: unknown) => void;

  /** Einzelnes Spielereignis */
  gameEvent: (event: { type: string; data: unknown }) => void;

  /** Spiel ist beendet */
  gameOver: (result: unknown) => void;

  /** Fehlermeldung (Legacy: nur Text). Strukturierte Variante: `errorDetail` bzw. Ack. */
  error: (message: string) => void;

  /** Strukturierter Fehler mit stabilem Code */
  errorDetail: (error: HubErrorPayload) => void;

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

  /** Ein User hat sich verbunden / seinen Lobby-Kontext geändert (Presence) */
  'presence:joined': (user: PresenceUser) => void;

  /** Ein User hat die Verbindung getrennt (Presence) */
  'presence:left': (data: { userId: string }) => void;

  /** Antwort auf presence:list */
  'presence:list': (users: PresenceUser[]) => void;

  /** Host: eine neue Beitrittsanfrage ist eingegangen */
  joinRequestReceived: (data: { lobbyId: string; requesterId: string; username: string }) => void;

  /** Bestätigung an den Anfragenden: die Anfrage wurde gesendet und wartet auf den Host */
  joinRequestPending: (data: { lobbyId: string }) => void;

  /** Der Host hat die Anfrage angenommen — Beitritt wurde bereits serverseitig vollzogen */
  joinRequestAccepted: (data: { lobby: Lobby }) => void;

  /** Die Anfrage wurde beendet, ohne dass beigetreten wurde */
  joinRequestRejected: (data: { lobbyId: string; reason: JoinRequestRejectReason }) => void;

  /** Host: eine Anfrage wurde zurückgezogen oder ist ausgelaufen */
  joinRequestWithdrawn: (data: { requesterId: string; reason: 'cancelled' | 'timeout' }) => void;
}

/** Interne Socket-Daten pro verbundenem Client */
export interface SocketData {
  userId: string;
  username: string;
  sessionId: string;
  /** 'game' = Spielclient; 'panel' = Social-Panel (selber User, selbes Gerät) */
  clientType: 'game' | 'panel';
}
