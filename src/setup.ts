import { access } from "node:fs/promises";
import { configPaths, loadConfig, saveConfig, type ConfigFile } from "./config.ts";
import { assertPrerequisites, resolveRepo } from "./github.ts";
import { prepareRepo } from "./repository.ts";
import { installSchedule, uninstallSchedule } from "./scheduler.ts";
import { runSync } from "./sync.ts";
import { preflightTargets } from "./targets.ts";
import { validateManagedTree } from "./validation.ts";

export type SetupOptions = {
  repo: string;
  branch: string;
  intervalMinutes: number;
};

export async function setup(options: SetupOptions, env: NodeJS.ProcessEnv = process.env) {
  await assertPrerequisites();
  const paths = configPaths(env);
  const existing = await access(paths.configPath).then(() => loadConfig(env)).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  const repo = await resolveRepo(options.repo);
  await prepareRepo(repo, options.branch, paths.repoDir);
  await validateManagedTree(paths.repoDir);

  const blocked = await preflightTargets(paths.repoDir, paths.agentHome, existing?.links ?? []);
  if (blocked.length > 0) {
    const targets = blocked.map((item) => `  - ${item.target}`).join("\n");
    throw new Error(
      `setup found different existing content and did not change any target:\n${targets}\n` +
        "move or reconcile those paths, then run `skm setup` again",
    );
  }

  const file: ConfigFile = {
    repo,
    branch: options.branch,
    intervalMinutes: options.intervalMinutes,
    links: existing?.links ?? [],
  };
  const config = await saveConfig(file, env);
  const run = await runSync(config, "setup");
  if (run.status !== "ok") {
    await uninstallSchedule(config);
    return { config, run, scheduler: null };
  }
  const scheduler = await installSchedule(config);
  return { config, run, scheduler };
}
