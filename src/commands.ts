import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { defineCommand, option, type PromptApi } from "@bunli/core";
import { z } from "zod";
import { loadConfig, missingRepoMessage, type Config, type SyncedSkill } from "./config.ts";
import { assertGhReady, createRepo, listRepos } from "./github.ts";
import { pickRepo, pickSkills } from "./onboarding.ts";
import { discoverSkills, groupSkills, sshUrl } from "./skills.ts";
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
  description: "Pick the skills to sync and the repo to sync them to, then schedule it",
  options: { at: atOption, repo: repoOption },
  async handler({ flags, prompt, terminal }) {
    const config = await configure(flags.repo, prompt, terminal.isInteractive);

    await installSchedule(flags.at, config);
    prompt.note(
      [
        `Skills: ${config.skills.map((skill) => skill.name).join(", ")}`,
        `Repo:   ${config.repo} (${config.branch})`,
        announce("Scheduled", flags.at),
      ].join("\n"),
    );
    console.log("Run `skill-sync sync` to push them now, or `skill-sync status` to check on it.");
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
      [
        "skills",
        config.skills.length > 0
          ? config.skills.map((skill) => skill.name).join(", ")
          : "none selected",
      ],
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
 * Onboarding, shared by `setup` and by `start` when nothing is configured yet:
 * pick the skills, pick or create the repo. Both need a terminal to ask in.
 */
async function configure(repo: string | undefined, prompt: PromptApi, interactive: boolean) {
  const config = await loadConfig();
  const configured = config.repo !== undefined && config.skills.length > 0;
  if (configured && repo === undefined) return config;

  if (!interactive) {
    console.error(
      repo === undefined
        ? `${missingRepoMessage(config.configPath)}, and pick skills with \`skill-sync setup\` on a terminal`
        : "picking skills needs a terminal — run `skill-sync setup` interactively",
    );
    process.exit(1);
  }

  prompt.intro("skill-sync setup");
  const available = await groupSkills(await discoverSkills());
  if (available.length === 0) {
    console.error("no skills found in ~/.claude/skills, ~/.agents/skills, or ~/.codex/skills");
    process.exit(1);
  }

  const skills = await pickSkills(prompt, available, config.skills);
  return await save(config, { repo: repo ?? (await resolveRepo(prompt)), skills });
}

/** Lists the user's repos through `gh` — no OAuth flow of our own — and creates on request. */
async function resolveRepo(prompt: PromptApi) {
  await assertGhReady();
  const choice = await pickRepo(prompt, await listRepos());

  return "repo" in choice
    ? choice.repo
    : sshUrl(await createRepo(choice.create.name, choice.create.visibility));
}

async function save(config: Config, settings: { repo: string; skills: SyncedSkill[] }) {
  const file = Bun.file(config.configPath);
  const existing = (await file.exists()) ? await file.json() : {};

  await mkdir(dirname(config.configPath), { recursive: true });
  await Bun.write(
    config.configPath,
    `${JSON.stringify({ ...existing, ...settings }, null, 2)}\n`,
  );
  return await loadConfig();
}
