import cron from 'node-cron';
import { tasks } from './tasks.js';

/** One cron entry per scheduled task. Ported from event-scout's scheduler.ts. */
export function startScheduler(): void {
  for (const def of tasks.list()) {
    if (!def.schedule) continue;
    cron.schedule(def.schedule, () => {
      void tasks
        .runIfDue(def.name)
        .then((result) => {
          if (result) console.log(`[${def.name}] ${result.message}`);
        })
        .catch((err: Error) => console.error(`[${def.name}] failed: ${err.message}`));
    });
  }
}

/** Catch-up pass at startup, so a process that was down doesn't wait for the next tick. */
export function runDueTasksOnStartup(delayMs = 5000): void {
  setTimeout(() => {
    void (async () => {
      for (const def of tasks.list()) {
        if (!def.schedule) continue;
        try {
          const result = await tasks.runIfDue(def.name);
          if (result) console.log(`[${def.name}] ${result.message}`);
        } catch (err) {
          console.error(`[${def.name}] failed: ${(err as Error).message}`);
        }
      }
    })();
  }, delayMs);
}
