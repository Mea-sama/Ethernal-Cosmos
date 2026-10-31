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
  {
    version: 3,
    name: 'social-friends-notifications-dms',
    statements: [
      // Normalisiertes Paar: user_a < user_b
      `CREATE TABLE IF NOT EXISTS friendships (
        user_a     TEXT NOT NULL,
        user_b     TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_a, user_b)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(user_b)`,
      // source: 'name' | 'lobby'
      `CREATE TABLE IF NOT EXISTS friend_requests (
        id         TEXT PRIMARY KEY,
        from_user  TEXT NOT NULL,
        to_user    TEXT NOT NULL,
        source     TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        UNIQUE (from_user, to_user)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user)`,
      `CREATE TABLE IF NOT EXISTS notifications (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        type         TEXT NOT NULL,
        payload      TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        read_at      INTEGER,
        expires_at   INTEGER NOT NULL,
        collapse_key TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_notifications_expiry ON notifications(expires_at)`,
      `CREATE TABLE IF NOT EXISTS direct_messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        from_user       TEXT NOT NULL,
        to_user         TEXT NOT NULL,
        text            TEXT NOT NULL,
        sent_at         INTEGER NOT NULL,
        delivered_at    INTEGER,
        read_at         INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_dm_conversation ON direct_messages(conversation_id)`,
      `CREATE INDEX IF NOT EXISTS idx_dm_to ON direct_messages(to_user, read_at)`,
      `CREATE INDEX IF NOT EXISTS idx_dm_sent ON direct_messages(sent_at)`,
      // status: 'online' | 'away' | 'busy' | 'invisible'; muted_types: JSON-Array
      `CREATE TABLE IF NOT EXISTS social_settings (
        user_id          TEXT PRIMARY KEY,
        status           TEXT NOT NULL DEFAULT 'online',
        show_last_seen   INTEGER NOT NULL DEFAULT 1,
        dm_read_receipts INTEGER NOT NULL DEFAULT 1,
        muted_types      TEXT NOT NULL DEFAULT '[]',
        last_seen        INTEGER
      )`,
    ],
  },
  {
    version: 4,
    name: 'username-lower',
    statements: [
      `ALTER TABLE users ADD COLUMN username_lower TEXT`,
      `UPDATE users SET username_lower = lower(username)`,
      // Bestehende Kollisionen (Bob/bob): der älteste Account behält den Namen, die übrigen erhalten ein eindeutiges Suffix im Index-Feld (Anzeigename bleibt unverändert)
      `UPDATE users SET username_lower = lower(username) || '~' || substr(id, 1, 8)
         WHERE rowid NOT IN (SELECT MIN(rowid) FROM users GROUP BY lower(username))`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users(username_lower)`,
    ],
  },
  {
    version: 5,
    name: 'game-server-keys',
    statements: [
      // Nur der Hash wird gespeichert; revoked_at != NULL = widerrufen (Rotation = neuer Key + alten widerrufen)
      `CREATE TABLE IF NOT EXISTS game_server_keys (
        id         TEXT PRIMARY KEY,
        game_id    TEXT NOT NULL,
        key_hash   TEXT NOT NULL UNIQUE,
        label      TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_game_server_keys_game ON game_server_keys(game_id)`,
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
