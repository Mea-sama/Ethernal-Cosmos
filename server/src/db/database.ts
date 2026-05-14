import { createClient, type Client } from '@libsql/client';
import fs from 'fs';
import path from 'path';

const dataDir = path.resolve(__dirname, '../../../data');
const dbPath = path.join(dataDir, 'ethernal.db').replace(/\\/g, '/');

// Verzeichnis anlegen falls nicht vorhanden
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db: Client = createClient({ url: `file:${dbPath}` });

export async function initDatabase(): Promise<void> {
  // Users
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      username     TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    )
  `);

  // User-Daten: Key-Value-Store mit Visibility-Kontrolle
  // Visibility: 'private' (nur Besitzer) | 'lobby' (Mitspieler) | 'public' (alle)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_data (
      user_id    TEXT NOT NULL,
      game_id    TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, game_id, key),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Index für Leaderboard-Queries (game_id + key + visibility)
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_user_data_leaderboard
    ON user_data(game_id, key, visibility)
  `);

  // Refresh-Tokens (rotierende Tokens für Session-Verlängerung)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  INTEGER NOT NULL,
      revoked     INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  console.log('[DB] Datenbank initialisiert');
}
