import { hostname } from "node:os";
import { join } from "node:path";
import { access, readFile, writeFile } from "node:fs/promises";
import { GitResponseError, type MergeResult, type SimpleGit } from "simple-git";
import type { Config } from "./config.ts";
import { updateConfig } from "./config.ts";
import { withLock } from "./lock.ts";
import { prepareRepo, refExists } from "./repository.ts";
import { appendRun, type RunRecord } from "./runs.ts";
import { reconcileTargets } from "./targets.ts";
import { validateManagedTree } from "./validation.ts";

const PUSH_ATTEMPTS = 3;
const UNION_ATTRIBUTE = "skills/**/*.md merge=union";
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];
const MANAGED_PATHS = ["skills", ...INSTRUCTION_FILES, ".gitattributes"];
const MANAGED_CONTENT = ["skills", ...INSTRUCTION_FILES];

export type SyncTrigger = RunRecord["trigger"];
type Outcome = Pick<RunRecord, "status" | "summary" | "commit">;

export async function runSync(config: Config, trigger: SyncTrigger = "manual") {
  const startedAt = new Date().toISOString();
  const outcome = await withLock(config.lockPath, () => performSync(config)).catch(
    (error: unknown): Outcome => ({ status: "error", summary: describeError(error), commit: null }),
  );
  const record: RunRecord = {
    startedAt,
    finishedAt: new Date().toISOString(),
    trigger,
    ...outcome,
  };
  await appendRun(config.runsPath, record);
  return record;
}

async function performSync(config: Config): Promise<Outcome> {
  const git = await prepareRepo(config.repo, config.branch, config.repoDir);
  if (await refExists(git, "MERGE_HEAD")) {
    throw new Error(`a merge is already in progress in ${config.repoDir}; finish or abort it before syncing`);
  }

  await validateManagedTree(config.repoDir);
  await removeUnionAttribute(config.repoDir, git);
  const ignored = await ignoredManagedFiles(git);
  const committed = await commitManagedChanges(git, config.repoDir);

  await git.fetch("origin");
  const remoteBranch = `origin/${config.branch}`;
  const published = await refExists(git, `refs/remotes/${remoteBranch}`);
  const incoming = published ? await countCommits(git, `HEAD..${remoteBranch}`) : 0;
  if (published && incoming > 0) {
    const conflict = await integrateRemote(git, remoteBranch, config.repoDir);
    if (conflict !== null) return conflict;
  }

  const links = await reconcileTargets(config.repoDir, config.agentHome, config.links);
  if (links.blocked.length > 0) {
    return {
      status: "error",
      summary: `setup is blocked by existing content at ${links.blocked.map((item) => item.target).join(", ")}`,
      commit: await currentCommit(git),
    };
  }

  const updated = await updateConfig(
    config,
    {
      repo: config.repo,
      branch: config.branch,
      intervalMinutes: config.intervalMinutes,
      links: links.links,
    },
  );
  config.links = updated.links;

  let outgoing = published ? await countCommits(git, `${remoteBranch}..HEAD`) : await countCommits(git, "HEAD");
  for (let attempt = 1; outgoing > 0; attempt++) {
    try {
      await git.raw(["push", "--set-upstream", "origin", config.branch]);
      break;
    } catch (error) {
      if (attempt >= PUSH_ATTEMPTS) throw error;
      await git.fetch("origin");
      const conflict = await integrateRemote(git, remoteBranch, config.repoDir);
      if (conflict !== null) return conflict;
      outgoing = await countCommits(git, `${remoteBranch}..HEAD`);
    }
  }

  const parts: string[] = [];
  if (committed) parts.push("saved local changes");
  if (incoming > 0) parts.push(`merged ${incoming} remote ${incoming === 1 ? "commit" : "commits"}`);
  if (outgoing > 0) parts.push(`pushed ${outgoing} ${outgoing === 1 ? "commit" : "commits"}`);
  if (links.linked.length > 0) parts.push(`linked ${links.linked.length} targets`);
  if (links.removed.length > 0) parts.push(`removed ${links.removed.length} stale links`);
  if (ignored.length > 0) {
    const preview = ignored.slice(0, 3).join(", ");
    const rest = ignored.length > 3 ? ` and ${ignored.length - 3} more` : "";
    parts.push(`warning: .gitignore excludes ${preview}${rest}`);
  }

  return {
    status: "ok",
    summary: parts.length > 0 ? parts.join(", ") : "already in sync",
    commit: await currentCommit(git),
  };
}

