'use strict';
// Deletes every user account NOT listed in server/config/rate-limit-whitelist.json.
// Dry-run by default — pass --yes to actually delete.

const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');

const confirmed = process.argv.slice(2).includes('--yes');

const rootDir = path.resolve(__dirname, '../..');
const dbPath = path.join(rootDir, 'data', 'ethernal.db').replace(/\\/g, '/');
const whitelistPath = path.join(rootDir, 'server', 'config', 'rate-limit-whitelist.json');

async function main() {
  if (!fs.existsSync(dbPath)) {
    console.error(`Datenbank nicht gefunden: ${dbPath}`);
    process.exit(1);
  }

  const whitelist = JSON.parse(fs.readFileSync(whitelistPath, 'utf8'));
  const keepIds = new Set((whitelist.accounts ?? []).map((a) => a.userId));
  if (keepIds.size === 0) {
    console.warn('[Warnung] Whitelist ist leer — es würden ALLE Accounts gelöscht.');
  }

  const db = createClient({ url: `file:${dbPath}` });
  const { rows: allUsers } = await db.execute('SELECT id, username FROM users');
  const toDelete = allUsers.filter((u) => !keepIds.has(u.id));
  const toKeep = allUsers.filter((u) => keepIds.has(u.id));

  console.log(`Gefunden: ${allUsers.length} Account(s) insgesamt.`);
  console.log(`Bleiben erhalten (${toKeep.length}): ${toKeep.map((u) => u.username).join(', ') || '(keine)'}`);
  console.log(`Werden gelöscht (${toDelete.length}): ${toDelete.map((u) => u.username).join(', ') || '(keine)'}`);

  if (toDelete.length === 0) {
    console.log('Nichts zu tun.');
    return;
  }

  if (!confirmed) {
    console.log('\nDies war ein Probelauf (Dry-Run) — es wurde NICHTS gelöscht.');
    console.log('Zum tatsächlichen Löschen erneut mit "--yes" ausführen.');
    return;
  }

  const ids = toDelete.map((u) => u.id);
  const placeholders = ids.map(() => '?').join(',');
  // Discover every table with a FK column referencing users(id) at runtime, rather than a
  // hardcoded list — protects against future/legacy tables causing the same FK violation.
  const { rows: tables } = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name != 'users'");
  const childTables = [];
  for (const { name } of tables) {
    const { rows: fks } = await db.execute(`PRAGMA foreign_key_list(${name})`);
    const fk = fks.find((f) => f.table === 'users');
    if (fk) childTables.push({ table: name, column: fk.from });
  }

  // Single atomic transaction: prevents a live server session (e.g. an active test account
  // refreshing its token) from inserting a new child row between the individual deletes, which
  // previously caused a FOREIGN KEY constraint failure on the final `DELETE FROM users`.
  const statements = [
    ...childTables.map(({ table, column }) => ({ sql: `DELETE FROM ${table} WHERE ${column} IN (${placeholders})`, args: ids })),
    { sql: `DELETE FROM users WHERE id IN (${placeholders})`, args: ids },
  ];
  await db.batch(statements, 'write');


  console.log(`\n✔ ${toDelete.length} Test-Account(s) gelöscht. ${toKeep.length} Whitelist-Account(s) erhalten.`);
}

main().catch((err) => {
  console.error('Fehler:', err);
  process.exit(1);
});
