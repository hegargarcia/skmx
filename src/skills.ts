import { lstat, mkdir, readdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Where the agents this machine runs keep their skills, relative to the home directory. */
const AGENT_SKILL_DIRS = [".claude/skills", ".agents/skills", ".codex/skills"];

export type DiscoveredSkill = {
  name: string;
  path: string;
  /** The agent directory it was found in, e.g. `.claude/skills`. */
  source: string;
};

/** One skill, and every copy of it this machine holds. */
export type SkillGroup = {
  name: string;
  copies: DiscoveredSkill[];
  /** Whether every copy holds the same files, byte for byte. */
  identical: boolean;
};

/** The agent a skill directory belongs to: `.claude/skills` reads as `claude`. */
export const agentName = (source: string) => source.split("/")[0]?.replace(/^\./, "") ?? source;

/**
 * A checksum of a skill folder's contents — every file path and its bytes — so copies
 * of one skill can be compared without caring about timestamps.
 */
export async function fingerprint(path: string) {
  const entries = await readdir(path, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();

  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of files) {
    hasher.update(file.slice(path.length));
    hasher.update(await Bun.file(file).arrayBuffer());
  }

  return hasher.digest("hex");
}

/**
 * Collapses the copies of each skill into one entry, so a skill kept in both
 * `.claude` and `.agents` is offered once rather than twice.
 */
export async function groupSkills(discovered: DiscoveredSkill[]) {
  const fingerprints = new Map(
    await Promise.all(
      discovered.map(async (skill) => [skill.path, await fingerprint(skill.path)] as const),
    ),
  );

  const groups = new Map<string, SkillGroup>();
  for (const skill of discovered) {
    const group = groups.get(skill.name);
    if (group === undefined) {
      groups.set(skill.name, { name: skill.name, copies: [skill], identical: true });
      continue;
    }

    group.copies.push(skill);
    group.identical &&= fingerprints.get(skill.path) === fingerprints.get(group.copies[0]!.path);
  }

  return [...groups.values()];
}

/** Every directory holding a SKILL.md across the agent directories. */
export async function discoverSkills(home = homedir()) {
  const found: DiscoveredSkill[] = [];

  for (const source of AGENT_SKILL_DIRS) {
    const directory = join(home, source);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const path = join(directory, entry.name);
      if (await Bun.file(join(path, "SKILL.md")).exists()) {
        found.push({ name: entry.name, path, source });
      }
    }
  }

  return found;
}

/**
 * The `owner/repo` skills.sh installs from. Null for remotes it cannot serve,
 * such as the local paths the tests use.
 */
export function githubSlug(repo: string) {
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/.exec(
    repo,
  );
  return match?.[1] ?? (/^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null);
}

export const sshUrl = (slug: string) => `git@github.com:${slug}.git`;

/**
 * Turns a path given on the command line into a skill to sync. Requires a SKILL.md,
 * so a mistyped path fails here rather than pushing an empty folder.
 */
export async function skillAt(path: string) {
  const resolved = resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
  if (!(await Bun.file(join(resolved, "SKILL.md")).exists())) {
    throw new Error(`no SKILL.md in ${resolved}`);
  }

  return { name: basename(resolved), path: resolved };
}

/** Where the clone of `repo` lives under the repos directory. */
export const repoDirName = (repo: string) =>
  githubSlug(repo) ?? (basename(repo).replace(/\.git$/, "") || "repo");

export type LinkOutcome = { skill: string; agent: string; path: string };

/**
 * Points every agent directory at the clone, so all of them read the same files and
 * an edit through any one of them is an edit to the repo.
 *
 * A directory that is not a link is only replaced when it already holds exactly what
 * the clone holds — otherwise it has content that was never pushed, and replacing it
 * would throw that away, so it is reported instead.
 */
export async function linkSkills(clonePath: string, names: string[], home = homedir()) {
  const linked: LinkOutcome[] = [];
  const blocked: LinkOutcome[] = [];

  for (const source of AGENT_SKILL_DIRS) {
    for (const name of names) {
      const target = join(home, source, name);
      const from = join(clonePath, "skills", name);
      const outcome = { skill: name, agent: agentName(source), path: target };

      if (await alreadyLinked(target, from)) continue;
      if (!(await replaceable(target, from))) {
        blocked.push(outcome);
        continue;
      }

      await mkdir(dirname(target), { recursive: true });
      await rm(target, { recursive: true, force: true });
      await symlink(from, target);
      linked.push(outcome);
    }
  }

  return { linked, blocked };
}

const alreadyLinked = (target: string, from: string) =>
  readlink(target)
    .then((destination) => destination === from)
    .catch(() => false);

/** True when nothing of value sits at `target`, or it is already a link, or a copy. */
async function replaceable(target: string, from: string) {
  const existing = await lstat(target).catch(() => null);
  if (existing === null) return true;
  if (existing.isSymbolicLink()) return true;
  if (!existing.isDirectory()) return false;

  return (await fingerprint(target)) === (await fingerprint(from));
}
