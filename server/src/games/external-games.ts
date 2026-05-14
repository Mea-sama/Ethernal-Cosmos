import type { GameInfo } from '@ethernal/shared';

/**
 * Externe Spiele-Registry.
 *
 * Hier werden Spiele eingetragen, die NICHT als Subprocess auf dem Hub laufen,
 * sondern den Hub nur als Kommunikationskanal (Relay) nutzen.
 * Typisch: native Apps, C#-Clients, Desktop-Spiele, etc.
 *
 * Jeder Eintrag legt fest, welche gameId erlaubt ist und wie groß Lobbies
 * maximal sein dürfen. hosted ist immer false und wird automatisch gesetzt.
 *
 * Beispiel:
 *   { id: 'my-chess-app', name: 'My Chess App', description: '...', maxPlayers: 2 }
 */
const EXTERNAL: Omit<GameInfo, 'hosted'>[] = [
  // Einträge hier hinzufügen:
  // { id: 'my-chess-app', name: 'My Chess App', description: 'Externe Schach-App', maxPlayers: 2, link: 'https://github.com/...' },
  { id: 'my-tester-app', name: 'My Test App', description: 'External Testing Application', maxPlayers: 4, link: 'https://github.com/your-repo' }
];

export const EXTERNAL_GAMES: GameInfo[] = EXTERNAL.map((g) => ({ ...g, hosted: false }));
