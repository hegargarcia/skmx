import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const DEFAULT_BRANCH = "main";
const DEFAULT_INTERVAL_MINUTES = 60;

const ConfigFileSchema = z
  .object({
    repo: z.string().trim().min(1),
    branch: z.string().trim().min(1).default(DEFAULT_BRANCH),
    intervalMinutes: z
      .number()
      .int()
      .min(1)
      .max(60)
      .refine((minutes) => 60 % minutes === 0, "must divide evenly into one hour")
      .default(DEFAULT_INTERVAL_MINUTES),
    links: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type ConfigFile = z.infer<typeof ConfigFileSchema>;

export type Config = ConfigFile & {
  home: string;
  repoDir: string;
  configPath: string;
  runsPath: string;
  schedulerLogPath: string;
  launchAgentPath: string;
  lockPath: string;
  agentHome: string;
};

export function configPaths(env: NodeJS.ProcessEnv = process.env) {
  const home = resolve(env.SKM_HOME ?? join(homedir(), ".skm"));
  return {
    home,
    repoDir: join(home, "repo"),
    configPath: join(home, "config.json"),
    runsPath: join(home, "runs.jsonl"),
    schedulerLogPath: join(home, "scheduler.log"),
    launchAgentPath: join(homedir(), "Library", "LaunchAgents", "com.skm.sync.plist"),
    lockPath: join(home, "sync.lock"),
    agentHome: resolve(env.SKM_AGENT_HOME ?? homedir()),
  };
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const paths = configPaths(env);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(paths.configPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`skm is not configured — run \`skm setup\``);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`${paths.configPath} is not valid JSON`);
    }
    throw error;
  }

  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${paths.configPath}: ${z.prettifyError(parsed.error)}`);
  return { ...parsed.data, ...paths };
}

export async function saveConfig(file: ConfigFile, env: NodeJS.ProcessEnv = process.env) {
  const paths = configPaths(env);
  const parsed = ConfigFileSchema.parse(file);
  await mkdir(dirname(paths.configPath), { recursive: true });
  await writeFile(paths.configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return { ...parsed, ...paths } satisfies Config;
}

export async function updateConfig(config: Config, file: ConfigFile) {
  const parsed = ConfigFileSchema.parse(file);
  await mkdir(dirname(config.configPath), { recursive: true });
  await writeFile(config.configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return { ...config, ...parsed } satisfies Config;
}

export const defaultConfig = (repo: string): ConfigFile => ({
  repo,
  branch: DEFAULT_BRANCH,
  intervalMinutes: DEFAULT_INTERVAL_MINUTES,
  links: [],
});
