import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineCommand, option, type PromptApi } from "@bunli/core";
import { z } from "zod";
import { loadConfig, missingRepoMessage, type Config, type SyncedSkill } from "./config.ts";
import { assertGhReady, createRepo, listRepos } from "./github.ts";
import { pickRepo, pickSchedule, pickSkills } from "./onboarding.ts";
import {
  discoverSkills,
  githubSlug,
  groupSkills,
  repoDirName,
  skillAt,
  sshUrl,
} from "./skills.ts";
import {
  formatTimeOfDay,
  installSchedule,
  isRegistered,
  CronExpression,
  EVERY_DAY_AT_MIDNIGHT,
  formatSchedule,
  nextRun,
  pauseSchedule,
  readSchedule,
  type Schedule,
} from "./cron.ts";
import { readLastSync } from "./state.ts";
import { runSync } from "./sync.ts";
import { ARROW, BULLET, label, mark, OK, PAUSED, SEPARATOR, toneFor, type Tone } from "./ui.ts";

const STALE_AFTER_MS = 26 * 60 * 60 * 1000;

const pad = (value: number) => String(value).padStart(2, "0");

const formatDateTime = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
  `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** `owner/repo` is what the pickers show and what people paste, so accept it too. */
const repoOption = option(
  z
    .string()
    .trim()
    .min(1)
    .transform((repo) => (/^[\w.-]+\/[\w.-]+$/.test(repo) ? sshUrl(repo) : repo))
    .optional(),
  { short: "r", description: "Skills repo as owner/name or a git URL" },
);

const skillOption = option(z.array(z.string().trim().min(1)).optional(), {
  short: "s",
  repeatable: true,
  description: "Path to a skill to sync; repeat for more",
});

const cronOption = option(CronExpression.optional(), {
  short: "c",
  description: 'When to sync, as cron — "0 9 * * 1-5"',
});

export const setup = defineCommand({
  name: "setup",
  description: "Pick the skills to sync, the repo to sync them to, and when",
  options: { repo: repoOption, skill: skillOption, cron: cronOption },
  async handler({ flags, prompt, terminal }) {
    const existing = await readSchedule(await loadConfig());
    const { config, schedule } = await configure(prompt, terminal.isInteractive, {
      repo: flags.repo,
      skills: flags.skill && (await Promise.all(flags.skill.map(skillAt))),
      cron: flags.cron,
      // Running setup again is how the configuration is changed, so always ask.
      edit: true,
      schedule: existing ?? undefined,
    });

    await installSchedule(schedule, config);
    prompt.note(
      [
        `${config.skills.map((skill) => skill.name).join(SEPARATOR)}`,
        `${ARROW} ${config.repo} (${config.branch})`,
        announce("Scheduled", schedule),
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
    const existing = await readSchedule(await loadConfig());
    const { config, schedule } = await configure(prompt, terminal.isInteractive, {
      edit: false,
      schedule: existing ?? undefined,
    });

    await installSchedule(schedule, config);
    console.log(mark("ok", announce(existing ? "Resumed" : "Scheduled", schedule)));
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
          ? `${formatSchedule(schedule)}${schedule.paused ? ` ${PAUSED} paused` : ""}`
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

const announce = (verb: string, schedule: Schedule) =>
  `${verb} ${formatSchedule(schedule)} (next run ${formatDateTime(nextRun(schedule))})`;

/**
 * Picks the skills and the repo. `setup` runs this every time, with what is already
 * configured pre-selected, which is how the configuration gets changed; `start` only
 * runs it when there is nothing configured yet. Either way it needs a terminal.
 */
async function configure(
  prompt: PromptApi,
  interactive: boolean,
  {
    repo,
    skills,
    cron,
    edit,
    schedule,
  }: {
    repo?: string;
    skills?: SyncedSkill[];
    cron?: Schedule;
    edit: boolean;
    schedule?: Schedule;
  },
) {
  const config = await loadConfig();
  const configured = config.repo !== undefined && config.skills.length > 0;
  const given = repo !== undefined || skills !== undefined || cron !== undefined;
  if (configured && !edit) return { config, schedule: schedule ?? EVERY_DAY_AT_MIDNIGHT };

  // Answering everything with flags is a complete setup, terminal or not.
  if (repo !== undefined && skills !== undefined && cron !== undefined) {
    return { config: await save(config, { repo, skills }), schedule: cron };
  }

  if (!interactive) {
    // Nothing left to ask on a configured machine, so re-register what it has.
    if (configured && !given) {
      return { config, schedule: schedule ?? EVERY_DAY_AT_MIDNIGHT };
    }

    console.error(
      `${configured ? "changing what is synced" : missingRepoMessage(config.configPath)} needs a ` +
        "terminal — or answer every question at once with --repo, --skill and --cron",
    );
    process.exit(1);
  }

  prompt.intro(`skill-sync ${configured ? "setup · editing" : "setup"}`);
  const chosenSkills = skills ?? (await askForSkills(prompt, config.skills));
  const chosenRepo = repo ?? (await resolveRepo(prompt, config.repo));

  return {
    config: await save(config, { repo: chosenRepo, skills: chosenSkills }),
    schedule: cron ?? (await pickSchedule(prompt, schedule)),
  };
}

async function askForSkills(prompt: PromptApi, current: SyncedSkill[]) {
  const available = await groupSkills(await discoverSkills());
  if (available.length === 0) {
    console.error("no skills found in ~/.claude/skills, ~/.agents/skills, or ~/.codex/skills");
    process.exit(1);
  }

  return await pickSkills(prompt, available, current);
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
