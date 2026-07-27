import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const DEFAULT_SKILLS_DIR = "~/.claude/skills";
const DEFAULT_BRANCH = "main";

const expandHome = (path: string) =>
  path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

const EnvSchema = z.object({
  SKILL_SYNC_HOME: z.string().trim().min(1).optional(),
  SKILL_SYNC_REPO: z.string().trim().min(1).optional(),
  SKILL_SYNC_SKILLS_DIR: z.string().trim().min(1).optional(),
  SKILL_SYNC_BRANCH: z.string().trim().min(1).optional(),
  XDG_STATE_HOME: z.string().trim().min(1).optional(),
});

/** Shape of `config.json`; unknown keys are rejected so typos do not pass silently. */
const FileSchema = z
  .object({
    repo: z.string().trim().min(1).optional(),
    skillsDir: z.string().trim().min(1).optional(),
    branch: z.string().trim().min(1).optional(),
  })
  .strict();

/** Environment variables win over `config.json`, which wins over the defaults. */
export async function loadConfig() {
  const env = EnvSchema.parse(Bun.env);
  const home = expandHome(env.SKILL_SYNC_HOME ?? join(homedir(), ".skill-sync"));
  const configPath = join(home, "config.json");
  const file = await readConfigFile(configPath);

  const stateDir = join(
    env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "skill-sync",
  );

  return {
    repo: env.SKILL_SYNC_REPO ?? file.repo,
    branch: env.SKILL_SYNC_BRANCH ?? file.branch ?? DEFAULT_BRANCH,
    skillsDir: expandHome(env.SKILL_SYNC_SKILLS_DIR ?? file.skillsDir ?? DEFAULT_SKILLS_DIR),
    configPath,
    stateDir,
    clonePath: join(stateDir, "repo"),
    statePath: join(stateDir, "state.json"),
    schedulePath: join(stateDir, "schedule.json"),
    backupsDir: join(stateDir, "backups"),
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
