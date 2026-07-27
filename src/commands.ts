import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { defineCommand, option, type PromptApi } from "@bunli/core";
import { z } from "zod";
import { loadConfig, missingRepoMessage, type Config } from "./config.ts";
import {
  formatTimeOfDay,
  installSchedule,
  isRegistered,
  MIDNIGHT,
  nextRun,
  pauseSchedule,
  readSchedule,
  TimeOfDay,
} from "./cron.ts";
import { readLastSync } from "./state.ts";
import { runSync } from "./sync.ts";

const STALE_AFTER_MS = 26 * 60 * 60 * 1000;

const pad = (value: number) => String(value).padStart(2, "0");

const formatDateTime = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
  `${pad(date.getHours())}:${pad(date.getMinutes())}`;

const atOption = option(TimeOfDay.prefault("00:00"), {
  short: "a",
  description: "Time of day to sync — 00:00, 3am, 3:30pm (default midnight)",
});

const repoOption = option(z.string().trim().min(1).optional(), {
  short: "r",
  description: "git remote URL of the skills repo",
});

export const setup = defineCommand({
  name: "setup",
  description: "Configure the skills repo and schedule the nightly sync",
  options: { at: atOption, repo: repoOption },
  async handler({ flags, prompt, terminal }) {
    const config = await configure(flags.repo, prompt, terminal.isInteractive);

    await installSchedule(flags.at, config);
    console.log(`Syncing ${config.skillsDir}`);
    console.log(`     with ${config.repo} (${config.branch})`);
    console.log(announce("Scheduled", flags.at));
    console.log("Run `skill-sync sync` to sync now, or `skill-sync status` to check on it.");
  },
});

export const start = defineCommand({
  name: "start",
  description: "Resume the nightly sync after a stop, running setup when unconfigured",
  async handler({ prompt, terminal }) {
    const config = await configure(undefined, prompt, terminal.isInteractive);
    const existing = await readSchedule(config);
    const time = existing ?? MIDNIGHT;

    await installSchedule(time, config);
    console.log(announce(existing ? "Resumed" : "Scheduled", time));
  },
});

export const stop = defineCommand({
  name: "stop",
  description: "Pause the nightly sync, keeping the configuration",
  async handler() {
    const paused = await pauseSchedule(await loadConfig());
    console.log(
      paused
        ? "Nightly sync paused — run `skill-sync start` to resume."
        : "No nightly sync was scheduled.",
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
      ? "not scheduled — run `skill-sync setup`"
      : schedule.paused
        ? "paused — run `skill-sync start` to resume"
        : !(await isRegistered())
          ? "missing from the OS scheduler — run `skill-sync start`"
          : last === null
            ? "pending — scheduled but has not run yet"
            : last.status !== "ok"
              ? `${last.status} — see last sync`
              : stale
                ? "stale — no successful sync in the last 26 hours"
                : "ok";
    const active = schedule !== null && !schedule.paused;

    const lines = [
      [
        "schedule",
        schedule
          ? `${formatTimeOfDay(schedule)} daily${schedule.paused ? " (paused)" : ""}`
          : "not scheduled",
      ],
      ["next run", active ? formatDateTime(nextRun(schedule)) : "—"],
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
    if (!healthy(health)) process.exit(1);
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

const announce = (verb: string, time: TimeOfDay) =>
  `${verb} nightly sync at ${formatTimeOfDay(time)} ` +
  `(next run ${formatDateTime(nextRun(time))}).`;

/** States the user chose deliberately, or that resolve themselves on the next run. */
const healthy = (health: string) =>
  health === "ok" || health.startsWith("pending") || health.startsWith("paused");

/**
 * Onboarding, shared by `setup` and by `start` when nothing is configured yet.
 * Asks for the repo when there is a terminal to ask in.
 */
async function configure(repo: string | undefined, prompt: PromptApi, interactive: boolean) {
  const config = await loadConfig();
  if (config.repo && repo === undefined) return config;

  const chosen =
    repo ?? (interactive ? await prompt.text("git remote URL of your skills repo") : "");
  if (chosen.trim() === "") {
    console.error(missingRepoMessage(config.configPath));
    process.exit(1);
  }

  return await saveRepo(config, chosen.trim());
}

async function saveRepo(config: Config, repo: string) {
  const file = Bun.file(config.configPath);
  const existing = (await file.exists()) ? await file.json() : {};

  await mkdir(dirname(config.configPath), { recursive: true });
  await Bun.write(config.configPath, `${JSON.stringify({ ...existing, repo }, null, 2)}\n`);
  return await loadConfig();
}
