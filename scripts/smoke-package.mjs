import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import packageJson from "../package.json" with { type: "json" };

const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "skill-sync-package-"));

try {
  const packed = await run("npm", ["pack", "--ignore-scripts", "--pack-destination", root]);
  const filename = packed.stdout.trim().split("\n").at(-1);
  if (!filename) throw new Error("npm pack did not return a tarball name");
  const tarball = join(root, filename);
  const npx = await run("npx", ["--yes", "--package", tarball, "skill-sync", "--version"]);
  if (npx.stdout.trim() !== packageJson.version) throw new Error(`unexpected npx version: ${npx.stdout}`);

  const prefix = join(root, "global");
  await run("npm", ["install", "--global", "--prefix", prefix, tarball]);
  for (const command of ["ss", "skill-sync"]) {
    const result = await run(join(prefix, "bin", command), ["--version"]);
    if (result.stdout.trim() !== packageJson.version) {
      throw new Error(`unexpected ${command} version: ${result.stdout}`);
    }
  }

  const remote = await seedRepository(root);
  const npxEnvironment = await scheduledEnvironment(root, "npx-device", remote);
  const npxRun = await run(
    "npx",
    ["--yes", "--package", tarball, "skill-sync", "_scheduled"],
    { env: npxEnvironment },
  );
  if (!npxRun.stdout.includes(" ok:")) throw new Error(`npx scheduled run failed: ${npxRun.stdout}`);

  const globalEnvironment = await scheduledEnvironment(root, "global-device", remote);
  const globalRun = await run(join(prefix, "bin", "ss"), ["_scheduled"], {
    env: globalEnvironment,
  });
  if (!globalRun.stdout.includes(" ok:")) {
    throw new Error(`global scheduled run failed: ${globalRun.stdout}`);
  }

  console.log("package and non-interactive sync work through npx and global installation");
} finally {
  await rm(root, { recursive: true, force: true });
}

async function seedRepository(root) {
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  await run("git", ["init", "--bare", "--initial-branch=main", remote]);
  await run("git", ["clone", remote, seed]);
  await mkdir(join(seed, "skills", "smoke"), { recursive: true });
  await writeFile(join(seed, "skills", "smoke", "SKILL.md"), "---\nname: smoke\n---\n# Smoke\n");
  await run("git", ["add", "."], { cwd: seed });
  await run(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed"],
    { cwd: seed },
  );
  await run("git", ["push", "origin", "main"], { cwd: seed });
  return remote;
}

async function scheduledEnvironment(root, name, remote) {
  const state = join(root, name, "state");
  await mkdir(state, { recursive: true });
  await writeFile(
    join(state, "config.json"),
    `${JSON.stringify({ repo: remote, branch: "main", intervalMinutes: 15, links: [] }, null, 2)}\n`,
  );
  return {
    ...process.env,
    NO_COLOR: "1",
    SKILL_SYNC_HOME: state,
    SKILL_SYNC_AGENT_HOME: join(root, name, "agent-home"),
  };
}
