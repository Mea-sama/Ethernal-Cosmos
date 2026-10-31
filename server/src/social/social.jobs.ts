import { registerJob } from '../jobs/scheduler';
import { sessionManager } from '../session/session.manager';
import { socialConfig } from './config';
import { pruneLimitBuckets } from './bus';
import { purgeExpiredRequests } from './friends.service';
import { purgeExpiredMessages } from './messages.service';
import { purgeExpiredNotifications } from './notifications.service';
import { forgetPresenceState } from './presence.service';
import { evictSettings } from './settings.service';

/** Retention-Jobs: abgelaufene Anfragen, Notifications und Nachrichten (DM_RETENTION_DAYS). */
export async function runSocialPurge(): Promise<{ requests: number; notifications: number; messages: number }> {
  const result = {
    requests: await purgeExpiredRequests(),
    notifications: await purgeExpiredNotifications(),
    messages: await purgeExpiredMessages(),
  };
  const active = (id: string): boolean => sessionManager.isConnected(id) || sessionManager.isInGrace(id);
  evictSettings(active);
  forgetPresenceState(active);
  pruneLimitBuckets();
  return result;
}

export function registerSocialJobs(): void {
  registerJob('social-purge', socialConfig.purgeIntervalMs, async () => {
    const r = await runSocialPurge();
    if (r.requests + r.notifications + r.messages > 0) {
      console.log(`[Scheduler] Social-Purge: ${r.requests} Anfragen, ${r.notifications} Notifications, ${r.messages} Nachrichten entfernt`);
    }
  });
}
