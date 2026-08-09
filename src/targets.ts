import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SKILL_TARGETS = [".claude/skills", ".agents/skills", ".codex/skills"];
type TargetState = "ready" | "linked" | "same-link" | "same-path" | "blocked";
type LinkPlan = { source: string; target: string; replacement: "none" | "link" | "path" };
export type LinkConflict = { source: string; target: string };

export async function reconcileTargets(
  repoDir: string,
  agentHome: string,
  previouslyOwned: string[] = [],
) {
  const desired = await desiredLinks(repoDir, agentHome);
  const ownedTargets = new Set(previouslyOwned);
  const plans: LinkPlan[] = [];
  const blocked: LinkConflict[] = [];

  for (const link of desired) {
    const owned = ownedTargets.has(link.target) && await pointsInto(link.target, repoDir);
    const state = await inspectTarget(link.source, link.target, owned);
    if (state === "ready") plans.push({ ...link, replacement: "none" });
    if (state === "same-link") plans.push({ ...link, replacement: "link" });
    if (state === "same-path") plans.push({ ...link, replacement: "path" });
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
    if (plan.replacement === "link") await replaceLink(plan.source, plan.target);
    else {
      if (plan.replacement === "path") await rm(plan.target, { recursive: true, force: true });
      await createLink(plan.source, plan.target);
    }
    linked.push(plan.target);
  }

  return { links: desired.map((link) => link.target), linked, removed, blocked: [] };
}

export async function preflightTargets(repoDir: string, agentHome: string, previouslyOwned: string[] = []) {
  const ownedTargets = new Set(previouslyOwned);
  const blocked: LinkConflict[] = [];
  for (const link of await desiredLinks(repoDir, agentHome)) {
    const owned = ownedTargets.has(link.target) && await pointsInto(link.target, repoDir);
    if ((await inspectTarget(link.source, link.target, owned)) === "blocked") blocked.push(link);
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

  const agents = join(repoDir, "AGENTS.md");
  const claude = join(repoDir, "CLAUDE.md");
  if (await exists(agents)) {
    links.push({ source: agents, target: join(agentHome, ".agents/AGENTS.md") });
    links.push({ source: agents, target: join(agentHome, ".codex/AGENTS.md") });
  }
  if (await exists(claude)) {
    links.push({ source: claude, target: join(agentHome, ".claude/CLAUDE.md") });
  } else if (await exists(agents)) {
    links.push({ source: agents, target: join(agentHome, ".claude/CLAUDE.md") });
  }
  return links;
}

async function inspectTarget(source: string, target: string, owned = false): Promise<TargetState> {
  const targetInfo = await lstat(target).catch(() => null);
  if (targetInfo === null) return "ready";
  if (targetInfo.isSymbolicLink()) {
    const [actual, expected] = await Promise.all([
      realpath(target).catch(() => null),
      realpath(source),
    ]);
    if (actual === null) return owned ? "same-link" : "blocked";
    if (actual === expected) return "linked";
    if (owned) return "same-link";
    return (await fingerprint(actual)) === (await fingerprint(expected)) ? "same-link" : "blocked";
  }
  return (await fingerprint(source)) === (await fingerprint(target))
    ? "same-path"
    : "blocked";
}

async function createLink(source: string, target: string) {
  await symlink(source, target, (await lstat(source)).isDirectory() ? "dir" : "file");
}

async function replaceLink(source: string, target: string) {
  const temporary = join(dirname(target), `.${basename(target)}.skill-sync-${randomUUID()}`);
  await createLink(source, temporary);
  try {
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
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
  const destination = await resolveLinkDestination(target);
  if (destination === null) return false;
  const canonicalRepo = await realpath(repoDir).catch(() => resolve(repoDir));
  const path = relative(canonicalRepo, destination);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function resolveLinkDestination(target: string) {
  const link = await readlink(target);
  const destination = resolve(dirname(target), link);
  return realpath(target).catch(async () => {
    let existingPath = destination;
    const missingSegments: string[] = [];

    while (true) {
      const canonicalPath = await realpath(existingPath).catch(() => null);
      if (canonicalPath !== null) return join(canonicalPath, ...missingSegments.reverse());

      const pathState = await lstat(existingPath)
        .then(() => "exists" as const)
        .catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "missing" as const : "unknown" as const);
      if (pathState !== "missing") return null;

      const parent = dirname(existingPath);
      if (parent === existingPath) return null;
      missingSegments.push(basename(existingPath));
      existingPath = parent;
    }
  });
}

const exists = (path: string) => lstat(path).then(() => true).catch(() => false);
