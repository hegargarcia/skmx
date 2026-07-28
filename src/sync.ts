import { mkdir, realpath, rm, stat } from "node:fs/promises";
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
import { fingerprint, linkSkills, repoDirName } from "./skills.ts";
import { writeLastSync, type SyncRecord } from "./state.ts";

const DIVERGENT_PATHS_LISTED = 4;

/** How many times a push may lose a race before the sync gives up. */
const PUSH_ATTEMPTS = 3;

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
  const { repo, branch, skills } = config;
  if (!repo) throw new Error(missingRepoMessage(config.configPath));
  const clonePath = join(config.reposDir, repoDirName(repo));
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
  if (!(await refExists(git, BASE_REF))) {
    // Nothing has been synced yet, so anything sitting in the clone is leftover from
    // an abandoned run — the remote as it stands is the only trustworthy comparison.
    if (published) await git.reset(ResetMode.HARD, [remoteBranch]);
    await git.clean(CleanOptions.FORCE + CleanOptions.RECURSIVE);
  }

  // Decide everything before copying anything, so one unreconciled skill cannot
  // leave the others half imported.
  const plans = await Promise.all(
    skills.map((skill) => planFor(skill, join(skillsInRepo, skill.name))),
  );
  const divergent = plans.flatMap((plan) => plan.unreconciled);
  if (divergent.length > 0) return diverged(divergent, clonePath);

  for (const plan of plans.filter((plan) => plan.bootstrap)) {
    await mkdir(plan.destination, { recursive: true });
    await $`rsync ${MIRROR} --delete ${`${plan.skill.path}/`} ${`${plan.destination}/`}`.quiet();
  }

  const committed = await commitLocalEdits(git);
  let incoming = published ? await countCommits(git, `HEAD..${remoteBranch}`) : 0;
  if (incoming > 0) {
    const conflict = await mergeRemote(git, remoteBranch, clonePath);
    if (conflict !== null) return conflict;
  }

  let outgoing = await countOutgoing(git, published, remoteBranch);
  for (let attempt = 0; outgoing > 0; attempt++) {
    const pushed = await git.push(["--set-upstream", "origin", branch]).then(
      () => true,
      () => false,
    );
    if (pushed) break;

    // Another machine pushed in the meantime. Take its work and try again, rather
    // than failing and leaving this machine an hour behind.
    if (attempt >= PUSH_ATTEMPTS) throw new Error(`could not push to ${branch} after ${attempt + 1} tries`);
    await git.fetch("origin");
    const arrived = await countCommits(git, `HEAD..${remoteBranch}`);
    if (arrived > 0) {
      const conflict = await mergeRemote(git, remoteBranch, clonePath);
      if (conflict !== null) return conflict;
      incoming += arrived;
    }
    outgoing = await countOutgoing(git, true, remoteBranch);
  }

  // Both sides now match this commit, making it the ancestor the next sync merges from.
  await git.raw(["update-ref", BASE_REF, "HEAD"]);
  const head = await git.revparse(["--short", "HEAD"]);

  const changes = [
    committed && "committed local edits",
    incoming > 0 && `merged ${plural(incoming, "commit")} from origin`,
    outgoing > 0 && `pushed ${plural(outgoing, "commit")}`,
  ].filter((change): change is string => change !== false);

  // Every agent reads the clone, so linking is what actually installs the skills.
  const { linked, blocked } = await linkSkills(
    clonePath,
    skills.map((skill) => skill.name),
    config.agentHome,
  );
  if (linked.length > 0) changes.push(`linked ${plural(linked.length, "skill")} for the agents`);
  if (blocked.length > 0) {
    const paths = blocked.map((outcome) => outcome.path).join(", ");
    changes.push(`left alone, holding content that was never pushed: ${paths}`);
  }

  return {
    status: "ok",
    summary: changes.length > 0 ? changes.join(", ") : "already in sync",
    commit: head,
  } as const;
}

/** Two paths that lead to the same directory, once links are resolved. */
async function sameDirectory(one: string, other: string) {
  const [first, second] = await Promise.all([
    realpath(one).catch(() => one),
    realpath(other).catch(() => other),
  ]);
  return first === second;
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

const countOutgoing = async (git: SimpleGit, published: boolean, remoteBranch: string) =>
  published
    ? await countCommits(git, `${remoteBranch}..HEAD`)
    : (await refExists(git, "HEAD"))
      ? await countCommits(git, "HEAD")
      : 0;

/** Returns a conflict record when the merge could not be completed, else null. */
async function mergeRemote(git: SimpleGit, remoteBranch: string, clonePath: string) {
  try {
    await git.merge([remoteBranch, "--no-edit"]);
    return null;
  } catch (error) {
    return await abortMerge(git, error, clonePath, remoteBranch);
  }
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
 * How a skill gets into the clone. The clone is the source of truth once the skill is
 * in it — every agent reads it through a link, so edits land there directly. The
 * configured path only says where to import from the first time.
 *
 * A separate directory that still differs from the clone is the one case that cannot
 * be decided here: either side may hold the edit worth keeping, so it is reported.
 */
async function planFor(skill: SyncedSkill, destination: string) {
  const plan = { skill, destination, bootstrap: false, unreconciled: [] as string[] };

  if (await sameDirectory(skill.path, destination)) return plan;
  if (!(await isDirectory(destination))) return { ...plan, bootstrap: true };
  if ((await fingerprint(skill.path)) === (await fingerprint(destination))) return plan;

  return { ...plan, unreconciled: await differences(skill, destination) };
}

/**
 * What pushing this skill would overwrite or delete in the repo: files that exist on
 * both sides with different contents, and files the repo has that this machine does
 * not. New local files are not listed — adding those loses nothing.
 */
async function differences(skill: SyncedSkill, destination: string) {
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
      `machine and the repo, and either side may hold the edit worth keeping — reconcile ` +
      `them once (the repo is checked out at ${clonePath}), then sync again`,
    commit: null,
  } as const;
}

/**
 * Leaves local skills untouched — a conflict needs a human, so report and stop. The
 * merge is aborted rather than left in place because every agent reads this clone
 * through a link, and none of them should find conflict markers in a skill.
 *
 * That also means the working tree is clean afterwards, so the way out is to perform
 * the merge again by hand. The summary spells that out: editing the file and
 * committing it is not enough, and leaves the sync conflicted on every later run.
 */
async function abortMerge(
  git: SimpleGit,
  error: unknown,
  clonePath: string,
  remoteBranch: string,
) {
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
    summary:
      `merge conflict ${detail} — another machine changed the same lines. To settle it: ` +
      `cd ${clonePath} && git merge ${remoteBranch}, fix the marked files, ` +
      "then git add -A && git commit",
    commit: null,
  } as const;
}

