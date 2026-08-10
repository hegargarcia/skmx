import { configPaths, saveConfig, type ConfigFile } from "./config.ts";
import { assertPrerequisites, resolveRepo } from "./github.ts";
import { prepareRepo } from "./repository.ts";
import { installSchedule } from "./scheduler.ts";
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
  const repo = await resolveRepo(options.repo);
  await prepareRepo(repo, options.branch, paths.repoDir);
  await validateManagedTree(paths.repoDir);

  const blocked = await preflightTargets(paths.repoDir, paths.agentHome);
  if (blocked.length > 0) {
    const targets = blocked.map((item) => `  - ${item.target}`).join("\n");
    throw new Error(
      `setup found different existing content and did not change any target:\n${targets}\n` +
        "move or reconcile those paths, then run `ss setup` again",
    );
  }

  const file: ConfigFile = {
    repo,
    branch: options.branch,
    intervalMinutes: options.intervalMinutes,
    links: [],
  };
  const config = await saveConfig(file, env);
  const run = await runSync(config, "setup");
  const scheduler = run.status === "ok" ? await installSchedule(config) : null;
  return { config, run, scheduler };
}
