/** Einfacher Job-Scheduler für periodische Wartungsaufgaben (Token-Purge, später Nachrichten-Retention …). */
interface Job {
  name: string;
  intervalMs: number;
  run: () => Promise<void> | void;
  timer?: NodeJS.Timeout;
}

const jobs = new Map<string, Job>();

export function registerJob(name: string, intervalMs: number, run: Job['run']): void {
  jobs.set(name, { name, intervalMs, run });
}

async function execute(job: Job): Promise<void> {
  try {
    await job.run();
  } catch (err) {
    console.error(`[Scheduler] Job "${job.name}" fehlgeschlagen:`, err);
  }
}

export function startScheduler(): void {
  for (const job of jobs.values()) {
    if (job.timer) continue;
    job.timer = setInterval(() => void execute(job), job.intervalMs);
    job.timer.unref();
    void execute(job);
  }
}

export function stopScheduler(): void {
  for (const job of jobs.values()) {
    if (job.timer) clearInterval(job.timer);
    job.timer = undefined;
  }
}

export async function runJobNow(name: string): Promise<void> {
  const job = jobs.get(name);
  if (job) await execute(job);
}
