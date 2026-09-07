import type { GameInfo } from '@ethernal/shared';
import { EXTERNAL_GAMES } from './external-games';

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
  },
  // Hier kommen zukünftige Spiele rein, z.B.:
  // { id: 'tcg', name: 'Ethernal TCG', description: '...', maxPlayers: 2, entryScript: 'games/tcg/server/dist/index.js' },
];

const HOSTED_GAMES: GameInfo[] = HOSTED.map((g) => ({ ...g, hosted: true }));

/** Alle bekannten Spiele: gehostete + externe */
const ALL_GAMES: GameInfo[] = [...HOSTED_GAMES, ...EXTERNAL_GAMES];

const registryMap = new Map<string, GameInfo>(ALL_GAMES.map((g) => [g.id, g]));

export function getGame(gameId: string): GameInfo | undefined {
  return registryMap.get(gameId);
}

export function listGames(): GameInfo[] {
  return ALL_GAMES;
}
