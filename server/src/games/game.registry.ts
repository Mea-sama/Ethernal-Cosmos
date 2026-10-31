import type { GameInfo } from '@ethernal/shared';
import fs from 'fs';
import path from 'path';
import { EXTERNAL_GAMES } from './external-games';

/** Standard-Gnadenfrist für Reconnects (ms), wenn ein Spiel keine eigene angibt */
export const DEFAULT_RECONNECT_GRACE_MS = 60_000;

/**
 * Statische Spiel-Registry für serverseitig verwaltete Spiele.
 * Neue Spiele werden hier eingetragen, sobald ihr Subprocess implementiert ist.
 * hosted wird automatisch auf true gesetzt.
 */
const HOSTED: Omit<GameInfo, 'hosted'>[] = [
  {
    id: 'tictactoe',
    name: 'TicTacToe',
    description: 'Klassisches 3×3 TicTacToe — zwei Spieler, kein Subprocess.',
    maxPlayers: 2,
    // kein entryScript → reines Relay-Spiel
  },
  {
    id: 'dudg',
    name: 'Duell um die Geld',
    description: 'Poker-Quiz-Duell: 1 Host + bis zu 7 Kontrahenten, beliebig viele Zuschauer.',
    // Großzügige Obergrenze — nur Sicherheitsdeckel, da Zuschauer unbegrenzt sind;
    // die echte 1 Host + 7 Kontrahenten-Grenze setzt der Subprocess selbst durch.
    maxPlayers: 40,
    entryScript: 'games/dudg/server/dist/index.js',
    reconnectGraceMs: 120_000,
  },
  // Hier kommen zukünftige Spiele rein, z.B.:
  // { id: 'tcg', name: 'Ethernal TCG', description: '...', maxPlayers: 2, entryScript: 'games/tcg/server/dist/index.js' },
];

const HOSTED_GAMES: GameInfo[] = HOSTED.map((g) => ({ ...g, hosted: true }));

/**
 * Optionale Zusatzspiele aus einer JSON-Datei (GAMES_CONFIG_PATH): Array von GameInfo-ähnlichen Objekten.
 * Dient Tests und Deployments; entryScript darf hier absolut sein.
 */
function loadConfiguredGames(): GameInfo[] {
  const file = process.env.GAMES_CONFIG_PATH;
  if (!file) return [];
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as Array<Partial<GameInfo>>;
  for (const g of raw) {
    if (g.serverSupport !== undefined && !['none', 'optional', 'required'].includes(g.serverSupport)) {
      throw new Error(`[Registry] Ungültiges serverSupport "${String(g.serverSupport)}" für Spiel "${String(g.id)}"`);
    }
    if (g.regions !== undefined && (!Array.isArray(g.regions) || g.regions.some((r) => typeof r !== 'string' || !r))) {
      throw new Error(`[Registry] Ungültige regions für Spiel "${String(g.id)}"`);
    }
  }
  return raw.map((g) => ({
    id: String(g.id),
    name: g.name ?? String(g.id),
    description: g.description ?? '',
    maxPlayers: g.maxPlayers ?? 2,
    hosted: !!g.entryScript,
    ...g,
  })) as GameInfo[];
}

/** Alle bekannten Spiele: gehostete + externe + konfigurierte */
const ALL_GAMES: GameInfo[] = [...HOSTED_GAMES, ...EXTERNAL_GAMES, ...loadConfiguredGames()].map((g) => ({
  ...g,
  reconnectGraceMs: g.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS,
  serverSupport: g.serverSupport ?? 'none',
}));

const registryMap = new Map<string, GameInfo>(ALL_GAMES.map((g) => [g.id, g]));

export function getGame(gameId: string): GameInfo | undefined {
  return registryMap.get(gameId);
}

export function listGames(): GameInfo[] {
  return ALL_GAMES;
}
