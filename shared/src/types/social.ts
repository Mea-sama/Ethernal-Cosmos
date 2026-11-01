// ─── Social: Freunde, Presence, Notifications, DMs, Lobby-Einladungen ─────────

import type { FriendPresenceStatus, FriendRequestSource, LobbyInviteCancelReason, NotificationType, OwnPresenceStatus } from './enums';

/** Einzige Information über einen Freund (erst nach Annahme sichtbar) */
export interface FriendInfo {
  userId: string;
  username: string;
}


/** Entry of the caller's private block list (never visible to the blocked user) */
export interface BlockedUserInfo {
  userId: string;
  username: string;
  blockedAt: number;
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
  /** Highest `seq` of an incoming message the user has read (0 = none). Everything up to it counts as read. */
  lastReadSeq: number;
}

export interface DmHistoryResult {
  messages: DirectMessage[];
  /** Cursor für die nächstältere Seite (`before`), falls es mehr gibt */
  nextBefore?: number;
  /** Read cursor of the caller: highest incoming `seq` read. In `dm:open` this is the value *before* the chat was opened. */
  lastReadSeq: number;
  /** `seq` of the oldest unread incoming message (state before opening); UI draws its "new messages" divider here. */
  firstUnreadSeq?: number;
  /** Unread incoming messages of this chat (state before opening for `dm:open`). */
  unreadCount: number;
  /** Highest `seq` of the caller's messages the friend has read. Omitted if the friend disabled read receipts. */
  peerLastReadSeq?: number;
}

/** Result of `dm:markRead` / payload of `dm:readState`. */
export interface DmReadState {
  withUserId: string;
  /** Number of messages newly marked read by the call that moved the cursor (also in `dm:readState` pushes) */
  marked: number;
  lastReadSeq: number;
  /** Unread messages still left in this chat (0 if everything up to the latest message was read) */
  unreadCount: number;
  /** Unread DMs over all chats, for an app badge */
  totalUnread: number;
}

/** Result of `dm:unread` (pull API for unread badges). */
export interface DmUnreadResult {
  conversations: DmConversationUnread[];
  totalUnread: number;
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
  /** `seq` of the oldest unread message: where the chat should open */
  firstUnreadSeq: number;
  /** `seq` and send time of the newest message (sorting chats) */
  lastSeq: number;
  lastMessageAt: number;
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

/** A pending join request for a locked lobby (`getJoinRequests`). */
export interface JoinRequestInfo {
  lobbyId: string;
  requesterId: string;
  username: string;
  /** When the hub auto-rejects the request (ms since epoch) */
  expiresAt: number;
}

export interface JoinRequestsResult {
  /** Requests waiting for the caller as host */
  incoming: JoinRequestInfo[];
  /** The caller's own open request, if any */
  outgoing?: JoinRequestInfo;
}
