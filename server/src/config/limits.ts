import fs from 'fs';
import path from 'path';

interface LimitRule {
  refillPerSecond: number;
  burst: number;
}

interface AuthLimitRule {
  windowMs: number;
  max: number;
  message: string;
}

export interface ServerLimits {
  binary: {
    maxPayloadBytes: number;
  };
  rateLimitNoticeCooldownMs: number;
  /** Token-Buckets pro Socket und Event-Name */
  socketLimits: Record<string, LimitRule>;
  /** Token-Buckets pro Lobby und Event-Name */
  lobbyLimits: Record<string, LimitRule>;
  authRateLimits: {
    login: AuthLimitRule;
    register: AuthLimitRule;
    refresh: AuthLimitRule;
  };
}

const defaultLimits: ServerLimits = {
  binary: {
    maxPayloadBytes: 1000,
  },
  rateLimitNoticeCooldownMs: 2000,
  socketLimits: {
    createLobby: { refillPerSecond: 0.1, burst: 2 },
    joinLobby: { refillPerSecond: 0.25, burst: 4 },
    joinLobbyByCode: { refillPerSecond: 0.25, burst: 4 },
    kickPlayer: { refillPerSecond: 0.5, burst: 3 },
    transferHost: { refillPerSecond: 0.5, burst: 3 },
    lockLobby: { refillPerSecond: 0.5, burst: 3 },
    unlockLobby: { refillPerSecond: 0.5, burst: 3 },
    requestJoinLobby: { refillPerSecond: 0.25, burst: 4 },
    requestJoinLobbyByCode: { refillPerSecond: 0.25, burst: 4 },
    cancelJoinRequest: { refillPerSecond: 0.5, burst: 4 },
    respondJoinRequest: { refillPerSecond: 0.5, burst: 6 },
    listLobbies: { refillPerSecond: 5, burst: 15 },
    getLobbyInfo: { refillPerSecond: 5, burst: 15 },
    presenceList: { refillPerSecond: 3, burst: 10 },
    getUserData: { refillPerSecond: 8, burst: 20 },
    getPlayerData: { refillPerSecond: 8, burst: 20 },
    sendToLobby: { refillPerSecond: 250, burst: 500 },
    sendToLobbyBinary: { refillPerSecond: 250, burst: 500 },
    sendToPlayer: { refillPerSecond: 200, burst: 400 },
    sendToPlayerBinary: { refillPerSecond: 200, burst: 400 },
    gameAction: { refillPerSecond: 300, burst: 600 },
    registerGame: { refillPerSecond: 0.5, burst: 5 },
    sessionState: { refillPerSecond: 5, burst: 15 },
    setUserData: { refillPerSecond: 8, burst: 30 },
    bulkSetUserData: { refillPerSecond: 2, burst: 6 },
    deleteUserData: { refillPerSecond: 8, burst: 30 },
    leaveLobby: { refillPerSecond: 1, burst: 5 },
  },
  lobbyLimits: {
    sendToLobby: { refillPerSecond: 1200, burst: 2400 },
    sendToLobbyBinary: { refillPerSecond: 1200, burst: 2400 },
    gameAction: { refillPerSecond: 1600, burst: 3200 },
    requestJoinLobby: { refillPerSecond: 2, burst: 10 },
  },
  authRateLimits: {
    login: {
      windowMs: 15 * 60 * 1000,
      max: 10,
      message: 'Zu viele Login-Versuche, bitte in 15 Minuten erneut versuchen',
    },
    register: {
      windowMs: 60 * 60 * 1000,
      max: 5,
      message: 'Zu viele Registrierungsversuche, bitte später erneut versuchen',
    },
    refresh: {
      windowMs: 15 * 60 * 1000,
      max: 30,
      message: 'Zu viele Token-Refresh-Anfragen',
    },
  },
};

function loadLimitsFromFile(): Partial<ServerLimits> {
  const configPath = process.env.LIMITS_CONFIG_PATH
    ? path.resolve(process.env.LIMITS_CONFIG_PATH)
    : path.resolve(__dirname, '../../../server/config/limits.json');
  if (!fs.existsSync(configPath)) {
    console.warn(`[Limits] Konfigurationsdatei nicht gefunden, nutze Defaults: ${configPath}`);
    return {};
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw) as Partial<ServerLimits>;
  } catch (err) {
    console.error('[Limits] Fehler beim Laden von limits.json, nutze Defaults:', err);
    return {};
  }
}

function rule(value: unknown, fallback: LimitRule): LimitRule {
  if (!value || typeof value !== 'object') return fallback;
  const candidate = value as Partial<LimitRule>;
  const refillPerSecond = Number(candidate.refillPerSecond);
  const burst = Number(candidate.burst);
  if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) return fallback;
  if (!Number.isFinite(burst) || burst <= 0) return fallback;
  return { refillPerSecond, burst };
}

function mergeRuleMap(base: Record<string, LimitRule>, override: Record<string, unknown>): Record<string, LimitRule> {
  const result: Record<string, LimitRule> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = rule(value, base[key] ?? { refillPerSecond: 10, burst: 20 });
  }
  return result;
}

function authRule(value: unknown, fallback: AuthLimitRule): AuthLimitRule {
  if (!value || typeof value !== 'object') return fallback;
  const candidate = value as Partial<AuthLimitRule>;
  const windowMs = Number(candidate.windowMs);
  const max = Number(candidate.max);
  const message = typeof candidate.message === 'string' ? candidate.message : fallback.message;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return fallback;
  if (!Number.isFinite(max) || max <= 0) return fallback;
  return { windowMs, max, message };
}

function mergeLimits(base: ServerLimits, override: Partial<ServerLimits>): ServerLimits {
  const socketOverrides = override.socketLimits ?? {};
  const lobbyOverrides = override.lobbyLimits ?? {};
  const authOverrides: Partial<ServerLimits['authRateLimits']> = override.authRateLimits ?? {};

  return {
    binary: {
      maxPayloadBytes:
        Number.isFinite(Number(override.binary?.maxPayloadBytes)) && Number(override.binary?.maxPayloadBytes) > 0
          ? Number(override.binary?.maxPayloadBytes)
          : base.binary.maxPayloadBytes,
    },
    rateLimitNoticeCooldownMs:
      Number.isFinite(Number(override.rateLimitNoticeCooldownMs)) && Number(override.rateLimitNoticeCooldownMs) >= 0
        ? Number(override.rateLimitNoticeCooldownMs)
        : base.rateLimitNoticeCooldownMs,
    socketLimits: mergeRuleMap(base.socketLimits, socketOverrides),
    lobbyLimits: mergeRuleMap(base.lobbyLimits, lobbyOverrides),
    authRateLimits: {
      login: authRule(authOverrides.login, base.authRateLimits.login),
      register: authRule(authOverrides.register, base.authRateLimits.register),
      refresh: authRule(authOverrides.refresh, base.authRateLimits.refresh),
    },
  };
}

export const serverLimits: ServerLimits = mergeLimits(defaultLimits, loadLimitsFromFile());
