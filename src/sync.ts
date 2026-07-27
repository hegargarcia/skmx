import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import {
  CleanOptions,
  GitResponseError,
  ResetMode,
  simpleGit,
  type MergeResult,
  type SimpleGit,
} from "simple-git";
import { missingRepoMessage, type Config, type SyncedSkill } from "./config.ts";
import { githubSlug, triggerInstall } from "./skills.ts";
import { writeLastSync, type SyncRecord } from "./state.ts";

const DIVERGENT_PATHS_LISTED = 4;

/** Used only when the machine has no git identity of its own. */
const FALLBACK_AUTHOR = ["user.name=skill-sync", "user.email=skill-sync@localhost"];

/** Marks the commit both sides matched at after the last successful sync. */
const BASE_REF = "refs/skill-sync/base";

/**
 * `--checksum` because rsync's default size-and-mtime check calls two same-sized
 * edits within the same second identical, which would drop a skill edit.
 */
const MIRROR = ["--archive", "--checksum"];

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Mirrors the local skills directory into the clone, merges origin, pushes, and
 * mirrors the merged result back. Records the outcome so `status` can report it.
 */
export async function runSync(config: Config) {
  const startedAt = new Date().toISOString();
  const outcome = await performSync(config).catch(
    (error: unknown) =>
      ({
        status: "error",
        summary: describeError(error),
        commit: null,
      }) as const,
  );

  const record: SyncRecord = { startedAt, finishedAt: new Date().toISOString(), ...outcome };
  await mkdir(config.stateDir, { recursive: true });
  await writeLastSync(config.statePath, record);
  return record;
}

async function performSync(config: Config) {
  const { repo, branch, clonePath, skills } = config;
  if (!repo) throw new Error(missingRepoMessage(config.configPath));
  if (skills.length === 0) {
    throw new Error(`no skills selected to sync — run \`skill-sync setup\``);
  }
  for (const skill of skills) {
    if (!(await isDirectory(skill.path))) {
      throw new Error(`${skill.name} is no longer at ${skill.path} — run \`skill-sync setup\``);
    }
  }

  await mkdir(config.stateDir, { recursive: true });
  const git = await openRepo(repo, clonePath);

  // A merge interrupted mid-flight would fail every later run.
  await git.raw(["merge", "--abort"]).catch(() => {});
  await git.fetch("origin");
  const remoteBranch = `origin/${branch}`;
  // A repo that has never been pushed to has no branch to check out or merge from.
  const published = await refExists(git, `refs/remotes/${remoteBranch}`);
  await git.checkout(published ? [branch] : ["-B", branch]);

  const skillsInRepo = join(clonePath, "skills");
  await mkdir(skillsInRepo, { recursive: true });
  const firstRun = !(await refExists(git, BASE_REF));
  if (firstRun) {
    // Nothing has been synced yet, so anything sitting in the clone is leftover from
    // an abandoned run — the remote as it stands is the only trustworthy comparison.
    if (published) await git.reset(ResetMode.HARD, [remoteBranch]);
    await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE);

    // Without a base there is no common ancestor to merge against, so anything the
    // push would overwrite or delete cannot be resolved without losing content.
    const divergent = (
      await Promise.all(
        skills.map((skill) => unreconciled(skill, join(skillsInRepo, skill.name))),
      )
    ).flat();
    if (divergent.length > 0) return diverged(divergent, clonePath);
  }

  for (const skill of skills) {
    const destination = join(skillsInRepo, skill.name);
    await mkdir(destination, { recursive: true });
    // --delete drops files removed from the skill, and stays inside that skill's folder.
    await $`rsync ${MIRROR} --delete ${`${skill.path}/`} ${`${destination}/`}`.quiet();
  }

  const committed = await commitLocalEdits(git);
  const incoming = published ? await countCommits(git, `HEAD..${remoteBranch}`) : 0;
  if (incoming > 0) {
    try {
      await git.merge([remoteBranch, "--no-edit"]);
    } catch (error) {
      return await abortMerge(git, error, clonePath);
    }
  }

  const outgoing = published
    ? await countCommits(git, `${remoteBranch}..HEAD`)
    : (await refExists(git, "HEAD"))
      ? await countCommits(git, "HEAD")
      : 0;
  if (outgoing > 0) await git.push(["--set-upstream", "origin", branch]);

  // Both sides now match this commit, making it the ancestor the next sync merges from.
  await git.raw(["update-ref", BASE_REF, "HEAD"]);
  const head = await git.revparse(["--short", "HEAD"]);

  const changes = [
    committed && "committed local edits",
    incoming > 0 && `merged ${plural(incoming, "commit")} from origin`,
    outgoing > 0 && `pushed ${plural(outgoing, "commit")}`,
  ].filter((change): change is string => change !== false);

  // Installing is skills.sh's job; a push nobody installed has not reached the agents.
  const installed = changes.length > 0 ? await install(repo, skills) : null;
  if (installed?.ok === false) {
    return {
      status: "error",
      summary: `${changes.join(", ")}, but the skills.sh update failed: ${installed.reason}`,
      commit: head,
    } as const;
  }

  if (installed?.refreshed.length) changes.push("triggered the skills.sh update");
  if (installed?.missing.length) {
    changes.push(
      `${installed.missing.join(", ")} not installed yet — run ` +
        `\`bunx skills add ${githubSlug(repo)}\` once`,
    );
  }

  return {
    status: "ok",
    summary: changes.length > 0 ? changes.join(", ") : "already in sync",
    commit: head,
  } as const;
}

