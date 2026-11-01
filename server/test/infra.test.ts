import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { MIGRATIONS, runMigrations } from '../src/db/migrations';
import { registerUser, startHub, type TestHub } from './helpers/hub';

describe('Migrationen (#12)', () => {
  it('wendet Migrationen einmalig und in Reihenfolge an; migriert Bestandsdaten', async () => {
    const db = createClient({ url: ':memory:' });
    // Altbestand (vor Einführung von schema_migrations): v1-Schema existiert bereits mit Daten
    await runMigrations(db, MIGRATIONS.filter((m) => m.version === 1));
    await db.execute({ sql: "INSERT INTO users VALUES ('u','n','h',1)" , args: [] });
    await db.execute("INSERT INTO user_data (user_id, game_id, key, value, visibility, updated_at) VALUES ('u','g','k','1','private',1)");

    expect(await runMigrations(db)).toEqual(MIGRATIONS.map((m) => m.version).filter((v) => v > 1));
    expect(await runMigrations(db)).toEqual([]);
    const row = (await db.execute('SELECT write_scope, version FROM user_data')).rows[0];
    expect(row).toMatchObject({ write_scope: 'client', version: 1 });
    expect((await db.execute('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => Number(r.version))).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it('v6/v7: client-written public rows become private; num_value is backfilled for numbers only', async () => {
    const db = createClient({ url: ':memory:' });
    await runMigrations(db, MIGRATIONS.filter((m) => m.version <= 5));
    await db.execute("INSERT INTO users (id, username, password_hash, created_at) VALUES ('u','n','h',1)");
    const ins = (key: string, value: string, vis: string, scope: string): Promise<unknown> =>
      db.execute({ sql: 'INSERT INTO user_data (user_id, game_id, key, value, visibility, updated_at, write_scope) VALUES (?,?,?,?,?,1,?)', args: ['u', 'g', key, value, vis, scope] });
    await ins('forged', '99', 'public', 'client');
    await ins('real', '7.5', 'public', 'server');
    await ins('text', '"x"', 'public', 'server');
    await runMigrations(db);
    const rows = Object.fromEntries((await db.execute('SELECT key, visibility, num_value FROM user_data')).rows.map((r) => [r.key, r]));
    expect(rows.forged).toMatchObject({ visibility: 'private', num_value: 99 });
    expect(rows.real).toMatchObject({ visibility: 'public', num_value: 7.5 });
    expect(rows.text).toMatchObject({ visibility: 'public', num_value: null });
  });

  it('Bestehende DB ohne schema_migrations (alte Installation) wird ohne Datenverlust übernommen', async () => {
    const db = createClient({ url: ':memory:' });
    await db.execute('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL)');
    await db.execute("INSERT INTO users VALUES ('u','n','h',1)");
    await db.execute("CREATE TABLE user_data (user_id TEXT NOT NULL, game_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'private', updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, game_id, key))");
    await db.execute("INSERT INTO user_data VALUES ('u','g','k','1','private',1)");
    await runMigrations(db);
    expect((await db.execute('SELECT count(*) AS c FROM users')).rows[0].c).toBe(1);
    expect((await db.execute('SELECT write_scope FROM user_data')).rows[0].write_scope).toBe('client');
  });
});

describe('Server-Basis (#11, #13)', () => {
  let hub: TestHub;
  beforeAll(async () => { hub = await startHub(); });
  afterAll(async () => { await hub.stop(); });

  it('Auth: Fehlercodes in REST-Antworten (abwärtskompatibel mit error-Text)', async () => {
    const u = await registerUser(hub);
    const dup = await fetch(`${hub.url}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u.username, password: 'password123' }) });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ code: 'USERNAME_TAKEN', error: expect.any(String) });

    const bad = await fetch(`${hub.url}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u.username, password: 'wrongpass' }) });
    expect(bad.status).toBe(401);
    expect((await bad.json()).code).toBe('INVALID_CREDENTIALS');

    const noAuth = await fetch(`${hub.url}/userdata/relay`);
    expect(noAuth.status).toBe(401);
    expect((await noAuth.json()).code).toBe('UNAUTHENTICATED');
  });

  it('Auth: Refresh-Rotation; wiederverwendetes Token wird abgelehnt', async () => {
    const u = await registerUser(hub);
    const call = (t: string) => fetch(`${hub.url}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: t }) });
    const ok = await call(u.refreshToken);
    expect(ok.status).toBe(200);
    const reuse = await call(u.refreshToken);
    expect(reuse.status).toBe(401);
    expect((await reuse.json()).code).toBe('REFRESH_TOKEN_REVOKED');
  });

  it('/health und /api/games erreichbar; Test-Spiele sind registriert', async () => {
    const games = await (await fetch(`${hub.url}/api/games`)).json();
    expect(games.map((g: any) => g.id)).toEqual(expect.arrayContaining(['dudg', 'tictactoe', 'fake']));
  });

  it('Rate-Limit liefert RATE_LIMITED mit retryAfterMs im Ack', async () => {
    const limited = await startHub({ limits: { socketLimits: { listLobbies: { refillPerSecond: 0.01, burst: 1 } } } });
    try {
      const { connectRegistered } = await import('./helpers/hub');
      const c = await connectRegistered(limited, await registerUser(limited), 'relay');
      expect((await c.emitAck('listLobbies')).ok).toBe(true);
      const res = await c.emitAck('listLobbies');
      expect(res.error.code).toBe('RATE_LIMITED');
      expect(res.error.retryAfterMs).toBeGreaterThan(0);
      c.close();
    } finally {
      await limited.stop();
    }
  });
});
