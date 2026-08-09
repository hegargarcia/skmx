import * as p from "@clack/prompts";
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import packageJson from "../package.json" with { type: "json" };
import { loadConfig, updateConfig } from "./config.ts";
import { withLock } from "./lock.ts";
import { readRuns } from "./runs.ts";
import { uninstallSchedule } from "./scheduler.ts";
import { setup } from "./setup.ts";
import { runSync } from "./sync.ts";
import { removeOwnedTargets } from "./targets.ts";

type SetupFlags = { repo?: string; branch: string; interval?: number };

export function createProgram() {
  const program = new Command()
    .name("ss")
    .description("Keep agent skills and global instructions in sync through GitHub")
    .version(packageJson.version)
    .showHelpAfterError();

  program
    .command("setup")
    .description("connect a GitHub repository and enable interval sync")
    .option("-r, --repo <repository>", "GitHub repository (owner/name or clone URL)")
    .option("-b, --branch <branch>", "branch to sync", "main")
    .option("-i, --interval <minutes>", "interval that divides 60 (for example 5, 15, 30, or 60)", parseInterval)
    .action(async (flags: SetupFlags) => {
      p.intro(pc.inverse(" skill-sync setup "));
      const answers = await setupAnswers(flags);
      const progress = p.spinner();
      progress.start("checking GitHub, repository, and target paths");
      try {
        const result = await setup(answers);
        progress.stop(
          result.scheduler
            ? `background sync enabled with ${result.scheduler}`
            : "first sync stopped; background sync was not enabled",
        );
        renderRun(result.run);
        const details = [
          `Repository: ${result.config.repoDir}`,
          `Interval: every ${result.config.intervalMinutes} minutes`,
        ].join("\n");
        if (result.run.status !== "ok") {
          p.note(details, "Setup incomplete");
          process.exitCode = 1;
        } else {
          p.note(details, "Ready");
          p.outro("Your skills are in sync.");
        }
      } catch (error) {
        progress.stop("setup stopped safely");
        throw error;
      }
    });

  program
    .command("sync")
    .description("sync now")
    .action(async () => {
      const run = await runSync(await loadConfig(), "manual");
      renderRun(run);
      if (run.status !== "ok") process.exitCode = 1;
    });

  program
    .command("logs")
    .description("show configuration and recent sync runs")
    .option("-n, --limit <count>", "number of runs to show", parseLimit, 20)
    .action(async ({ limit }: { limit: number }) => {
      const config = await loadConfig();
      const runs = await readRuns(config.runsPath, 100);
      const lastSuccess = runs.find((run) => run.status === "ok");
      const lastProblem = runs.find((run) => run.status !== "ok");
      console.log(`${pc.bold("Repository")}  ${config.repoDir}`);
      console.log(`${pc.bold("Remote")}      ${config.repo}`);
      console.log(`${pc.bold("Interval")}    every ${config.intervalMinutes} minutes`);
      console.log(`${pc.bold("Owned links")} ${config.links.length}`);
      console.log(`${pc.bold("Last success")} ${lastSuccess?.finishedAt ?? "never"}`);
      console.log(
        `${pc.bold("Last problem")} ${lastProblem ? `${lastProblem.finishedAt} (${lastProblem.status})` : "none"}`,
      );
      console.log();
      if (runs.length === 0) {
        console.log(pc.dim("No sync runs have been recorded yet."));
        return;
      }
      for (const run of runs.slice(0, limit)) {
        const state = run.status === "ok" ? pc.green("ok      ") : run.status === "conflict" ? pc.yellow("conflict") : pc.red("error   ");
        console.log(`${run.finishedAt}  ${state}  ${pc.dim(run.trigger.padEnd(9))} ${run.summary}`);
      }
    });

  program
    .command("uninstall")
    .description("remove background sync and owned links; preserve repository and logs")
    .action(async () => {
      const config = await loadConfig();
      const { scheduleRemoved, links } = await withLock(config.lockPath, async () => {
        const scheduleRemoved = await uninstallSchedule(config);
        const links = await removeOwnedTargets(config.repoDir, config.links);
        await updateConfig(config, {
          repo: config.repo,
          branch: config.branch,
          intervalMinutes: config.intervalMinutes,
          links: [],
        });
        return { scheduleRemoved, links };
      });
      p.note(
        [
          `Background job: ${scheduleRemoved ? "removed" : "not installed"}`,
          `Owned links removed: ${links.length}`,
          `Repository preserved: ${config.repoDir}`,
          `Logs preserved: ${config.runsPath}`,
        ].join("\n"),
        "Uninstalled",
      );
    });

  program
    .command("_scheduled", { hidden: true })
    .action(async () => {
      const run = await runSync(await loadConfig(), "scheduled");
      console.log(`${run.finishedAt} ${run.status}: ${run.summary}`);
      if (run.status !== "ok") process.exitCode = 1;
    });

  return program;
}

async function setupAnswers(flags: SetupFlags) {
  if (!flags.repo && !process.stdin.isTTY) {
    throw new Error("non-interactive setup requires `--repo`; optionally pass `--interval` and `--branch`");
  }
  const repo = flags.repo ?? (await p.text({
    message: "Which GitHub repository should be the source of truth?",
    placeholder: "owner/skills",
    validate: (value) => !value?.trim() ? "Enter owner/repository or a clone URL" : undefined,
  }));
  if (p.isCancel(repo)) cancelSetup();

  const interval = flags.interval ?? (!process.stdin.isTTY ? 60 : await p.select({
    message: "How often should skill-sync run?",
    initialValue: 60,
    options: [
      { value: 5, label: "Every 5 minutes" },
      { value: 15, label: "Every 15 minutes" },
      { value: 30, label: "Every 30 minutes" },
      { value: 60, label: "Every hour", hint: "recommended" },
    ],
  }));
  if (p.isCancel(interval)) cancelSetup();
  return { repo: String(repo).trim(), branch: flags.branch, intervalMinutes: Number(interval) };
}

function cancelSetup(): never {
  p.cancel("Setup cancelled.");
  throw new Error("setup cancelled");
}

function renderRun(run: Awaited<ReturnType<typeof runSync>>) {
  const output = `${run.status}: ${run.summary}`;
  if (run.status === "ok") p.log.success(output);
  else if (run.status === "conflict") p.log.warn(output);
  else p.log.error(output);
}

function parseInterval(value: string) {
  const interval = Number(value);
  if (!Number.isInteger(interval) || interval < 1 || interval > 60) {
    throw new InvalidArgumentError("must be a whole number from 1 to 60");
  }
  if (60 % interval !== 0) {
    throw new InvalidArgumentError("must divide evenly into 60 (for example 5, 15, 30, or 60)");
  }
  return interval;
}

function parseLimit(value: string) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new InvalidArgumentError("must be a whole number from 1 to 100");
  }
  return limit;
}