/**
 * Skips the trigger for remotes skills.sh cannot install from, which keeps local
 * paths usable as repos.
 */
async function install(repo: string, skills: readonly SyncedSkill[]) {
  const slug = githubSlug(repo);
  if (slug === null) return null;

  return await triggerInstall(
    slug,
    skills.map((skill) => skill.name),
  );
}

/** A failed git command carries its reason on stderr; the message is only an exit code. */
function describeError(error: unknown) {
  if (error instanceof $.ShellError) {
    const stderr = error.stderr.toString().trim();
    if (stderr !== "") return stderr.split("\n").slice(-2).join("; ");
  }

  return error instanceof Error ? error.message : String(error);
}

async function isDirectory(path: string) {
  return await stat(path)
    .then((stats) => stats.isDirectory())
    .catch(() => false);
}

/** Clones on first use, and commits as the user when they have a git identity. */
async function openRepo(repo: string, clonePath: string) {
  if (!(await Bun.file(join(clonePath, ".git", "HEAD")).exists())) {
    await rm(clonePath, { recursive: true, force: true });
    await simpleGit().clone(repo, clonePath);
  }

  const git = simpleGit(clonePath);
  const identity = await git.getConfig("user.email");
  return identity.value ? git : simpleGit(clonePath, { config: FALLBACK_AUTHOR });
}

/** `--quiet` makes a missing ref resolve to an empty string rather than reject. */
async function refExists(git: SimpleGit, ref: string) {
  return await git
    .revparse(["--verify", "--quiet", ref])
    .then((sha) => sha.trim() !== "")
    .catch(() => false);
}

async function commitLocalEdits(git: SimpleGit) {
  const pending = await git.status(["--", "skills"]);
  if (pending.isClean()) return false;

  await git.add(["-A", "--", "skills"]);
  await git.commit("sync local skills");
  return true;
}

async function countCommits(git: SimpleGit, range: string) {
  return Number((await git.raw(["rev-list", "--count", range])).trim());
}

/**
 * rsync itemize lines that mean the file tree actually changed — a transfer,
 * creation, or deletion. A leading `.` is an attribute-only difference such as a
 * timestamp, which says nothing about the contents.
 */
const contentChanges = (itemized: string) =>
  itemized
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("."));

/**
 * What pushing this skill would overwrite or delete in the repo: files that exist on
 * both sides with different contents, and files the repo has that this machine does
 * not. New local files are not listed — adding those loses nothing.
 */
async function unreconciled(skill: SyncedSkill, destination: string) {
  const from = `${skill.path}/`;
  const to = `${destination}/`;
  const [differing, deleting] = await Promise.all([
    $`rsync ${MIRROR} --dry-run --existing --itemize-changes ${from} ${to}`.quiet(),
    $`rsync ${MIRROR} --delete --dry-run --itemize-changes ${from} ${to}`.quiet(),
  ]);

  const overwritten = contentChanges(differing.stdout.toString()).filter((line) =>
    line.startsWith(">f"),
  );
  const removed = deleting.stdout
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("*deleting"));

  return [...overwritten, ...removed].map(
    (line) => `${skill.name}/${line.slice(line.indexOf(" ") + 1).trim()}`,
  );
}

function diverged(paths: string[], clonePath: string) {
  const listed = paths.slice(0, DIVERGENT_PATHS_LISTED).join(", ");
  const rest = paths.length - DIVERGENT_PATHS_LISTED;

  return {
    status: "diverged",
    summary:
      `${listed}${rest > 0 ? ` and ${plural(rest, "other file")}` : ""} differ between this ` +
      `machine and the remote, and there is no previous sync to merge from — reconcile them ` +
      `once (the remote is checked out at ${clonePath}), then sync again`,
    commit: null,
  } as const;
}

/** Leaves local skills untouched — a conflict needs a human, so report and stop. */
async function abortMerge(git: SimpleGit, error: unknown, clonePath: string) {
  const conflicts =
    error instanceof GitResponseError
      ? (error.git as MergeResult).conflicts
          .map((conflict) => conflict.file)
          .filter((file): file is string => file !== null)
      : [];
  await git.raw(["merge", "--abort"]).catch(() => {});

  const detail = conflicts.length > 0 ? `in ${conflicts.join(", ")}` : describeError(error);
  return {
    status: "conflict",
    summary: `merge conflict ${detail} — resolve in ${clonePath}, then run \`skill-sync sync\``,
    commit: null,
  } as const;
}

