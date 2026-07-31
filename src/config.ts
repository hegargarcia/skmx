import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const DEFAULT_BRANCH = "main";

const expandHome = (path: string) =>
  path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

const EnvSchema = z.object({
  SKILL_SYNC_HOME: z.string().trim().min(1).optional(),
  SKILL_SYNC_REPO: z.string().trim().min(1).optional(),
  SKILL_SYNC_BRANCH: z.string().trim().min(1).optional(),
  XDG_CONFIG_HOME: z.string().trim().min(1).optional(),
  XDG_STATE_HOME: z.string().trim().min(1).optional(),
});

/** One skill to sync, and where this machine keeps it. */
const SyncedSkillSchema = z.object({
  name: z.string().trim().min(1),
  path: z.string().trim().min(1).transform(expandHome),
});

export type SyncedSkill = z.output<typeof SyncedSkillSchema>;

/** Shape of `config.json`; unknown keys are rejected so typos do not pass silently. */
const FileSchema = z
  .object({
    repo: z.string().trim().min(1).optional(),
    branch: z.string().trim().min(1).optional(),
    skills: z.array(SyncedSkillSchema).optional(),
    checkout: z.string().trim().min(1).transform(expandHome).optional(),
  })
  .strict();

/** Environment variables win over `config.json`, which wins over the defaults. */
export async function loadConfig() {
  const env = EnvSchema.parse(Bun.env);
  const home = expandHome(
    env.SKILL_SYNC_HOME ??
      join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "skill-sync"),
  );
  const configPath = join(home, "config.json");
  const file = await readConfigFile(configPath);

  const stateDir = join(
    env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "skill-sync",
  );

  return {
    repo: env.SKILL_SYNC_REPO ?? file.repo,
    branch: env.SKILL_SYNC_BRANCH ?? file.branch ?? DEFAULT_BRANCH,
    skills: file.skills ?? [],
    configPath,
    /**
     * A checkout of the repo you already keep and work in. Set it and skill-sync uses
     * that instead of cloning its own, which stops two clones of one repo competing
     * for the same agent directories.
     */
    checkout: file.checkout,
    /** Where skill-sync puts its own clone when `checkout` is not set. */
    reposDir: join(home, "repos"),
    /** The home directory holding the agent directories that get linked. */
    agentHome: homedir(),
    stateDir,
    statePath: join(stateDir, "state.json"),
    schedulePath: join(stateDir, "schedule.json"),
    cronLogPath: join(stateDir, "cron.log"),
  } as const;
}

export type Config = Awaited<ReturnType<typeof loadConfig>>;

/** Tells the user where to put the setting they are missing. */
export const missingRepoMessage = (configPath: string) =>
  `no skills repo configured — set "repo" in ${configPath} (or SKILL_SYNC_REPO)`;

async function readConfigFile(configPath: string) {
  const file = Bun.file(configPath);
  if (!(await file.exists())) return {};

  const contents = await file.json().catch(() => {
    throw new Error(`${configPath} is not valid JSON`);
  });

  const parsed = FileSchema.safeParse(contents);
  if (!parsed.success) throw new Error(`${configPath}: ${z.prettifyError(parsed.error)}`);

  return parsed.data;
}
