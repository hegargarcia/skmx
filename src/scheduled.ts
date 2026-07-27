import { appendFile } from "node:fs/promises";
import { loadConfig } from "./config.ts";
import { runSync } from "./sync.ts";

/**
 * Runs the sync on the schedule registered by `skill-sync start`. Bun.cron does not
 * capture output the same way on every platform, so the outcome is logged here.
 */
export default {
  async scheduled() {
    const config = await loadConfig();
    const record = await runSync(config);
    await appendFile(
      config.cronLogPath,
      `${record.finishedAt} ${record.status}: ${record.summary}\n`,
    );
  },
};
