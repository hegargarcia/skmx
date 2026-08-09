import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { saveConfig } from "../src/config.ts";

export const tempRoots: string[] = [];

export async function tempRoot(prefix = "skill-sync-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

export async function cleanupRoots() {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export async function createRemote() {
  const root = await tempRoot();
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  await git(root, "init", "--bare", "--initial-branch=main", remote);
  await git(root, "clone", remote, seed);
  await mkdir(join(seed, "skills", "writing"), { recursive: true });
  await mkdir(join(seed, "global"), { recursive: true });
  await writeFile(
    join(seed, "skills", "writing", "SKILL.md"),
    "---\nname: writing\ndescription: Write clearly\n---\n\n# Writing\n\nKeep it clear.\n\nKeep it short.\n",
  );
  await writeFile(join(seed, "global", "AGENTS.md"), "# Global agents\n");
  await git(seed, "add", ".");
  await git(seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed");
  await git(seed, "push", "origin", "main");
  return { root, remote, seed };
}

export async function deviceConfig(remote: string, root?: string) {
  const deviceRoot = root ?? await tempRoot();
  const env = {
    ...process.env,
    SKILL_SYNC_HOME: join(deviceRoot, "state"),
    SKILL_SYNC_AGENT_HOME: join(deviceRoot, "agent-home"),
  };
  const config = await saveConfig({ repo: remote, branch: "main", intervalMinutes: 15, links: [] }, env);
  return { root: deviceRoot, env, config };
}

export async function git(cwd: string, ...args: string[]) {
  return execa("git", args, { cwd });
}
