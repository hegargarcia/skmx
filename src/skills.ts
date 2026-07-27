import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { z } from "zod";

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

/** skills.sh records what it installed, and from where, in its lock file. */
const LockSchema = z.object({
  skills: z.record(z.string(), z.object({ source: z.string().optional() }).loose()).default({}),
});

/** The skills already installed from `slug`, which are the ones `update` can refresh. */
export async function installedFrom(slug: string, home = homedir()) {
  const lock = Bun.file(join(home, ".agents", ".skill-lock.json"));
  if (!(await lock.exists())) return [];

  const parsed = LockSchema.safeParse(await lock.json().catch(() => null));
  if (!parsed.success) return [];

  return Object.entries(parsed.data.skills)
    .filter(([, entry]) => entry.source?.toLowerCase() === slug.toLowerCase())
    .map(([name]) => name);
}

/**
 * Hands installation to skills.sh, which is what puts the pushed skills into every
 * agent directory. `update` refreshes what is already installed rather than
 * enrolling new agents, so it will not sprawl directories across the home folder.
 *
 * It exits zero for skills it has never installed, so anything missing from the lock
 * is reported instead: those need one `skills add` to enroll.
 */
export async function triggerInstall(slug: string, names: string[]) {
  const installed = await installedFrom(slug);
  const missing = names.filter((name) => !installed.includes(name));
  const refreshable = names.filter((name) => installed.includes(name));

  if (refreshable.length > 0) {
    const result = await $`${process.execPath} x skills update ${refreshable} --global --yes`
      .nothrow()
      .quiet();

    if (result.exitCode !== 0) {
      const output = `${result.stderr.toString()}${result.stdout.toString()}`.trim();
      return {
        ok: false,
        reason: output.split("\n").at(-1) ?? `exit code ${result.exitCode}`,
      } as const;
    }
  }

  return { ok: true, refreshed: refreshable, missing } as const;
}
