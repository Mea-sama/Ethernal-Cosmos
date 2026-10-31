import { db } from '../db/database';
import { registerJob } from './scheduler';

const ONE_HOUR_MS = 60 * 60 * 1000;

/** Löscht abgelaufene Refresh-Tokens (widerrufene bleiben bis Ablauf für Reuse-Erkennung). */
export async function purgeRefreshTokens(): Promise<number> {
  const res = await db.execute({
    sql: 'DELETE FROM refresh_tokens WHERE expires_at < ?',
    args: [Date.now()],
  });
  return res.rowsAffected;
}

export function registerMaintenanceJobs(): void {
  registerJob('purge-refresh-tokens', ONE_HOUR_MS, async () => {
    const n = await purgeRefreshTokens();
    if (n > 0) console.log(`[Scheduler] ${n} Refresh-Tokens entfernt`);
  });
}