async function removeUnionAttribute(repoDir: string, git: SimpleGit) {
  const path = join(repoDir, ".gitattributes");
  let existing: string;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const next = existing
    .split("\n")
    .filter((line) => line.trim() !== UNION_ATTRIBUTE)
    .join("\n");
  if (next === existing) return;
  await writeFile(path, next, "utf8");
  await git.add(["-A", "--", ".gitattributes"]);
}

async function commitManagedChanges(git: SimpleGit, repoDir: string) {
  await git.add(["-A", "--", "skills"]);
  for (const instruction of INSTRUCTION_FILES) {
    const exists = await access(join(repoDir, instruction)).then(() => true).catch(() => false);
    const tracked = (await git.raw(["ls-files", "--", instruction])).trim() !== "";
    if (exists || tracked) await git.add(["-A", "--", instruction]);
  }
  const staged = (await git.diff(["--cached", "--name-only", "--no-renames", "-z", "--", ...MANAGED_PATHS]))
    .split("\0")
    .filter(Boolean);
  if (staged.length === 0) return false;
  await git.raw([
    "commit",
    "--only",
    "-m",
    `sync: ${hostname()} ${new Date().toISOString()}`,
    "--",
    ...staged,
  ]);
  return true;
}

async function ignoredManagedFiles(git: SimpleGit) {
  const output = await git.raw([
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    ...MANAGED_CONTENT,
  ]);
  return output.split("\n").map((path) => path.trim()).filter(Boolean);
}

async function integrateRemote(git: SimpleGit, remoteBranch: string, repoDir: string) {
  const before = await currentCommit(git);
  try {
    await git.merge([remoteBranch, "--no-edit"]);
  } catch (error) {
    return abortConflict(git, error, repoDir, remoteBranch);
  }

  try {
    await validateManagedTree(repoDir);
  } catch (error) {
    if (before !== null) await git.reset(["--merge", before]);
    return {
      status: "conflict",
      summary: `remote integration produced invalid managed content: ${describeError(error)}`,
      commit: before,
    } as const;
  }
  return null;
}

async function abortConflict(git: SimpleGit, error: unknown, repoDir: string, remoteBranch: string) {
  const conflicts =
    error instanceof GitResponseError
      ? (error.git as MergeResult).conflicts
          .map((conflict) => conflict.file)
          .filter((file): file is string => file !== null)
      : [];
  await git.raw(["merge", "--abort"]).catch(() => {});
  const detail = conflicts.length > 0 ? conflicts.join(", ") : describeError(error);
  return {
    status: "conflict",
    summary:
      `merge conflict in ${detail}; nothing was pushed. Resolve it in ${repoDir} with ` +
      `\`git merge ${remoteBranch}\`, commit the resolution, then run \`skm sync\` again`,
    commit: await currentCommit(git),
  } as const;
}

async function countCommits(git: SimpleGit, range: string) {
  if (!(await refExists(git, "HEAD"))) return 0;
  return Number((await git.raw(["rev-list", "--count", range])).trim());
}

const currentCommit = (git: SimpleGit) =>
  git.revparse(["--short", "HEAD"]).then((sha) => sha.trim()).catch(() => null);

function describeError(error: unknown) {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String(error.stderr).trim();
    if (stderr !== "") return stderr.split("\n").slice(-2).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}
