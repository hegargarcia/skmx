import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineCommand, option, type PromptApi } from "@bunli/core";
import { z } from "zod";
import { loadConfig, missingRepoMessage, type Config, type SyncedSkill } from "./config.ts";
import { assertGhReady, createRepo, listRepos } from "./github.ts";
import { pickRepo, pickSkills } from "./onboarding.ts";
import { discoverSkills, githubSlug, groupSkills, repoDirName, sshUrl } from "./skills.ts";
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
import { ARROW, BULLET, label, mark, OK, PAUSED, SEPARATOR, toneFor, type Tone } from "./ui.ts";

const STALE_AFTER_MS = 26 * 60 * 60 * 1000;

const pad = (value: number) => String(value).padStart(2, "0");

const formatDateTime = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
  `${pad(date.getHours())}:${pad(date.getMinutes())}`;

const atOption = option(TimeOfDay.optional(), {
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
    const config = await configure(prompt, terminal.isInteractive, {
      repo: flags.repo,
      // Running setup again is how the configuration is changed, so always ask.
      edit: true,
    });

    // Keep the time already scheduled unless a new one was asked for.
    const time = flags.at ?? (await readSchedule(config)) ?? MIDNIGHT;
    await installSchedule(time, config);
    prompt.note(
      [
        `${config.skills.map((skill) => skill.name).join(SEPARATOR)}`,
        `${ARROW} ${config.repo} (${config.branch})`,
        announce("Scheduled", time),
      ].join("\n"),
      "skill-sync",
    );
    prompt.outro(`${OK} Run \`skill-sync sync\` to push them now`);
  },
});

export const start = defineCommand({
  name: "start",
  description: "Resume the nightly sync after a stop, running setup when unconfigured",
  async handler({ prompt, terminal }) {
    // Resuming leaves the configuration as it is; `setup` is where it changes.
    const config = await configure(prompt, terminal.isInteractive, { edit: false });
    const existing = await readSchedule(config);
    const time = existing ?? MIDNIGHT;

    await installSchedule(time, config);
    console.log(mark("ok", announce(existing ? "Resumed" : "Scheduled", time)));
  },
});

export const stop = defineCommand({
  name: "stop",
  description: "Pause the nightly sync, keeping the configuration",
  async handler() {
    const paused = await pauseSchedule(await loadConfig());
    console.log(
      paused
        ? mark("paused", "Nightly sync paused — run `skill-sync start` to resume")
        : mark("idle", "No nightly sync was scheduled"),
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
    const health: { tone: Tone; text: string } = !schedule
      ? { tone: "idle", text: "not scheduled — run `skill-sync setup`" }
      : schedule.paused
        ? { tone: "paused", text: "paused — run `skill-sync start` to resume" }
        : !(await isRegistered())
          ? { tone: "warn", text: "missing from the OS scheduler — run `skill-sync start`" }
          : last === null
            ? { tone: "idle", text: "pending — scheduled but has not run yet" }
            : last.status !== "ok"
              ? { tone: "warn", text: `${last.status} — see last sync` }
              : stale
                ? { tone: "warn", text: "stale — no successful sync in the last 26 hours" }
                : { tone: "ok", text: "ok" };
    const active = schedule !== null && !schedule.paused;

    const lines = [
      [
        "schedule",
        schedule
          ? `${formatTimeOfDay(schedule)} daily${schedule.paused ? ` ${PAUSED} paused` : ""}`
          : "not scheduled",
      ],
      ["next run", active ? formatDateTime(nextRun(schedule)) : "—"],
      [
        "last sync",
        last
          ? mark(
              toneFor(last.status),
              `${formatDateTime(new Date(last.finishedAt))} ${last.status}: ${last.summary}` +
                (last.commit ? ` (${last.commit})` : ""),
            )
          : "never",
      ],
      ["health", mark(health.tone, health.text)],
      [
        "repo",
        config.repo ? `${config.repo} ${SEPARATOR.trim()} ${config.branch}` : "not configured",
      ],
      [
        "skills",
        config.skills.length > 0
          ? config.skills.map((skill) => skill.name).join(SEPARATOR)
          : "none selected",
      ],
      [
        "clone",
        config.repo ? join(config.reposDir, repoDirName(config.repo)) : config.reposDir,
      ],
      ["config", config.configPath],
      ["state", config.stateDir],
    ] as const;

    console.log(`${BULLET} skill-sync`);
    for (const [name, value] of lines) console.log(`  ${label(name.padEnd(10))}${value}`);
    if (health.tone === "warn") process.exit(1);
  },
});

export const sync = defineCommand({
  name: "sync",
  description: "Sync now — this is what the scheduled run invokes",
  async handler() {
    const record = await runSync(await loadConfig());
    console.log(
      mark(
        toneFor(record.status),
        `${formatDateTime(new Date(record.finishedAt))} ${record.status}: ${record.summary}`,
      ),
    );
    if (record.status !== "ok") process.exit(1);
  },
});

const announce = (verb: string, time: TimeOfDay) =>
  `${verb} nightly sync at ${formatTimeOfDay(time)} ` +
  `(next run ${formatDateTime(nextRun(time))})`;

/**
 * Picks the skills and the repo. `setup` runs this every time, with what is already
 * configured pre-selected, which is how the configuration gets changed; `start` only
 * runs it when there is nothing configured yet. Either way it needs a terminal.
 */
async function configure(
  prompt: PromptApi,
  interactive: boolean,
  { repo, edit }: { repo?: string; edit: boolean },
) {
  const config = await loadConfig();
  const configured = config.repo !== undefined && config.skills.length > 0;
  if (configured && !edit) return config;

  if (!interactive) {
    // Rescheduling an already configured machine asks nothing, so it still works
    // without a terminal; changing what is synced does not.
    if (configured && repo === undefined) return config;

    console.error(
      configured
        ? "changing what is synced needs a terminal — run `skill-sync setup` interactively"
        : `${missingRepoMessage(config.configPath)}, and pick skills with \`skill-sync setup\` on a terminal`,
    );
    process.exit(1);
  }

  prompt.intro(`skill-sync ${configured ? "setup · editing" : "setup"}`);
  const available = await groupSkills(await discoverSkills());
  if (available.length === 0) {
    console.error("no skills found in ~/.claude/skills, ~/.agents/skills, or ~/.codex/skills");
    process.exit(1);
  }

  const skills = await pickSkills(prompt, available, config.skills);
  return await save(config, { repo: repo ?? (await resolveRepo(prompt, config.repo)), skills });
}

/** Lists the user's repos through `gh` — no OAuth flow of our own — and creates on request. */
async function resolveRepo(prompt: PromptApi, current?: string) {
  await assertGhReady();
  const inUse = current === undefined ? undefined : (githubSlug(current) ?? undefined);
  const choice = await pickRepo(prompt, await listRepos(), inUse);

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
