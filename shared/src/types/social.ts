// ─── Social: Freunde, Presence, Notifications, DMs, Lobby-Einladungen ─────────

import type { FriendPresenceStatus, FriendRequestSource, LobbyInviteCancelReason, NotificationType, OwnPresenceStatus } from './enums';

/** Einzige Information über einen Freund (erst nach Annahme sichtbar) */
export interface FriendInfo {
  userId: string;
  username: string;
}


export interface FriendRequestInfo {
  id: string;
  /** Bei eingehenden Anfragen der Absender, bei ausgehenden der Empfänger */
  user: FriendInfo;
  source: FriendRequestSource;
  createdAt: number;
  expiresAt: number;
}

export interface FriendRequestsResult {
  incoming: FriendRequestInfo[];
  outgoing: FriendRequestInfo[];
}

/** Antwort auf eine Anfrage per Name — absichtlich nur diese zwei Werte (Enumeration-Schutz) */

/** Eigener Status; `invisible` erscheint bei Freunden als offline */

export interface FriendPresence {
  userId: string;
  username: string;
  online: boolean;
  status: FriendPresenceStatus;
  gameId?: string;
  /** Nur gesetzt, wenn der Freund in einer Lobby ist. Nie eine Lobby-ID. */
  lobbyJoinable?: boolean;
  lastSeen?: number;
}

export interface SocialSettings {
  status: OwnPresenceStatus;
  showLastSeen: boolean;
  dmReadReceipts: boolean;
  mutedNotificationTypes: NotificationType[];
}


export interface HubNotification {
  id: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  createdAt: number;
  readAt?: number;
  expiresAt: number;
}

export interface NotificationBacklog {
  unreadCount: number;
  latest: HubNotification[];
}

export interface NotificationCounts {
  unread: number;
  total: number;
  byType: Partial<Record<NotificationType, number>>;
}

export interface NotificationListResult {
  notifications: HubNotification[];
  nextCursor?: string;
}

export interface DirectMessage {
  id: string;
  /** Monoton steigende Sortier-/Cursor-Nummer (für `before`) */
  seq: number;
  conversationId: string;
  from: string;
  to: string;
  text: string;
  sentAt: number;
  deliveredAt?: number;
  readAt?: number;
}

export interface DmConversation {
  withUserId: string;
  username: string;
  lastMessage: DirectMessage;
  unreadCount: number;
}

export interface DmHistoryResult {
  messages: DirectMessage[];
  /** Cursor für die nächstältere Seite (`before`), falls es mehr gibt */
  nextBefore?: number;
}

export interface LobbyInvite {
  inviteId: string;
  lobbyId: string;
  lobbyName: string;
  gameId: string;
  fromUserId: string;
  fromUsername: string;
  expiresAt: number;
}


export interface FriendLobbyInfo {
  /** Nur bei nicht-privaten Lobbys */
  lobbyId?: string;
  name: string;
  players: number;
  slots: number;
  joinable: boolean;
  locked: boolean;
  hasInvite: boolean;
}

export interface DmConversationUnread {
  withUserId: string;
  unreadCount: number;
}

/** Konsistenter Gesamtzustand für Start/Resume (`social:sync`, `GET /social/sync`) */
export interface SocialSnapshot {
  etag: string;
  serverTime: number;
  status: OwnPresenceStatus;
  settings: SocialSettings;
  friends: FriendInfo[];
  presence: FriendPresence[];
  requests: FriendRequestsResult;
  lobbyInvites: LobbyInvite[];
  unreadNotifications: number;
  conversations: DmConversationUnread[];
}
