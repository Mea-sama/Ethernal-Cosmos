import type { Client } from '@libsql/client';

interface Migration {
  version: number;
  name: string;
  statements: string[];
}

/**
 * Geordnete, nur-vorwärts Migrationen. Neue Migrationen NUR anhängen, bestehende nie ändern.
 * Jede Migration läuft in einer Transaktion und wird in schema_migrations vermerkt.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        username      TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      )`,
      // visibility: 'private' (nur Besitzer) | 'lobby' (Mitspieler) | 'public' (alle)
      `CREATE TABLE IF NOT EXISTS user_data (
        user_id    TEXT NOT NULL,
        game_id    TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'private',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, game_id, key),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_user_data_leaderboard ON user_data(game_id, key, visibility)`,
      `CREATE TABLE IF NOT EXISTS refresh_tokens (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL,
        token_hash  TEXT NOT NULL UNIQUE,
        expires_at  INTEGER NOT NULL,
        revoked     INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )`,
    ],
  },
  {
    version: 2,
    name: 'user-data-write-scope-and-version',
    statements: [
      // 'client' = Spieler darf selbst schreiben, 'server' = nur Hub/Subprocess (Integrität)
      `ALTER TABLE user_data ADD COLUMN write_scope TEXT NOT NULL DEFAULT 'client'`,
      `ALTER TABLE user_data ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
    ],
  },
];

export async function runMigrations(db: Client, migrations: Migration[] = MIGRATIONS): Promise<number[]> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`
  );
  const applied = new Set(
    (await db.execute('SELECT version FROM schema_migrations')).rows.map((r) => Number(r.version))
  );
  const ran: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    await db.batch(
      [
        ...m.statements,
        { sql: 'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', args: [m.version, m.name, Date.now()] },
      ],
      'write'
    );
    ran.push(m.version);
    console.log(`[DB] Migration ${m.version} (${m.name}) angewendet`);
  }
  return ran;
}
