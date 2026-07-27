import { mkdir, readdir, rm, stat } from "node:fs/promises";
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
import { missingRepoMessage, type Config } from "./config.ts";
import { writeLastSync, type SyncRecord } from "./state.ts";

const BACKUPS_KEPT = 10;
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
  const { repo, branch, clonePath } = config;
  if (!repo) throw new Error(missingRepoMessage(config.configPath));
  if (!(await isDirectory(config.skillsDir))) {
    throw new Error(`skills directory not found: ${config.skillsDir}`);
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

    // Without a base there is no common ancestor to merge against, so a file that
    // differs in both places cannot be resolved without losing an edit.
    const divergent = await filesDifferingInBoth(config.skillsDir, skillsInRepo);
    if (divergent.length > 0) return diverged(divergent, clonePath);
  }
  const mirrorIn = firstRun
    ? // Keep skills the remote has and this machine does not.
      MIRROR
    : [...MIRROR, "--delete"];
  await $`rsync ${mirrorIn} ${`${config.skillsDir}/`} ${`${skillsInRepo}/`}`.quiet();

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

  const restored = await mirrorToLocal(config, skillsInRepo);

  // Both sides now match this commit, making it the ancestor the next sync merges from.
  await git.raw(["update-ref", BASE_REF, "HEAD"]);
  const head = await git.revparse(["--short", "HEAD"]);

  const changes = [
    committed && "committed local edits",
    incoming > 0 && `merged ${plural(incoming, "commit")} from origin`,
    outgoing > 0 && `pushed ${plural(outgoing, "commit")}`,
    restored > 0 && `updated ${plural(restored, "path")} locally`,
  ].filter((change): change is string => change !== false);

  return {
    status: "ok",
    summary: changes.length > 0 ? changes.join(", ") : "already in sync",
    commit: head,
  } as const;
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

/** Paths that exist on both sides with different contents. */
async function filesDifferingInBoth(skillsDir: string, skillsInRepo: string) {
  const compare =
    await $`rsync ${MIRROR} --dry-run --existing --itemize-changes ${`${skillsDir}/`} ${`${skillsInRepo}/`}`.quiet();

  return contentChanges(compare.stdout.toString())
    .filter((line) => line.startsWith(">f"))
    .map((line) => line.slice(line.indexOf(" ") + 1));
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

async function mirrorToLocal(config: Config, skillsInRepo: string) {
  const paths = [`${skillsInRepo}/`, `${config.skillsDir}/`];
  const preview = await $`rsync ${MIRROR} --delete --dry-run --itemize-changes ${paths}`.quiet();
  const changed = contentChanges(preview.stdout.toString());
  if (changed.length === 0) return 0;

  await backupLocalSkills(config);
  await $`rsync ${MIRROR} --delete ${paths}`.quiet();
  return changed.length;
}

/** Mirroring back can delete local files, so keep a rollback point. */
async function backupLocalSkills(config: Config) {
  await mkdir(config.backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const archive = join(config.backupsDir, `skills-${stamp}.tar.gz`);
  await $`tar -czf ${archive} -C ${config.skillsDir} .`.quiet();

  const archives = (await readdir(config.backupsDir)).filter((name) => name.endsWith(".tar.gz"));
  for (const stale of archives.sort().slice(0, -BACKUPS_KEPT)) {
    await rm(join(config.backupsDir, stale));
  }
}
