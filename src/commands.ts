import { defineCommand } from "@bunli/core";
import { loadConfig, missingRepoMessage } from "./config.ts";
import {
  formatTimeOfDay,
  installSchedule,
  isRegistered,
  nextRun,
  readSchedule,
  removeSchedule,
  TimeOfDay,
} from "./cron.ts";
import { readLastSync } from "./state.ts";
import { runSync } from "./sync.ts";

const STALE_AFTER_MS = 26 * 60 * 60 * 1000;

const pad = (value: number) => String(value).padStart(2, "0");

const formatDateTime = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
  `${pad(date.getHours())}:${pad(date.getMinutes())}`;

export const start = defineCommand({
  name: "start",
  description: "Schedule the nightly sync at a time of day (03:00, 3am, 3:30pm)",
  async handler({ positional }) {
    const config = await loadConfig();
    const [argument] = positional;
    if (argument === undefined) {
      console.error("start needs a time of day — for example: skill-sync start 03:00");
      process.exit(1);
    }

    const time = TimeOfDay.safeParse(argument);
    if (!time.success) {
      console.error(time.error.issues[0]?.message ?? "start needs a time of day");
      process.exit(1);
    }
    if (!config.repo) {
      console.error(missingRepoMessage(config.configPath));
      process.exit(1);
    }

    await installSchedule(time.data, config);
    console.log(
      `Nightly sync scheduled for ${formatTimeOfDay(time.data)} ` +
        `(next run ${formatDateTime(nextRun(time.data))}).`,
    );
  },
});

export const stop = defineCommand({
  name: "stop",
  description: "Remove the scheduled nightly sync",
  async handler() {
    const removed = await removeSchedule(await loadConfig());
    console.log(
      removed ? "Nightly sync unregistered." : "No nightly sync was scheduled.",
    );
  },
});

export const status = defineCommand({
  name: "status",
  description: "Show the schedule, the last sync, and whether the sync is healthy",
  async handler() {
    const config = await loadConfig();
    const schedule = await readSchedule(config);
    const last = await readLastSync(config.statePath);
    const stale = last !== null && Date.now() - Date.parse(last.finishedAt) > STALE_AFTER_MS;
    const health = !schedule
      ? "not scheduled"
      : !(await isRegistered())
        ? "missing from the OS scheduler — run start again"
        : last === null
          ? "pending — scheduled but has not run yet"
          : last.status !== "ok"
            ? `${last.status} — see last sync`
            : stale
              ? "stale — no successful sync in the last 26 hours"
              : "ok";

    const lines = [
      ["schedule", schedule ? `${formatTimeOfDay(schedule)} daily` : "not scheduled"],
      ["next run", schedule ? formatDateTime(nextRun(schedule)) : "—"],
      [
        "last sync",
        last
          ? `${formatDateTime(new Date(last.finishedAt))} — ${last.status}: ${last.summary}` +
            (last.commit ? ` (${last.commit})` : "")
          : "never",
      ],
      ["health", health],
      ["repo", config.repo ? `${config.repo} (${config.branch})` : "not configured"],
      ["skills", config.skillsDir],
      ["config", config.configPath],
      ["state", config.stateDir],
    ] as const;

    console.log("skill-sync");
    for (const [label, value] of lines) console.log(`  ${label.padEnd(10)}${value}`);
    if (!["ok", "not scheduled"].includes(health) && !health.startsWith("pending")) {
      process.exit(1);
    }
  },
});

export const sync = defineCommand({
  name: "sync",
  description: "Sync now — this is what the scheduled run invokes",
  async handler() {
    const record = await runSync(await loadConfig());
    console.log(
      `${formatDateTime(new Date(record.finishedAt))} ${record.status}: ${record.summary}`,
    );
    if (record.status !== "ok") process.exit(1);
  },
});
