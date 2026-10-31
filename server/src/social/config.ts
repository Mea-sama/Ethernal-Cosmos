function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Konfiguration wird bei jedem Zugriff aus der Umgebung gelesen (testbar, kein Neustart-Zwang für Tests). */
export const socialConfig = {
  get maxFriends(): number { return num('FRIENDS_MAX', 100); },
  get maxOutgoingRequests(): number { return num('FRIEND_REQUESTS_MAX_OUTGOING', 50); },
  /** Pro-Ziel-Cap für ausstehende eingehende Anfragen */
  get maxIncomingRequests(): number { return num('FRIEND_REQUESTS_MAX_INCOMING', 50); },
  get requestExpiryMs(): number { return num('FRIEND_REQUEST_EXPIRY_DAYS', 30) * DAY_MS; },
  /** true: Absender erfährt eine Ablehnung nicht */
  get silentDecline(): boolean { return process.env.FRIEND_SILENT_DECLINE === 'true'; },
  /** Mindestlatenz für Namensanfragen (Timing-Angleichung) */
  get nameLookupMinMs(): number { return num('FRIEND_NAME_LOOKUP_MIN_MS', 40); },

  get notificationReadRetentionMs(): number { return num('NOTIFICATION_READ_RETENTION_DAYS', 30) * DAY_MS; },
  get notificationUnreadRetentionMs(): number { return num('NOTIFICATION_UNREAD_RETENTION_DAYS', 90) * DAY_MS; },
  get notificationCap(): number { return num('NOTIFICATION_CAP_PER_USER', 500); },
  get notificationBacklogSize(): number { return num('NOTIFICATION_BACKLOG_SIZE', 20); },

  get dmMaxLength(): number { return num('DM_MAX_LENGTH', 1000); },
  get dmRetentionMs(): number { return num('DM_RETENTION_DAYS', 30) * DAY_MS; },
  get dmConversationCap(): number { return num('DM_CONVERSATION_CAP', 500); },

  get inviteTtlMs(): number { return num('LOBBY_INVITE_TTL_MS', 5 * 60_000); },
  /** Einladung umgeht Lobby-Sperre (Default: ja) */
  get inviteBypassLock(): boolean { return process.env.LOBBY_INVITE_BYPASS_LOCK !== 'false'; },

  get purgeIntervalMs(): number { return num('SOCIAL_PURGE_INTERVAL_MS', 60 * 60_000); },
};
