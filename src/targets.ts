import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SKILL_TARGETS = [".claude/skills", ".agents/skills", ".codex/skills"];
const GLOBAL_TARGETS = [
  { source: "AGENTS.md", targets: [".agents/AGENTS.md", ".codex/AGENTS.md"] },
  { source: "CLAUDE.md", targets: [".claude/CLAUDE.md"] },
] as const;

type LinkPlan = { source: string; target: string; replace: boolean };
export type LinkConflict = { source: string; target: string };

export async function reconcileTargets(
  repoDir: string,
  agentHome: string,
  previouslyOwned: string[] = [],
) {
  const desired = await desiredLinks(repoDir, agentHome);
  const plans: LinkPlan[] = [];
  const blocked: LinkConflict[] = [];

  for (const link of desired) {
    const state = await inspectTarget(link.source, link.target);
    if (state === "ready") plans.push({ ...link, replace: false });
    if (state === "same") plans.push({ ...link, replace: true });
    if (state === "blocked") blocked.push(link);
  }
  if (blocked.length > 0) return { links: previouslyOwned, linked: [], removed: [], blocked };

  const desiredTargets = new Set(desired.map((link) => link.target));
  const removed: string[] = [];
  for (const target of previouslyOwned.filter((path) => !desiredTargets.has(path))) {
    if (await pointsInto(target, repoDir)) {
      await rm(target, { force: true });
      removed.push(target);
    }
  }

  const linked: string[] = [];
  for (const plan of plans) {
    await mkdir(dirname(plan.target), { recursive: true });
    if (plan.replace) await rm(plan.target, { recursive: true, force: true });
    await symlink(plan.source, plan.target, (await lstat(plan.source)).isDirectory() ? "dir" : "file");
    linked.push(plan.target);
  }

  return { links: desired.map((link) => link.target), linked, removed, blocked: [] };
}

export async function preflightTargets(repoDir: string, agentHome: string) {
  const blocked: LinkConflict[] = [];
  for (const link of await desiredLinks(repoDir, agentHome)) {
    if ((await inspectTarget(link.source, link.target)) === "blocked") blocked.push(link);
  }
  return blocked;
}

export async function removeOwnedTargets(repoDir: string, links: string[]) {
  const removed: string[] = [];
  for (const target of links) {
    if (await pointsInto(target, repoDir)) {
      await rm(target, { force: true });
      removed.push(target);
    }
  }
  return removed;
}

async function desiredLinks(repoDir: string, agentHome: string) {
  const links: Array<{ source: string; target: string }> = [];
  const skillsDir = join(repoDir, "skills");
  const skills = await readdir(skillsDir, { withFileTypes: true });
  for (const skill of skills.filter((entry) => entry.isDirectory())) {
    for (const targetDir of SKILL_TARGETS) {
      links.push({ source: join(skillsDir, skill.name), target: join(agentHome, targetDir, skill.name) });
    }
  }

  for (const mapping of GLOBAL_TARGETS) {
    const source = join(repoDir, "global", mapping.source);
    if (!(await exists(source))) continue;
    for (const target of mapping.targets) links.push({ source, target: join(agentHome, target) });
  }
  return links;
}

async function inspectTarget(source: string, target: string) {
  const targetInfo = await lstat(target).catch(() => null);
  if (targetInfo === null) return "ready" as const;
  if (targetInfo.isSymbolicLink()) {
    const link = await readlink(target);
    const [actual, expected] = await Promise.all([
      realpath(target).catch(() => resolve(dirname(target), link)),
      realpath(source),
    ]);
    return actual === expected ? ("linked" as const) : ("blocked" as const);
  }
  return (await fingerprint(source)) === (await fingerprint(target))
    ? ("same" as const)
    : ("blocked" as const);
}

async function fingerprint(path: string) {
  const info = await lstat(path);
  const hash = createHash("sha256");
  if (info.isFile()) {
    hashFields(hash, "file", String(info.mode & 0o111), await readFile(path));
    return hash.digest("hex");
  }
  if (!info.isDirectory()) {
    if (info.isSymbolicLink()) hashFields(hash, "link", await readlink(path));
    else hashFields(hash, "special");
    return hash.digest("hex");
  }

  hashFields(hash, "directory");
  await fingerprintDirectory(path, path, hash);
  return hash.digest("hex");
}

async function fingerprintDirectory(root: string, directory: string, hash: ReturnType<typeof createHash>) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((one, two) => one.name.localeCompare(two.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const name = relative(root, path);
    if (entry.isDirectory()) {
      hashFields(hash, "directory", name);
      await fingerprintDirectory(root, path, hash);
    } else if (entry.isFile()) {
      const info = await lstat(path);
      hashFields(hash, "file", String(info.mode & 0o111), name, await readFile(path));
    } else if (entry.isSymbolicLink()) {
      hashFields(hash, "link", name, await readlink(path));
    } else {
      hashFields(hash, "special", name);
    }
  }
}

function hashFields(hash: ReturnType<typeof createHash>, ...fields: Array<string | Buffer>) {
  for (const field of fields) {
    const contents = typeof field === "string" ? Buffer.from(field) : field;
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(contents.length));
    hash.update(length);
    hash.update(contents);
  }
}

async function pointsInto(target: string, repoDir: string) {
  const info = await lstat(target).catch(() => null);
  if (!info?.isSymbolicLink()) return false;
  const link = await readlink(target);
  const destination = await realpath(target).catch(() => resolve(dirname(target), link));
  const canonicalRepo = await realpath(repoDir).catch(() => resolve(repoDir));
  const path = relative(canonicalRepo, destination);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

const exists = (path: string) => lstat(path).then(() => true).catch(() => false);
