import { createClient, type Client } from '@libsql/client';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config/env';
import { runMigrations } from './migrations';

const dbPath = path.join(DATA_DIR, 'ethernal.db').replace(/\\/g, '/');

// Verzeichnis anlegen falls nicht vorhanden
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const db: Client = createClient({ url: `file:${dbPath}` });

export async function initDatabase(): Promise<void> {
  await runMigrations(db);
  console.log('[DB] Datenbank initialisiert');
}
